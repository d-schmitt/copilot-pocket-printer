import Combine
import Foundation
import PocketPrinter5890BLE
import PocketPrinter5890Kit
import PrinterCLIKit

@MainActor
public struct IntegrationChecks {
    public init() {}
    public var cases: [(name: String, run: () async throws -> Void)] {
        [
            ("scan-only does not connect or write", scanOnly),
            ("printer picker filters advertisements and cancels without connecting", pickerScan),
            ("confirmed connected status sends one activated read batch", connectedStatus),
            ("unknown status is not a successful reply", unknownStatus),
            ("discovery/readiness timeouts never send", readinessTimeouts),
            ("readiness rejects fallback UART", wrongProfile),
            ("notification failures cancel without submission", notificationFailure),
            ("battery drains cannot complete the submitted job", unrelatedDrain),
            ("zero remaining with response outstanding is still pending", pendingResponse),
            ("stalled queues cancel without replay", stalledQueue),
            ("disconnect and write errors never become completion", interruptedQueue),
            ("post-drain disconnect is not success", observationFailure),
            ("task cancellation discards pending work", cancellation),
            ("single-use client cannot reconnect", singleUse)
        ]
    }

    private var timing: PrinterTiming {
        var value = PrinterTiming()
        value.startup = 0.02
        value.discovery = 0.005
        value.connection = 0.02
        value.transfer = 0.1
        value.stall = 0.03
        value.observation = 0.005
        value.shutdown = 0.02
        value.pollNanoseconds = 1_000_000
        return value
    }

    private func scanOnly() async throws {
        let link = FakePrinterLink()
        let result = try await PrinterClient(link: link, timing: timing).status(deviceID: link.device.id, connect: false)
        try expect(result.contains("DISCOVERED ONLY"))
        try equal(link.connectCount, 0)
        try equal(link.batches.count, 0)
    }

    private func pickerScan() async throws {
        let link = FakePrinterLink()
        link.additionalDevices = [PrinterDevice(id: UUID(), name: "Keyboard", rssi: -30, isLikelyL13: false),
            PrinterDevice(id: UUID(), name: PrinterSelection.advertisedName, rssi: 127, isLikelyL13: true)]
        var devices: [DiscoveredPrinter] = []
        try await PrinterClient(link: link, timing: timing).scanPrinters { devices = $0 }
        try equal(devices.count, 2)
        try expect(devices.contains { $0.rssi == nil })
        try equal(link.scanStarts, 1)
        try equal(link.scanStops, 1)
        try equal(link.connectCount, 0)
        try equal(link.batches.count, 0)
        let cancelled = FakePrinterLink()
        var slow = timing; slow.discovery = 1
        let task = Task { try await PrinterClient(link: cancelled, timing: slow).scanPrinters { _ in } }
        try await Task.sleep(nanoseconds: 2_000_000)
        task.cancel()
        do { try await task.value; throw CheckFailure(description: "Cancelled scan completed") }
        catch is CancellationError {}
        try equal(cancelled.scanStops, 1)
        try equal(cancelled.connectCount, 0)
        try equal(cancelled.batches.count, 0)
        let off = FakePrinterLink()
        off.onScan = { $0.connection = .failed(.bluetoothUnavailable) }
        try await rejectsAsync("bluetooth_unavailable") {
            try await PrinterClient(link: off, timing: timing).scanPrinters { _ in }
        }
        try equal(off.scanStops, 1)
        try equal(off.connectCount, 0)
    }

    private func connectedStatus() async throws {
        let link = FakePrinterLink()
        link.readings = DeviceReadings(model: "A2Y", firmware: "V1.06LY", battery: 0, paper: 4)
        let result = try await PrinterClient(link: link, timing: timing).status(deviceID: link.device.id, connect: true)
        try expect(result.contains("CONNECTED"))
        try expect(result.contains("Battery: 0%"))
        try expect(result.contains("0x04 (raw, informational)"))
        try equal(link.batches.count, 1)
        try equal(link.batches[0].map(\.bytes), [
            [0x10, 0xff, 0xf1, 3], [UInt8](repeating: 0, count: 12),
            PrinterCommand.model, PrinterCommand.firmware, PrinterCommand.battery,
            PrinterCommand.paperStatus, [0x10, 0xff, 0xf1, 0x45]
        ])
        try equal(link.disconnectCount, 1)
        try expect(link.submittedAfterReady)
    }

    private func unknownStatus() async throws {
        let link = FakePrinterLink()
        link.readings = DeviceReadings(battery: 98) // Unsolicited/polled battery is not our query response.
        try await rejectsAsync("status_unverified") {
            _ = try await PrinterClient(link: link, timing: timing).status(deviceID: link.device.id, connect: true)
        }
        try equal(link.disconnectCount, 1)
    }

