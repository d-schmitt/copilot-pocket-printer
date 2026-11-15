import AppKit
import Foundation
import PermissionProbeCore
import PermissionProbeUI

@MainActor
public struct ProbeChecks {
    public init() {}

    public var cases: [(name: String, run: () throws -> Void)] {
        [
            ("probe launch creates no Bluetooth driver or timer", idle),
            ("probe pending consent has no startup or discovery timeout", pendingPermission),
            ("probe denied/restricted/unknown permission is explicit", authorizationFailures),
            ("probe radio-off and unsupported are not missing printers", radioFailures),
            ("probe authorized startup is bounded without timer extension", startupDeadline),
            ("probe repeated ready callbacks start one bounded scan", scanning),
            ("probe results are exact-name bounded advertisements only", results),
            ("probe cancel rejects stale callbacks and timers", cancelAndRepeat),
            ("probe closing releases resources and prevents restart", close),
            ("probe state loss during scan stops without retry", stateLoss),
            ("probe synchronous UI cancellation cannot start scanning", reentrancy),
            ("probe UI separates idle, pending, and completed controls", interface)
        ]
    }

    private func idle() throws {
        let fixture = Fixture()
        try equal(fixture.session.phase, .idle)
        try equal(fixture.driverCount, 0)
        try equal(fixture.permissionReads, 0)
        try equal(fixture.clock.items.count, 0)
    }

    private func pendingPermission() throws {
        let fixture = Fixture()
        fixture.authorization = .notDetermined
        fixture.session.scan()
        fixture.driver.emit(.radio(.notDetermined, .unknown))
        try equal(fixture.session.phase, .permissionPending)
        try equal(fixture.clock.items.count, 0)
        try equal(fixture.driver.scans, 0)
        fixture.session.scan()
        try equal(fixture.driverCount, 1)
        fixture.driver.emit(.radio(.allowed, .poweredOn))
        try equal(fixture.session.phase, .scanning)
        try equal(fixture.clock.items.last?.seconds, 8)
        fixture.clock.fireLatest()
        try equal(fixture.session.phase, .noResults)
        try equal(fixture.driver.shutdowns, 1)
    }

    private func authorizationFailures() throws {
        for (permission, phase): (ProbePermission, ProbePhase) in [
            (.denied, .denied), (.restricted, .restricted), (.unknown, .unavailable)
        ] {
            let fixture = Fixture()
            fixture.authorization = permission
            fixture.session.scan()
            try equal(fixture.session.phase, phase)
            try equal(fixture.driverCount, 0)
            let pending = Fixture()
            pending.authorization = .notDetermined
            pending.session.scan()
            pending.driver.emit(.radio(permission, .unauthorized))
            try equal(pending.session.phase, phase)
            try equal(pending.driver.shutdowns, 1)
        }
    }

    private func radioFailures() throws {
        for (radio, phase): (ProbeRadio, ProbePhase) in [
            (.poweredOff, .bluetoothOff), (.unsupported, .unsupported), (.unauthorized, .unavailable)
        ] {
            let fixture = Fixture()
            fixture.session.scan()
            fixture.driver.emit(.radio(.allowed, radio))
            try equal(fixture.session.phase, phase)
            try equal(fixture.driver.scans, 0)
            try equal(fixture.driver.shutdowns, 1)
            try expect(fixture.clock.items.allSatisfy(\.cancelled))
        }
    }

    private func startupDeadline() throws {
        let fixture = Fixture()
        fixture.session.scan()
        for _ in 0..<3 { fixture.driver.emit(.radio(.allowed, .resetting)) }
        try equal(fixture.clock.items.count, 1)
        try equal(fixture.clock.items[0].seconds, 10)
        fixture.clock.fireLatest()
        try equal(fixture.session.phase, .startupTimedOut)
        try equal(fixture.driver.scans, 0)
        let pending = Fixture()
        pending.session.scan()
        pending.driver.emit(.radio(.notDetermined, .unknown))
        pending.clock.fireLatest(evenIfCancelled: true)
        // The cancelled timer must also be harmless if its callback was queued.
        try equal(pending.session.phase, .permissionPending)
    }

