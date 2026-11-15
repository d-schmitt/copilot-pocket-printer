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
        let service = try HelperService(store: store, bluetooth: { mode == "wrong-peer" ? "ready" : mode }) { _, _ in
            calls += 1
            try await Task.sleep(nanoseconds: 500_000_000)
            return "FAKE SUBMITTED ONLY; inert executor calls=\(calls). No Bluetooth or paper."
        }
        service.onChange = { [weak service] in
            guard service?.active?.state == "awaiting_approval" else { return }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 100_000_000)
                service?.approveActive()
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
        let admitted = service.handle(try request("submit_png", fields))
        try check(admitted.result?.receipt?.state == "awaiting_approval" && calls == 0, "MCP alone cannot physically print")
        let id = admitted.result!.receipt!.job_id
        if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--preview" {
            let view = HelperView(frame: NSRect(x: 0, y: 0, width: 680, height: 680))
            view.appearance = NSAppearance(named: .aqua)
            view.render(bluetooth: "ready (INERT OFFLINE PREVIEW)", active: admitted.result?.receipt, latest: nil,
                        preview: service.preview, blocked: false, fatal: nil)
            view.layoutSubtreeIfNeeded()
            guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw CheckError.assertion("preview bitmap") }
            view.cacheDisplay(in: view.bounds, to: bitmap)
            guard let data = bitmap.representation(using: .png, properties: [:]) else { throw CheckError.assertion("preview encoding") }
            try data.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
        }
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
        try await Task.sleep(nanoseconds: 150_000_000)
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
        print("PASS \(assertionCount) helper assertions: approval, PNG bounds, errors, durable IDs, busy, cancellation and restart uncertainty. No Bluetooth.")
    }
}
