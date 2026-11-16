import Combine
import Foundation
import PocketPrinter5890BLE
import PocketPrinter5890Kit

public struct PrinterTiming {
    public var startup: TimeInterval = 5
    public var discovery: TimeInterval = 8
    public var connection: TimeInterval = 8
    public var transfer: TimeInterval = 120
    public var stall: TimeInterval = 10
    public var observation: TimeInterval = 2
    public var shutdown: TimeInterval = 2
    public var pollNanoseconds: UInt64 = 20_000_000
    public init() {}
}

@MainActor
public final class PrinterClient {
    private let link: any PrinterLink
    private let timing: PrinterTiming
    private var subscriptions = Set<AnyCancellable>()
    private var connection: BLEConnectionState = .disconnected
    private var writes: BLEWriteState = .idle
    private var failure: CLIError?
    private var connecting = false
    private var closing = false
    private var used = false
    private var ownJob = false
    private var sawPending = false
    private var ownDrained = false
    private var remaining: Int?
    private var progressAt: TimeInterval = 0
    private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    public init(link: any PrinterLink, timing: PrinterTiming = PrinterTiming()) {
        self.link = link
        self.timing = timing
        // Store emitted values: @Published delivers before its property changes.
        link.connectionEvents.sink { [weak self] in self?.received($0) }.store(in: &subscriptions)
        link.writeEvents.sink { [weak self] in self?.received($0) }.store(in: &subscriptions)
    }

    public static func native(timeout: TimeInterval) throws -> PrinterClient {
        try BluetoothPreflight.checkKnownHost()
        let link = PocketPrinter5890BLE(fileLoggingEnabled: false)
        link.showOnlyLikelyPrinters = false
        link.preferredProfileID = PrinterBLEProfiles.ff00.id
        link.useCreditFlowControl = true
        link.interPacketDelay = 0
        link.preferWriteWithResponse = false
        link.maxChunkSize = 180
        var timing = PrinterTiming()
        timing.discovery = timeout
        timing.connection = timeout
        return PrinterClient(link: link, timing: timing)
    }

    public func status(deviceID: UUID?, connect: Bool) async throws -> String {
        try begin()
        defer { cancel() }
        let device = try await discover(id: deviceID)
        if !connect {
            return """
            DISCOVERED ONLY: \(ASCIIText.transliterate(device.name))
            Device: \(device.id.uuidString)
            Signal: \(device.rssi) dBm
            No connection or command writes. Battery, paper, model, firmware and print readiness are unknown.
            """
        }
        guard deviceID != nil else { throw CLIError.invalidInput("Connected status requires an explicit device UUID.") }
        try await establish(device)
        try await submit(PrintJob.statusSegments)
        // Keep the link open for decoded replies; this interval is not proof
        // of firmware completion, and AA 0D 0A never acts as a completion signal.
        try await observe()
        let readings = link.readings
        let summary = """
        CONNECTED: \(ASCIIText.transliterate(device.name))
        Device: \(device.id.uuidString)
        Confirmed FF00 / FF02 with FF01 + FF03 notifications.
        \(readings.summary)
        Activation/wake, status queries and stop submitted; no raster, feed or settings requested.
        """
        try await close()
        guard readings.hasQueryEvidence else { throw CLIError.statusUnverified(summary) }
        return summary + "\nDisconnected. No raster or feed was requested."
    }

    public func submit(_ job: PrintJob, deviceID: UUID) async throws -> String {
        try begin()
        defer { cancel() }
        let device = try await discover(id: deviceID)
        try await establish(device)
        try await submit(job.segments)
        try await observe()
        try await close()
        return """
        SUBMITTED ONLY: \(job.segments.reduce(0) { $0 + $1.bytes.count }) protocol bytes handed to CoreBluetooth.
        Local queue drained, including any required write-response callbacks. Without-response writes have no delivery acknowledgement.
        A \(timing.observation)-second observation window elapsed.
        This is not confirmation of firmware receipt or paper completion. Inspect the paper before any further action.
        Disconnected. No automatic retry or reconnect.
        """
    }

    public func scanPrinters(onChange: @escaping @MainActor ([DiscoveredPrinter]) -> Void) async throws {
        try begin()
        defer { cancel() }
        let startupDeadline = now + timing.startup
        while !link.bluetoothReady {
            try check()
            guard now < startupDeadline else { throw CLIError.bluetoothUnavailable("Controller startup timed out.") }
            try await pause()
        }
        try check()
        link.startScan()
        let deadline = now + timing.discovery
        var previous: [DiscoveredPrinter] = []
        while now < deadline {
            try check()
            let devices = link.devices.filter { $0.name == PrinterSelection.advertisedName }
                .sorted { $0.id.uuidString < $1.id.uuidString }.prefix(32).map {
                    DiscoveredPrinter(id: $0.id, name: $0.name, rssi: (-127...20).contains($0.rssi) ? $0.rssi : nil)
                }
            if devices != previous { onChange(devices); previous = devices }
            try await pause()
        }
    }