    private func readinessTimeouts() async throws {
        let denied = FakePrinterLink()
        denied.permissionDenied = true
        try await rejectsAsync("bluetooth_denied") {
            _ = try await PrinterClient(link: denied, timing: timing).status(deviceID: denied.device.id, connect: false)
        }
        try equal(denied.connectCount, 0)
        let startup = FakePrinterLink()
        startup.bluetoothReady = false
        try await rejectsAsync("bluetooth_unavailable") {
            _ = try await PrinterClient(link: startup, timing: timing).status(deviceID: startup.device.id, connect: true)
        }
        try equal(startup.connectCount, 0)
        let connecting = FakePrinterLink()
        connecting.onConnect = { $0.connection = .subscribing }
        try await rejectsAsync("connection_failed") {
            _ = try await PrinterClient(link: connecting, timing: timing).status(deviceID: connecting.device.id, connect: true)
        }
        try equal(connecting.batches.count, 0)
        try equal(connecting.disconnectCount, 1)
    }

    private func wrongProfile() async throws {
        let link = FakePrinterLink()
        link.hasRequiredProfile = false
        try await rejectsAsync("connection_failed") {
            _ = try await PrinterClient(link: link, timing: timing).status(deviceID: link.device.id, connect: true)
        }
        try equal(link.batches.count, 0)
        try expect(link.disconnectCount >= 1)
    }

    private func notificationFailure() async throws {
        let link = FakePrinterLink()
        link.onConnect = { $0.connection = .failed(.notificationFailed(characteristic: "FF03", message: "disabled")) }
        try await rejectsAsync("connection_failed") {
            _ = try await PrinterClient(link: link, timing: timing).submit(PrintJob.feed(dots: 1), deviceID: link.device.id)
        }
        try equal(link.batches.count, 0)
    }

    private func unrelatedDrain() async throws {
        let link = FakePrinterLink()
        link.onConnect = {
            $0.connection = .ready
            $0.writes = .pending(remainingBytes: 4, awaitingResponse: false)
            $0.writes = .drained // Automatic battery query, before the owned job.
        }
        link.onSend = { $0.writes = .pending(remainingBytes: 23, awaitingResponse: false) }
        try await rejectsAsync("transfer_stalled") {
            _ = try await PrinterClient(link: link, timing: timing).submit(PrintJob.feed(dots: 1), deviceID: link.device.id)
        }
        try equal(link.batches.count, 1)
        try equal(link.disconnectCount, 1)
        let stale = FakePrinterLink()
        stale.onSend = { $0.writes = .drained } // No owned pending cycle.
        try await rejectsAsync("transfer_stalled") {
            _ = try await PrinterClient(link: stale, timing: timing).submit(PrintJob.feed(dots: 1), deviceID: stale.device.id)
        }
    }

    private func pendingResponse() async throws {
        let link = FakePrinterLink()
        link.onSend = { $0.writes = .pending(remainingBytes: 0, awaitingResponse: true) }
        try await rejectsAsync("transfer_stalled") {
            _ = try await PrinterClient(link: link, timing: timing).submit(PrintJob.feed(dots: 1), deviceID: link.device.id)
        }
        let draining = FakePrinterLink()
        draining.onSend = {
            $0.writes = .pending(remainingBytes: 0, awaitingResponse: true)
            $0.writes = .drained
        }
        let result = try await PrinterClient(link: draining, timing: timing).submit(PrintJob.feed(dots: 1), deviceID: draining.device.id)
        try expect(result.hasPrefix("SUBMITTED ONLY"))
        try expect(result.contains("not confirmation"))
    }

    private func stalledQueue() async throws {
        let link = FakePrinterLink()
        link.onSend = { $0.writes = .pending(remainingBytes: 56, awaitingResponse: false) }
        let bitmap = try MonochromeBitmap(height: 1, bytes: [UInt8](repeating: 0, count: 48))
        try await rejectsAsync("transfer_stalled") {
            _ = try await PrinterClient(link: link, timing: timing).submit(PrintJob.image(bitmap), deviceID: link.device.id)
        }
        try equal(link.batches.count, 1)
        try equal(link.batches[0][2].bytes.count, 56)
        try equal(link.connectCount, 1)
        try equal(link.disconnectCount, 1)
    }