    private func scanning() throws {
        let fixture = Fixture()
        fixture.session.scan()
        fixture.driver.emit(.radio(.allowed, .poweredOn))
        fixture.driver.emit(.radio(.allowed, .poweredOn))
        fixture.session.scan()
        try equal(fixture.driver.scans, 1)
        try equal(fixture.driverCount, 1)
        try equal(fixture.clock.items.count, 2)
        try expect(fixture.clock.items[0].cancelled)
        fixture.clock.items[0].fire(evenIfCancelled: true)
        try equal(fixture.session.phase, .scanning)
        fixture.clock.fireLatest()
        try equal(fixture.session.phase, .noResults)
        try equal(fixture.driver.shutdowns, 1)
    }

    private func results() throws {
        let fixture = Fixture()
        fixture.session.scan()
        fixture.driver.emit(.discovered(ProbeDevice(id: UUID(), name: "Mini Pocket Printer_BLE", rssi: -10)))
        try equal(fixture.session.devices.count, 0)
        fixture.driver.emit(.radio(.allowed, .poweredOn))
        fixture.driver.emit(.discovered(ProbeDevice(id: UUID(), name: "Other printer", rssi: -10)))
        let id = UUID()
        fixture.driver.emit(.discovered(ProbeDevice(id: id, name: "Mini Pocket Printer_BLE", rssi: -50)))
        fixture.driver.emit(.discovered(ProbeDevice(id: id, name: "Mini Pocket Printer_BLE", rssi: -60)))
        try equal(fixture.session.devices.count, 1)
        try equal(fixture.session.devices[0].rssi, -60)
        for _ in 0..<35 {
            fixture.driver.emit(.discovered(ProbeDevice(id: UUID(), name: "Mini Pocket Printer_BLE", rssi: -65)))
        }
        try equal(fixture.session.devices.count, 32)
        try expect(fixture.session.resultLimitReached)
        fixture.clock.fireLatest()
        try equal(fixture.session.phase, .complete)
        try equal(fixture.driver.shutdowns, 1)
    }

    private func cancelAndRepeat() throws {
        let fixture = Fixture()
        fixture.session.scan()
        let first = fixture.driver
        first.emit(.radio(.allowed, .poweredOn))
        let oldTimer = fixture.clock.items.last!
        fixture.session.cancel()
        fixture.session.cancel()
        try equal(first.shutdowns, 1)
        try equal(fixture.session.phase, .cancelled)
        fixture.session.scan()
        let second = fixture.driver
        oldTimer.fire(evenIfCancelled: true)
        first.emit(.radio(.allowed, .poweredOn))
        first.emit(.discovered(ProbeDevice(id: UUID(), name: "Mini Pocket Printer_BLE", rssi: -20)))
        try equal(fixture.session.phase, .preparing)
        try equal(fixture.session.devices.count, 0)
        try equal(second.scans, 0)
        second.emit(.radio(.allowed, .poweredOn))
        try equal(second.scans, 1)
    }

    private func close() throws {
        for pending in [true, false] {
            let fixture = Fixture()
            fixture.authorization = pending ? .notDetermined : .allowed
            fixture.session.scan()
            if !pending { fixture.driver.emit(.radio(.allowed, .poweredOn)) }
            fixture.session.close()
            fixture.session.close()
            fixture.session.scan()
            fixture.driver.emit(.radio(.allowed, .poweredOn))
            try equal(fixture.session.phase, .closed)
            try equal(fixture.driverCount, 1)
            try equal(fixture.driver.shutdowns, 1)
            try expect(fixture.clock.items.allSatisfy(\.cancelled))
        }
    }

    private func stateLoss() throws {
        for (permission, radio, phase): (ProbePermission, ProbeRadio, ProbePhase) in [
            (.denied, .unauthorized, .denied),
            (.allowed, .poweredOff, .bluetoothOff),
            (.allowed, .resetting, .unavailable),
            (.notDetermined, .unknown, .unavailable)
        ] {
            let fixture = Fixture()
            fixture.session.scan()
            fixture.driver.emit(.radio(.allowed, .poweredOn))
            fixture.driver.emit(.radio(permission, radio))
            fixture.driver.emit(.radio(.allowed, .poweredOn))
            try equal(fixture.session.phase, phase)
            try equal(fixture.driver.scans, 1)
            try equal(fixture.driver.shutdowns, 1)
        }
    }

