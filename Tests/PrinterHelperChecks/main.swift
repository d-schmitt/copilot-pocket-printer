import AppKit
import Darwin
import Foundation
import PrinterCLIKit
import PrinterHelperKit

enum CheckError: Error { case assertion(String) }
@MainActor private var assertionCount = 0
@MainActor func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    assertionCount += 1
    if try !condition() { throw CheckError.assertion(message) }
}

@main
struct HelperChecks {
    @MainActor static func main() async {
        do {
            if CommandLine.arguments.count >= 3, CommandLine.arguments[1] == "--fixture" {
                try await fixture()
            } else {
                try await checks()
            }
        } catch {
            FileHandle.standardError.write(Data("FAIL helper checks: \(error)\n".utf8))
            exit(1)
        }
    }

    static func request(_ method: String, _ fields: [String: Any] = [:]) throws -> Data {
        var object = fields
        object["version"] = 1
        object["request_id"] = UUID().uuidString
        object["method"] = method
        return try JSONSerialization.data(withJSONObject: object)
    }

    @MainActor static func fixture() async throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[2])
        let mode = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : "ready"
        let store = try ReceiptStore(directory: root.appendingPathComponent("receipts"))
        var calls = 0
        let service = try HelperService(store: store, bluetooth: { ["wrong-peer", "ai-client"].contains(mode) ? "ready" : mode }) { _, _ in
            calls += 1
            try await Task.sleep(nanoseconds: 500_000_000)
            return "FAKE SUBMITTED ONLY; inert executor calls=\(calls). No Bluetooth or paper."
        }
        if mode == "ai-client" {
            service.setConfirmationMode(.aiClient)
        } else {
            service.onChange = { [weak service] in
                guard service?.active?.state == "awaiting_approval" else { return }
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 100_000_000)
                    service?.approveActive()
                }
            }
        }
        let server = try UnixServer(directory: root.appendingPathComponent("socket"),
            expectedUID: mode == "wrong-peer" ? getuid() + 1 : getuid(),
            onError: { code in FileHandle.standardError.write(Data("FIXTURE \(code)\n".utf8)) },
            handler: { service.handle($0) })
        server.start()
        print(server.socketPath)
        fflush(stdout)
        try await Task.sleep(nanoseconds: 60_000_000_000)
        service.close(); server.stop()
    }

    @MainActor static func waitForCompletion(_ service: HelperService) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(5))
        while let active = service.active {
            try check(clock.now < deadline, "timed out waiting for helper completion (state: \(active.state))")
            try await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    @MainActor static func checks() async throws {
        let root = URL(fileURLWithPath: "/tmp/cppchecks-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let png = try Data(contentsOf: URL(fileURLWithPath: "examples/test-pattern.png"))
        let encoded = png.base64EncodedString()
        let store = try ReceiptStore(directory: root.appendingPathComponent("receipts"))
        var calls = 0
        var state = "ready"
        let service = try HelperService(store: store, bluetooth: { state }) { _, _ in
            calls += 1
            try await Task.sleep(nanoseconds: 100_000_000)
            return "FAKE SUBMITTED ONLY"
        }
        let fields: [String: Any] = ["job_id": UUID().uuidString, "device_id": UUID().uuidString, "png_base64": encoded, "paper_approved": true]
        try check(calls == 0, "construction must not execute")
        let health = service.handle(try request("helper_status"))
        try check(health.ok && health.result?.health?.bluetooth == "ready", "pure status")
        try check(health.result?.health?.supports_expected_confirmation_mode == true, "status advertises atomic confirmation-mode guard")
        var oldHealth = try JSONSerialization.jsonObject(with: JSONEncoder().encode(health.result!.health!)) as! [String: Any]
        oldHealth.removeValue(forKey: "supports_expected_confirmation_mode")
        let legacyHealth = try JSONDecoder().decode(HelperHealth.self, from: JSONSerialization.data(withJSONObject: oldHealth))
        try check(legacyHealth.supports_expected_confirmation_mode == nil, "old status decodes without claiming support for the new guard")
        let inspected = service.handle(try request("inspect_png", ["png_base64": encoded]))
        try check(inspected.result?.image?.width == 384 && inspected.result?.image?.height == 288, "inspect actual PNG")
        let exactPreview = Data(base64Encoded: inspected.result!.preview_png_base64!)!
        try check(try RasterImage.decodePNG(exactPreview) == RasterImage.decodePNG(png), "preview pixels match the exact print bitmap")
        let gray = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 384, pixelsHigh: 1, bitsPerSample: 8,
            samplesPerPixel: 1, hasAlpha: false, isPlanar: false, colorSpaceName: .deviceWhite, bytesPerRow: 384, bitsPerPixel: 8)!
        gray.bitmapData!.initialize(repeating: 180, count: 384)
        gray.bitmapData![0] = 0
        let grayPNG = gray.representation(using: .png, properties: [:])!
        let thresholded = service.handle(try request("inspect_png", ["png_base64": grayPNG.base64EncodedString()]))
        let thresholdImage = NSBitmapImageRep(data: Data(base64Encoded: thresholded.result!.preview_png_base64!)!)!
        try check(thresholdImage.colorAt(x: 1, y: 0)!.usingColorSpace(.deviceGray)!.whiteComponent > 0.99, "light-gray content is visibly white in approval preview")
        try check(thresholdImage.colorAt(x: 0, y: 0)!.usingColorSpace(.deviceGray)!.whiteComponent < 0.01, "preview black bits are not inverted")
        for bad in ["", "not base64", Data(png.prefix(64)).base64EncodedString(),
                    Data(repeating: 0, count: HelperLimits.pngBytes + 1).base64EncodedString()] {
            try check(!service.handle(try request("inspect_png", ["png_base64": bad])).ok, "invalid/truncated/oversized rejected")
        }
        let wrongWidth = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 383, pixelsHigh: 1, bitsPerSample: 8,
            samplesPerPixel: 3, hasAlpha: false, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        let wrongWidthPNG = wrongWidth.representation(using: .png, properties: [:])!
        try check(service.handle(try request("inspect_png", ["png_base64": wrongWidthPNG.base64EncodedString()])).error?.code == "invalid_image", "helper revalidates 384-dot width")
        try check(!service.handle(try request("inspect_png", ["path": "/etc/passwd"])).ok, "no arbitrary path API")
        try check(!service.handle(Data("{".utf8)).ok, "malformed JSON")
        try check(service.handle(try request("approve_active")).error?.code == "unknown_method", "IPC cannot approve physical work")
        var notApproved = fields; notApproved["paper_approved"] = false
        try check(service.handle(try request("submit_png", notApproved)).error?.code == "paper_approval_required", "explicit approval required")
        for permission in ["permission_pending", "denied", "restricted", "off", "unsupported"] {
            state = permission
            try check(service.handle(try request("submit_png", fields)).error?.code == "bluetooth_\(permission)", "typed permission failure")
        }
        state = "ready"
        var guarded = fields; guarded["expected_confirmation_mode"] = "ai_client"
        try check(service.handle(try request("submit_png", guarded)).error?.code == "confirmation_mode_changed" && calls == 0,
                  "stale mode guard rejects before durable admission or execution")
        guarded["expected_confirmation_mode"] = NSNull()
        try check(service.handle(try request("submit_png", guarded)).error?.code == "invalid_request", "null mode guard is not an omitted guard")
        guarded["expected_confirmation_mode"] = "unknown"
        try check(service.handle(try request("submit_png", guarded)).error?.code == "invalid_request", "unknown mode guard rejected")
        let admitted = service.handle(try request("submit_png", fields))
        try check(admitted.result?.receipt?.state == "awaiting_approval" && calls == 0, "MCP alone cannot physically print")
        let id = admitted.result!.receipt!.job_id
        try renderPreview(service)
        try check(try store.read(id) != nil, "durable admission precedes physical work")
        var overwrite = admitted.result!.receipt!
        overwrite.state = "uncertain"
        do {
            try store.save(overwrite, new: true)
            throw CheckError.assertion("atomic admission overwrote an existing ID")
        } catch let error as HelperFailure { try check(error.code == "receipt_storage_failed", "exclusive atomic admission refuses overwrite") }
        try check(try store.read(id)?.state == "awaiting_approval", "failed exclusive admission preserves original receipt")
        try check(service.handle(try request("submit_png", fields)).result?.receipt?.job_id == id && calls == 0, "duplicate pending is a receipt, not replay")
        var different = fields; different["job_id"] = UUID().uuidString
        try check(service.handle(try request("submit_png", different)).error?.code == "busy", "busy rejects without queue")
        var conflict = fields; conflict["device_id"] = UUID().uuidString
        try check(service.handle(try request("submit_png", conflict)).error?.code == "job_id_conflict", "ID binds device")
        service.approveActive()
        try await waitForCompletion(service)
        try check(calls == 1 && service.latest?.state == "submitted_only" && service.latest?.paper_confirmed == false, "native approval submits once, never paper confirmed")
        try check(service.handle(try request("submit_png", fields)).result?.receipt?.state == "submitted_only" && calls == 1, "terminal duplicate cannot replay")
        let restarted = try HelperService(store: store, bluetooth: { "ready" }) { _, _ in throw CheckError.assertion("replay") }
        try check(restarted.handle(try request("submit_png", fields)).result?.receipt?.state == "submitted_only", "terminal receipt across new instance")
        let pending = restarted.handle(try request("submit_png", different)).result!.receipt!
        let afterCrash = try HelperService(store: store, bluetooth: { "ready" }) { _, _ in throw CheckError.assertion("replay") }
        try check(afterCrash.handle(try request("submit_png", different)).result?.receipt?.state == "cancelled_before_submission", "pending approval across restart is provably unsent")
        restarted.cancelActive()
        try check(restarted.latest?.state == "cancelled_before_submission", "pre-approval cancellation cannot print")
        try check(pending.paper_confirmed == false, "receipt is not paper proof")
        var cancelFields = fields; cancelFields["job_id"] = UUID().uuidString
        _ = service.handle(try request("submit_png", cancelFields))
        service.approveActive()
        try await Task.sleep(nanoseconds: 10_000_000)
        service.cancelActive()
        try await Task.sleep(nanoseconds: 20_000_000)
        try check(service.latest?.state == "uncertain" && service.safetyBlocked, "in-progress cancellation cannot undo paper and blocks new work")
        try check(service.handle(try request("submit_png", different)).result?.receipt?.state == "cancelled_before_submission", "duplicates remain queryable while blocked")
        var blockedFields = fields; blockedFields["job_id"] = UUID().uuidString
        try check(service.handle(try request("submit_png", blockedFields)).error?.code == "safety_blocked", "uncertain work cannot overlap a new job")
        do {
            _ = try ReceiptStore(directory: root.appendingPathComponent("receipts"))
            throw CheckError.assertion("second helper lock admitted")
        } catch let error as HelperFailure { try check(error.code == "helper_already_running", "exclusive store lock") }
        for (index, error) in [CLIError.connectionFailed("Notification subscription failed"), CLIError.transferStalled("No credits")].enumerated() {
            let failingStore = try ReceiptStore(directory: root.appendingPathComponent("failure-\(index)"))
            let failing = try HelperService(store: failingStore, bluetooth: { "ready" }) { _, _ in throw error }
            let admitted = failing.handle(try request("submit_png", fields))
            try check(admitted.ok, "inert failure job admitted")
            failing.approveActive()
            try await Task.sleep(nanoseconds: 10_000_000)
            try check(failing.latest?.state == "uncertain" && failing.latest?.error_code == error.code && failing.safetyBlocked,
                      "notification/stall failures retain explicit uncertainty and block next work")
            failing.acknowledgeUncertainty()
            try check(failing.safetyBlocked && failing.restartRequired, "an in-process transfer error requires restart before acknowledgment")
            let recovered = try HelperService(store: failingStore, bluetooth: { "ready" }) { _, _ in throw CheckError.assertion("unexpected print") }
            try check(recovered.safetyBlocked && recovered.canAcknowledge, "startup surfaces unresolved receipt before new admission")
            try check(recovered.handle(try request("submit_png", blockedFields)).error?.code == "safety_blocked", "restart cannot silently clear uncertain-job gate")
            recovered.acknowledgeUncertainty()
            try check(!recovered.safetyBlocked && recovered.latest?.paper_confirmed == false, "native acknowledgment is not paper confirmation")
            try check(recovered.handle(try request("submit_png", fields)).result?.receipt?.state == "uncertain", "acknowledged job ID never replays")
            let checkedAgain = try HelperService(store: failingStore, bluetooth: { "ready" }) { _, _ in throw CheckError.assertion("unexpected print") }
            try check(!checkedAgain.safetyBlocked, "native acknowledgment persists")
            checkedAgain.close(); recovered.close()
            failing.close()
        }
        let corruptStore = try ReceiptStore(directory: root.appendingPathComponent("corrupt"))
        let corrupt = try HelperService(store: corruptStore, bluetooth: { "ready" }) { _, _ in throw CheckError.assertion("corrupt receipt replay") }
        let original = corrupt.handle(try request("submit_png", fields)).result!.receipt!
        corrupt.cancelActive()
        let stray = root.appendingPathComponent("corrupt/.DS_Store")
        try Data("unrelated Finder metadata".utf8).write(to: stray)
        let abandoned = root.appendingPathComponent("corrupt/.\(UUID().uuidString).tmp")
        try Data("torn unpublished admission".utf8).write(to: abandoned)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: abandoned.path)
        let withStrays = try HelperService(store: corruptStore, bluetooth: { "ready" }) { _, _ in throw CheckError.assertion("unexpected print") }
        try check(!withStrays.safetyBlocked && FileManager.default.fileExists(atPath: stray.path), "Finder metadata is ignored, not deleted or counted as a receipt")
        try check(!FileManager.default.fileExists(atPath: abandoned.path), "torn unpublished temporary admission is safely discarded")
        try check(try corruptStore.read(original.job_id)?.state == "cancelled_before_submission", "temporary cleanup preserves receipts")
        withStrays.close()
        let record = root.appendingPathComponent("corrupt/\(original.job_id.uuidString.lowercased()).json")
        try Data("broken receipt".utf8).write(to: record)
        do {
            _ = try HelperService(store: corruptStore, bluetooth: { "ready" }) { _, _ in throw CheckError.assertion("corrupt receipt replay") }
            throw CheckError.assertion("corrupt persistent receipt admitted a service")
        } catch let error as HelperFailure { try check(error.code == "receipt_storage_failed", "corrupt receipt fails startup closed") }
        corrupt.close()
        service.close(); restarted.close(); afterCrash.close()
        try await confirmationChecks(root: root, fields: fields)
        try await discoveryChecks(root: root, fields: fields)
        print("PASS \(assertionCount) helper assertions: approval, PNG bounds, errors, durable IDs, busy, cancellation and restart uncertainty. No Bluetooth.")
    }

    @MainActor static func discoveryChecks(root: URL, fields: [String: Any]) async throws {
        var scans = 0, stops = 0, executions = 0
        let values = (0..<40).map { _ in DiscoveredPrinter(id: UUID(), name: PrinterSelection.advertisedName, rssi: -60) }
        let discovery = HelperDiscovery(timeout: 20_000_000) { receive in
            scans += 1
            defer { stops += 1 }
            receive([values[0], values[0], DiscoveredPrinter(id: UUID(), name: "Keyboard", rssi: -40)] + values)
            try await Task.sleep(nanoseconds: 1_000_000_000)
        }
        let store = try ReceiptStore(directory: root.appendingPathComponent("discovery"))
        var radio = "not_requested"
        let service = try HelperService(store: store, bluetooth: { radio }, discovery: discovery) { _, _ in
            executions += 1; return "INERT"
        }
        func call(_ method: String, _ id: UUID) throws -> HelperReply {
            service.handle(try request(method, ["scan_id": id.uuidString]))
        }
        func settle() async throws {
            for _ in 0..<100 {
                if !discovery.running { return }
                try await Task.sleep(nanoseconds: 5_000_000)
            }
            throw CheckError.assertion("Discovery failed to stop")
        }
        try check(service.handle(try request("helper_status")).result?.health?.supports_printer_discovery == true && scans == 0,
                  "opening/status advertises discovery without accessing Bluetooth")
        try check(try call("start_discovery", UUID()).result?.discovery?.state == "permission_required" && scans == 0,
                  "scan cannot bypass explicit native Bluetooth enable")
        radio = "off"
        try check(try call("start_discovery", UUID()).result?.discovery?.state == "unavailable" && scans == 0, "radio-off scan does not start")
        radio = "ready"
        let id = UUID()
        try check(try call("start_discovery", id).result?.discovery?.state == "scanning", "explicit scan starts")
        try check(try call("start_discovery", UUID()).error?.code == "discovery_busy", "scans serialize across clients")
        try check(service.handle(try request("submit_png", fields)).error?.code == "discovery_busy", "print admission cannot overlap discovery")
        try check(try store.all().isEmpty && executions == 0, "scanning creates no print receipt or dispatch")
        await Task.yield()
        let snapshot = try call("discovery_status", id).result!.discovery!
        try check(snapshot.devices.count == 32 && Set(snapshot.devices.map(\.id)).count == 32, "results are filtered, deduplicated and capped")
        try check(try call("start_discovery", id).result?.discovery?.scan_id == id && scans == 1, "same scan identity never starts twice")
        try check(try call("stop_discovery", UUID()).error?.code == "unknown_scan" && discovery.running, "another panel cannot stop this scan")
        try check(try call("stop_discovery", id).result?.discovery?.state == "stopping" && discovery.running, "stop does not release admission until cleanup")
        try await settle()
        try check(discovery.snapshot.state == "stopped" && stops == 1 && executions == 0, "explicit stop cleans up without printing")
        _ = try call("start_discovery", UUID())
        try await settle()
        try check(scans == 2 && stops == 2 && discovery.snapshot.state == "stopped", "absolute time bound cancels scanner")
        try check(service.handle(try request("submit_png", fields)).result?.receipt?.state == "awaiting_approval", "print can be admitted after scan cleanup")
        try check(try call("start_discovery", UUID()).error?.code == "busy", "discovery cannot overlap an admitted print")
        service.cancelActive()
        _ = try call("start_discovery", UUID())
        await Task.yield()
        service.close()
        try await settle()
        try check(stops == 3 && executions == 0, "helper close stops the scan without starting physical work")
        let denied = HelperDiscovery { _ in throw CLIError.bluetoothDenied }
        _ = try denied.start(id: UUID(), bluetooth: "ready")
        for _ in 0..<100 where denied.running { try await Task.sleep(nanoseconds: 1_000_000) }
        try check(denied.snapshot.state == "permission_required" && !denied.running, "permission loss is visible and terminal")
        try check(service.handle(try request("start_discovery", ["scan_id": NSNull()])).error?.code == "invalid_request", "null scan identity is invalid")
    }

    @MainActor static func renderPreview(_ service: HelperService, suffix: String = "") throws {
        guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--preview" else { return }
        let view = HelperView(frame: NSRect(x: 0, y: 0, width: 760, height: 960))
        view.render(bluetooth: "ready", active: service.active, latest: service.latest,
                    preview: service.preview, blocked: service.safetyBlocked, fatal: nil,
                    canAcknowledge: service.canAcknowledge, acknowledgmentUnavailableReason: service.acknowledgmentUnavailableReason,
                    confirmationMode: service.confirmationMode, confirmationPreferenceError: service.confirmationPreferenceError)
        view.layoutSubtreeIfNeeded()
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw CheckError.assertion("preview bitmap") }
        view.cacheDisplay(in: view.bounds, to: bitmap)
        guard let data = bitmap.representation(using: .png, properties: [:]) else { throw CheckError.assertion("preview encoding") }
        let output = URL(fileURLWithPath: CommandLine.arguments[2])
        let path = suffix.isEmpty ? output : output.deletingPathExtension().appendingPathExtension(suffix + ".png")
        try data.write(to: path)
    }

    @MainActor static func confirmationChecks(root: URL, fields: [String: Any]) async throws {
        let directory = root.appendingPathComponent("confirmation")
        let store = try ReceiptStore(directory: directory)
        var calls = 0
        var radio = "ready"
        let service = try HelperService(store: store, bluetooth: { radio }) { _, _ in
            calls += 1
            try await Task.sleep(nanoseconds: 100_000_000)
            return "FAKE SUBMITTED ONLY"
        }
        try check(service.confirmationMode == .native && service.confirmationPreferenceError == nil, "absent preference defaults to native without an error")
        let staged = service.handle(try request("submit_png", fields)).result!.receipt!
        service.setConfirmationMode(.aiClient)
        try check(try store.loadConfirmationMode() == .aiClient, "explicit client opt-in persists")
        try check(service.active?.state == "awaiting_approval" && calls == 0, "mode change cannot execute pre-existing staged job")
        try check(service.handle(try request("submit_png", fields)).result?.receipt?.state == "awaiting_approval" && calls == 0, "repeated staged ID does not gain client-mode approval")
        service.cancelActive()
        let health = service.handle(try request("helper_status")).result!.health!
        try check(health.confirmation_mode == .aiClient && health.confirmation_preference_error == nil, "status exposes effective opted-in mode")
        var fresh = fields; fresh["job_id"] = UUID().uuidString
        var missing = fresh; missing.removeValue(forKey: "paper_approved")
        try check(!service.handle(try request("submit_png", missing)).ok && calls == 0, "client mode rejects missing approval")
        var denied = fresh; denied["paper_approved"] = false
        try check(service.handle(try request("submit_png", denied)).error?.code == "paper_approval_required" && calls == 0, "client mode rejects false approval")
        var invalid = fresh; invalid["png_base64"] = "malformed"
        try check(!service.handle(try request("submit_png", invalid)).ok && calls == 0, "client mode rejects invalid image before execution")
        for state in ["denied", "off", "permission_pending"] {
            radio = state
            try check(service.handle(try request("submit_png", fresh)).error?.code == "bluetooth_\(state)" && calls == 0, "client mode preserves Bluetooth guard")
        }
        radio = "ready"
        var staleNativeMode = fresh; staleNativeMode["expected_confirmation_mode"] = "native"
        try check(service.handle(try request("submit_png", staleNativeMode)).error?.code == "confirmation_mode_changed" && calls == 0,
                  "native-to-client mode change cannot turn a stale approval into immediate execution")
        var guardedFresh = fresh; guardedFresh["expected_confirmation_mode"] = "ai_client"
        let admitted = service.handle(try request("submit_png", guardedFresh)).result!.receipt!
        try check(admitted.state == "in_progress" && admitted.confirmation_mode == .aiClient && calls == 0, "same-turn admission returns current persisted state before scheduled execution")
        try renderPreview(service, suffix: "ai-client")
        try check(service.handle(try request("submit_png", fresh)).result?.receipt?.state == "in_progress", "same in-flight ID cannot schedule another execution")
        var other = fresh; other["job_id"] = UUID().uuidString
        try check(service.handle(try request("submit_png", other)).error?.code == "busy", "client mode preserves single active job")
        try await waitForCompletion(service)
        try check(calls == 1, "client-approved submission executes once without any native or test-side approval (calls: \(calls))")
        try check(service.latest?.state == "submitted_only",
                  "client-approved submission reports transfer (state: \(service.latest?.state ?? "missing"), error: \(service.latest?.error_code ?? "none"))")
        try check(service.handle(try request("submit_png", fresh)).result?.receipt?.state == "submitted_only" && calls == 1, "completed client-approved ID never replays")
        service.close()

        // Model process loss with a durable unapproved receipt, without executing it.
        try store.save(staged)
        let restarted = try HelperService(store: store, bluetooth: { "ready" }) { _, _ in
            throw CheckError.assertion("restart replay")
        }
        try check(restarted.confirmationMode == .aiClient && restarted.active == nil, "startup loads opt-in but schedules no work")
        try check(restarted.handle(try request("submit_png", fields)).result?.receipt?.state == "cancelled_before_submission", "restart cancels unapproved receipt even with saved client mode")
        try check(restarted.handle(try request("submit_png", fresh)).result?.receipt?.state == "submitted_only", "restart preserves completed identity")
        restarted.close()
        try store.save(admitted)
        let uncertain = try HelperService(store: store, bluetooth: { "ready" }) { _, _ in throw CheckError.assertion("uncertain replay") }
        try check(uncertain.safetyBlocked && uncertain.handle(try request("submit_png", other)).error?.code == "safety_blocked", "client mode restart preserves uncertain-job block")
        uncertain.close()

        let failureDirectory = root.appendingPathComponent("confirmation-failures")
        let failureStore = try ReceiptStore(directory: failureDirectory)
        let failClosed = try HelperService(store: failureStore, bluetooth: { "ready" }) { _, _ in throw CheckError.assertion("preference failure executed") }
        failClosed.setConfirmationMode(.aiClient)
        let preference = failureDirectory.appendingPathComponent("confirmation.json")
        try FileManager.default.setAttributes([.posixPermissions: 0o400], ofItemAtPath: preference.path)
        failClosed.setConfirmationMode(.aiClient)
        let failedHealth = failClosed.handle(try request("helper_status")).result!.health!
        try check(failedHealth.confirmation_mode == .native && failedHealth.confirmation_preference_error?.code == "confirmation_preference_write_failed", "failed save is visible and falls closed before applying opt-in")
        try check(failClosed.handle(try request("submit_png", fields)).result?.receipt?.state == "awaiting_approval", "failed save cannot auto-execute future jobs")
        try renderPreview(failClosed, suffix: "preference-error")
        failClosed.close()
        let unreadable = try HelperService(store: failureStore, bluetooth: { "ready" }) { _, _ in throw CheckError.assertion("unreadable preference executed") }
        try check(unreadable.confirmationMode == .native && unreadable.confirmationPreferenceError?.code == "confirmation_preference_read_failed", "unsafe/unreadable preference defaults visibly to native")
        unreadable.close()
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: preference.path)
        for content in ["{broken", "{\"confirmation_mode\":\"unknown\"}", "{\"confirmation_mode\":true}", "{\"confirmation_mode\":\"ai_client\",\"extra\":1}"] {
            try Data(content.utf8).write(to: preference)
            let malformed = try HelperService(store: failureStore, bluetooth: { "ready" }) { _, _ in throw CheckError.assertion("malformed preference executed") }
            try check(malformed.confirmationMode == .native && malformed.confirmationPreferenceError != nil, "malformed preference never grants approval")
            var unapproved = fields; unapproved["job_id"] = UUID().uuidString
            try check(malformed.handle(try request("submit_png", unapproved)).result?.receipt?.state == "awaiting_approval", "malformed preference requires native confirmation on future job")
            malformed.close()
        }
        let repair = try HelperService(store: failureStore, bluetooth: { "ready" }) { _, _ in throw CheckError.assertion("preference repair executed") }
        repair.setConfirmationMode(.aiClient)
        try check(repair.confirmationMode == .aiClient && repair.confirmationPreferenceError == nil, "explicit successful save repairs a malformed preference")
        repair.setConfirmationMode(.native)
        try check(try failureStore.loadConfirmationMode() == .native, "native mode can be restored persistently")
        repair.close()
        let fifoDirectory = root.appendingPathComponent("confirmation-fifo")
        let fifoStore = try ReceiptStore(directory: fifoDirectory)
        try check(mkfifo(fifoDirectory.appendingPathComponent("confirmation.json").path, 0o600) == 0, "create inert non-regular preference fixture")
        let fifo = try HelperService(store: fifoStore, bluetooth: { "ready" }) { _, _ in throw CheckError.assertion("non-regular preference executed") }
        try check(fifo.confirmationMode == .native && fifo.confirmationPreferenceError != nil, "non-regular preference cannot block reading or enable client mode")
        fifo.setConfirmationMode(.aiClient)
        try check(fifo.confirmationMode == .native && fifo.confirmationPreferenceError?.code == "confirmation_preference_write_failed", "non-regular preference cannot block saving or apply opt-in")
        fifo.close()

        let radioStore = try ReceiptStore(directory: root.appendingPathComponent("confirmation-radio-change"))
        var radioReads = 0
        let radioChanged = try HelperService(store: radioStore, bluetooth: {
            radioReads += 1
            return radioReads == 1 ? "ready" : "off"
        }) { _, _ in throw CheckError.assertion("radio-off execution") }
        radioChanged.setConfirmationMode(.aiClient)
        try check(radioChanged.handle(try request("submit_png", fields)).result?.receipt?.state == "cancelled_before_submission", "shared funnel rechecks Bluetooth and returns current cancellation, not stale admission")
        radioChanged.close()

        let cancelledStore = try ReceiptStore(directory: root.appendingPathComponent("confirmation-cancel"))
        let cancelled = try HelperService(store: cancelledStore, bluetooth: { "ready" }) { _, _ in
            try await Task.sleep(nanoseconds: 100_000_000)
            return "FAKE SUBMITTED ONLY"
        }
        cancelled.setConfirmationMode(.aiClient)
        _ = cancelled.handle(try request("submit_png", fields))
        try await Task.sleep(nanoseconds: 10_000_000)
        cancelled.cancelActive()
        try await Task.sleep(nanoseconds: 20_000_000)
        try check(cancelled.latest?.state == "uncertain" && cancelled.safetyBlocked, "client-approved cancellation retains uncertainty after work may have started")
        try check(cancelled.handle(try request("submit_png", other)).error?.code == "safety_blocked", "cancelled client work cannot overlap a new job")
        cancelled.close()
    }
}