    private func begin() throws {
        guard !used else { throw CLIError.invalidInput("A printer client is single-use; no reconnect or retry.") }
        used = true
    }

    private func discover(id: UUID?) async throws -> PrinterDevice {
        let deadline = now + timing.startup
        while !link.bluetoothReady {
            try check()
            guard now < deadline else {
                throw CLIError.bluetoothUnavailable("Startup or permission did not resolve in \(timing.startup) seconds. Observe the native prompt, then explicitly retry.")
            }
            try await pause()
        }
        try check()
        link.startScan()
        let scanDeadline = now + timing.discovery
        while now < scanDeadline {
            try check()
            try await pause()
        }
        link.stopScan()
        try check()
        return try PrinterSelection.choose(link.devices, id: id)
    }

    private func establish(_ device: PrinterDevice) async throws {
        connecting = true
        link.connect(to: device)
        let deadline = now + timing.connection
        while connection != .ready {
            try check()
            guard now < deadline else { throw CLIError.connectionFailed("Readiness/notification deadline expired") }
            try await pause()
        }
        try check()
        guard link.hasRequiredProfile else { throw CLIError.connectionFailed("Required FF00/FF02/FF01/FF03 profile not confirmed") }
    }

    private func submit(_ segments: [PrintSegment]) async throws {
        let deadline = now + timing.transfer
        let idleDeadline = now + timing.stall
        // The library starts a battery query on ready. Wait for that queue
        // before arming our own job, so its drain cannot complete our operation.
        while writes != .idle && writes != .drained {
            try check()
            guard now < min(deadline, idleDeadline) else { throw CLIError.transferStalled("Pre-existing writes did not drain") }
            try await pause()
        }
        try check()
        ownJob = true
        sawPending = false
        ownDrained = false
        remaining = nil
        progressAt = now
        link.send(segments) // One atomic enqueue; no per-segment empty-queue gaps.
        while !ownDrained {
            try check()
            guard now < deadline else { throw CLIError.transferStalled("Overall submission deadline expired") }
            guard now - progressAt < timing.stall else { throw CLIError.transferStalled("No local write progress or response callback") }
            try await pause()
        }
        try check()
        ownJob = false
    }

    private func observe() async throws {
        let deadline = now + timing.observation
        while now < deadline {
            try check()
            try await pause()
        }
        try check()
    }

    private func close() async throws {
        closing = true
        link.disconnect()
        let deadline = now + timing.shutdown
        while connection != .disconnected {
            try Task.checkCancellation()
            if let failure { throw failure }
            guard now < deadline else {
                throw CLIError.transferInterrupted("Disconnect completion was not observed")
            }
            try await pause()
        }
        if let failure { throw failure }
    }

    private func cancel() {
        closing = true
        ownJob = false
        link.stopScan()
        if connection != .disconnected && connection != .disconnecting { link.disconnect() }
    }

    private func pause() async throws { try await Task.sleep(nanoseconds: timing.pollNanoseconds) }

    private func check() throws {
        try Task.checkCancellation()
        if link.permissionDenied { throw CLIError.bluetoothDenied }
        if let failure { throw failure }
    }

    private func received(_ value: BLEConnectionState) {
        connection = value
        switch value {
        case .failed(let error):
            if failure == nil { failure = map(error) }
        case .ready where !link.hasRequiredProfile:
            failure = .connectionFailed("Required FF00/FF02/FF01/FF03 profile not confirmed")
            // Reject fallback UART before upstream starts its automatic query.
            link.disconnect()
        case .disconnected, .disconnecting:
            if connecting && !closing && failure == nil {
                failure = .transferInterrupted("Connection ended")
            }
        default: break
        }
    }

    private func received(_ value: BLEWriteState) {
        writes = value
        if case .failed(let error) = value, failure == nil { failure = map(error) }
        guard ownJob, !closing else { return }
        switch value {
        case .pending(let bytes, _):
            sawPending = true
            if bytes < (remaining ?? Int.max) { progressAt = now }
            remaining = bytes
        case .drained:
            if sawPending { ownDrained = true }
        case .cancelled:
            if failure == nil { failure = .transferInterrupted("Queued work cancelled") }
        default: break
        }
    }

    private func map(_ error: BLETransportError) -> CLIError {
        switch error {
        case .bluetoothUnavailable:
            return link.permissionDenied ? .bluetoothDenied : .bluetoothUnavailable("Controller off, unsupported, resetting or unavailable")
        case .connectionFailed(let detail), .discoveryFailed(let detail):
            return .connectionFailed(detail)
        case .notificationFailed(let characteristic, let message):
            return .connectionFailed("Notification \(characteristic): \(message)")
        case .notReady:
            return .connectionFailed("Transport rejected writes before readiness")
        case .writeFailed(let detail):
            return .transferInterrupted(detail)
        case .disconnected:
            return .transferInterrupted("Peripheral disconnected")
        }
    }
}