    private func reentrancy() throws {
        let fixture = Fixture()
        fixture.session.onChange = { [weak fixture] in
            if fixture?.session.phase == .preparing { fixture?.session.cancel() }
        }
        fixture.session.scan()
        try equal(fixture.driver.starts, 0)
        try equal(fixture.driver.shutdowns, 1)
        let scanning = Fixture()
        scanning.session.scan()
        scanning.session.onChange = { [weak scanning] in
            if scanning?.session.phase == .scanning { scanning?.session.cancel() }
        }
        scanning.driver.emit(.radio(.allowed, .poweredOn))
        try equal(scanning.driver.scans, 0)
    }

    private func interface() throws {
        let view = ProbeView(frame: NSRect(x: 0, y: 0, width: 620, height: 580))
        try expect(view.scanButton.isEnabled)
        try expect(!view.cancelButton.isEnabled)
        view.update(phase: .permissionPending, permission: .notDetermined, devices: [], limited: false)
        try expect(!view.scanButton.isEnabled)
        try expect(view.cancelButton.isEnabled)
        view.update(phase: .noResults, permission: .allowed, devices: [], limited: false)
        try expect(view.scanButton.isEnabled)
        try expect(!view.cancelButton.isEnabled)
    }

    public static func writePreview(to url: URL) throws {
        // A detached view render in the checks process: no app launch, window,
        // discovery driver, CBCentralManager or native permission request.
        let view = ProbeView(frame: NSRect(x: 0, y: 0, width: 620, height: 580))
        view.appearance = NSAppearance(named: .aqua)
        view.layoutSubtreeIfNeeded()
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
            throw CheckFailure(description: "Cannot allocate probe preview bitmap")
        }
        view.cacheDisplay(in: view.bounds, to: bitmap)
        guard let data = bitmap.representation(using: .png, properties: [:]) else {
            throw CheckFailure(description: "Cannot encode probe preview")
        }
        try data.write(to: url)
    }
}

@MainActor
private final class Fixture {
    var authorization: ProbePermission = .allowed
    var permissionReads = 0
    var driverCount = 0
    var driver = FakeProbeDriver()
    let clock = ManualProbeClock()
    lazy var session = ProbeSession(permission: { [unowned self] in
        self.permissionReads += 1
        return self.authorization
    }, driver: { [unowned self] in
        self.driverCount += 1
        self.driver = FakeProbeDriver()
        return self.driver
    }, scheduler: clock)
}

@MainActor
private final class FakeProbeDriver: ProbeDriver {
    var starts = 0
    var scans = 0
    var shutdowns = 0
    private var receive: (@MainActor (ProbeEvent) -> Void)?
    func start(_ receive: @escaping @MainActor (ProbeEvent) -> Void) {
        starts += 1
        self.receive = receive
    }
    func scan() { scans += 1 }
    func shutdown() { shutdowns += 1 }
    // Retain callbacks deliberately so tests can inject stale events.
    func emit(_ event: ProbeEvent) { receive?(event) }
}

@MainActor
private final class ManualProbeClock: ProbeScheduler {
    var items: [ManualProbeDeadline] = []
    func after(_ seconds: TimeInterval, perform: @escaping @MainActor () -> Void) -> any ProbeDeadline {
        let item = ManualProbeDeadline(seconds: seconds, perform: perform)
        items.append(item)
        return item
    }
    func fireLatest(evenIfCancelled: Bool = false) { items.last?.fire(evenIfCancelled: evenIfCancelled) }
}

@MainActor
private final class ManualProbeDeadline: ProbeDeadline {
    let seconds: TimeInterval
    let perform: @MainActor () -> Void
    var cancelled = false
    init(seconds: TimeInterval, perform: @escaping @MainActor () -> Void) {
        self.seconds = seconds
        self.perform = perform
    }
    func cancel() { cancelled = true }
    func fire(evenIfCancelled: Bool = false) {
        if !cancelled || evenIfCancelled { perform() }
    }
}