    private func interruptedQueue() async throws {
        for event: BLEWriteState in [.cancelled, .failed(.writeFailed("radio error"))] {
            let link = FakePrinterLink()
            link.onSend = {
                $0.writes = .pending(remainingBytes: 23, awaitingResponse: false)
                $0.writes = event
                $0.writes = .drained // A later drain must not hide a terminal error.
            }
            try await rejectsAsync("transfer_interrupted") {
                _ = try await PrinterClient(link: link, timing: timing).submit(PrintJob.feed(dots: 1), deviceID: link.device.id)
            }
            try equal(link.batches.count, 1)
        }
        let link = FakePrinterLink()
        link.onSend = { $0.connection = .failed(.disconnected) }
        try await rejectsAsync("transfer_interrupted") {
            _ = try await PrinterClient(link: link, timing: timing).submit(PrintJob.feed(dots: 1), deviceID: link.device.id)
        }
    }

    private func observationFailure() async throws {
        let link = FakePrinterLink()
        link.onSend = {
            $0.writes = .pending(remainingBytes: 0, awaitingResponse: true)
            $0.writes = .drained
            $0.connection = .failed(.disconnected)
        }
        try await rejectsAsync("transfer_interrupted") {
            _ = try await PrinterClient(link: link, timing: timing).submit(PrintJob.feed(dots: 1), deviceID: link.device.id)
        }
        let disconnecting = FakePrinterLink()
        disconnecting.completeDisconnect = false
        try await rejectsAsync("transfer_interrupted") {
            _ = try await PrinterClient(link: disconnecting, timing: timing).submit(PrintJob.feed(dots: 1), deviceID: disconnecting.device.id)
        }
    }

    private func cancellation() async throws {
        let link = FakePrinterLink()
        link.onSend = { $0.writes = .pending(remainingBytes: 23, awaitingResponse: false) }
        let client = PrinterClient(link: link, timing: timing)
        let task = Task { try await client.submit(PrintJob.feed(dots: 1), deviceID: link.device.id) }
        let deadline = ProcessInfo.processInfo.systemUptime + 1
        while link.batches.isEmpty {
            if ProcessInfo.processInfo.systemUptime >= deadline {
                task.cancel()
                _ = await task.result
                throw CheckFailure(description: "Cancellation test never reached submission")
            }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        task.cancel()
        do {
            _ = try await task.value
            throw CheckFailure(description: "Cancelled task unexpectedly completed")
        } catch is CancellationError {}
        try equal(link.disconnectCount, 1)
        try equal(link.connectCount, 1)
    }

    private func singleUse() async throws {
        let link = FakePrinterLink()
        let client = PrinterClient(link: link, timing: timing)
        _ = try await client.status(deviceID: link.device.id, connect: false)
        try await rejectsAsync("invalid_input") {
            _ = try await client.status(deviceID: link.device.id, connect: false)
        }
        try equal(link.connectCount, 0)
    }
}

@MainActor
private final class FakePrinterLink: PrinterLink {
    @Published var connection: BLEConnectionState = .disconnected
    @Published var writes: BLEWriteState = .idle
    var connectionEvents: AnyPublisher<BLEConnectionState, Never> { $connection.eraseToAnyPublisher() }
    var writeEvents: AnyPublisher<BLEWriteState, Never> { $writes.eraseToAnyPublisher() }
    var bluetoothReady = true
    var permissionDenied = false
    let device = PrinterDevice(id: UUID(), name: "Mini Pocket Printer_BLE", rssi: -61, isLikelyL13: true)
    var additionalDevices: [PrinterDevice] = []
    var devices: [PrinterDevice] { [device] + additionalDevices }
    var scanStarts = 0
    var scanStops = 0
    var onScan: (FakePrinterLink) -> Void = { _ in }
    var hasRequiredProfile = true
    var readings = DeviceReadings()
    var connectCount = 0
    var disconnectCount = 0
    var completeDisconnect = true
    var batches: [[PrintSegment]] = []
    var submittedAfterReady = true
    var onConnect: (FakePrinterLink) -> Void = { $0.connection = .ready }
    var onSend: (FakePrinterLink) -> Void = {
        $0.writes = .pending(remainingBytes: 1, awaitingResponse: false)
        $0.writes = .drained
    }

    func startScan() { scanStarts += 1; onScan(self) }
    func stopScan() { scanStops += 1 }
    func connect(to device: PrinterDevice) {
        connectCount += 1
        connection = .connecting
        onConnect(self)
    }
    func disconnect() {
        disconnectCount += 1
        connection = .disconnecting
        writes = .cancelled
        if completeDisconnect { connection = .disconnected }
    }
    func send(_ segments: [PrintSegment]) {
        submittedAfterReady = submittedAfterReady && connection == .ready
        batches.append(segments)
        onSend(self)
    }
}

@MainActor
private func rejectsAsync(_ code: String, _ operation: () async throws -> Void) async throws {
    var received: Error?
    do { try await operation() } catch { received = error }
    guard let received else { throw CheckFailure(description: "Expected \(code), operation completed") }
    try equal((received as? CLIError)?.code, code)
}
