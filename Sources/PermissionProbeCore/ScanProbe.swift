import Foundation

public enum ProbePermission: String {
    case notDetermined = "Not requested / pending"
    case allowed = "Allowed by macOS"
    case denied = "Denied"
    case restricted = "Restricted"
    case unknown = "Unknown authorization"
}

public enum ProbeRadio {
    case unknown, resetting, poweredOff, unsupported, unauthorized, poweredOn
}

public struct ProbeDevice: Equatable {
    public let id: UUID
    public let name: String
    public let rssi: Int

    public init(id: UUID, name: String, rssi: Int) {
        self.id = id
        self.name = name
        self.rssi = rssi
    }
}

public enum ProbeEvent {
    case radio(ProbePermission, ProbeRadio)
    case discovered(ProbeDevice)
}

public enum ProbePhase: Equatable {
    case idle, permissionPending, preparing, scanning
    case complete, noResults, cancelled, closed
    case denied, restricted, bluetoothOff, unsupported, unavailable, startupTimedOut

    public var isActive: Bool {
        self == .permissionPending || self == .preparing || self == .scanning
    }

    public var title: String {
        switch self {
        case .idle: return "Ready for your scan"
        case .permissionPending: return "Waiting for native Bluetooth permission"
        case .preparing: return "Waiting for the Bluetooth controller"
        case .scanning: return "Scanning for 8 seconds"
        case .complete: return "Scan finished: printer advertisements found"
        case .noResults: return "Scan timed out: no matching advertisement"
        case .cancelled: return "Scan cancelled"
        case .closed: return "Probe closed"
        case .denied: return "Bluetooth permission denied"
        case .restricted: return "Bluetooth permission restricted"
        case .bluetoothOff: return "Bluetooth is off"
        case .unsupported: return "Bluetooth Low Energy is unsupported"
        case .unavailable: return "Bluetooth state is unavailable"
        case .startupTimedOut: return "Bluetooth startup timed out"
        }
    }

    public var detail: String {
        switch self {
        case .idle:
            return "Bluetooth is not initialized until you press Scan. Opened from Finder, this app should request its own permission; attribution is not yet proven."
        case .permissionPending:
            return "Respond to the ordinary macOS prompt only if it names Pocket Printer Probe. If it names GitHub Copilot or another app, stop and report it. There is no deadline on your permission decision."
        case .preparing:
            return "Permission is known. Controller startup is bounded to 10 seconds; it is not a printer discovery result."
        case .scanning:
            return "Looking only for Mini Pocket Printer_BLE advertisements. No connection, query, feed or print is possible in this probe."
        case .complete:
            return "Discovery is not model verification or print readiness. Radio resources are released. Another scan requires pressing Scan again."
        case .noResults:
            return "No matching name was advertised during the window. The printer may be off, out of range, connected elsewhere or differently named. No automatic retry."
        case .cancelled, .closed:
            return "Timer cancelled and Bluetooth resources released. No background scan or retry continues."
        case .denied:
            return "Access was denied. Do not reset permissions or bypass the refusal. Report the prompt name and this state."
        case .restricted:
            return "macOS reports a restricted authorization, possibly managed policy. Do not attempt to bypass it."
        case .bluetoothOff:
            return "Enable Bluetooth yourself if appropriate, then explicitly press Scan. The probe does not change system settings."
        case .unsupported:
            return "This controller does not support the required Bluetooth capability. No scan was started."
        case .unavailable:
            return "Authorization or controller state is unknown, or changed during scanning. No retry occurs; report this state."
        case .startupTimedOut:
            return "An authorized controller did not become ready within 10 seconds. This is not printer unavailable and not a permission-prompt timeout."
        }
    }
}

@MainActor
public protocol ProbeDriver: AnyObject {
    func start(_ receive: @escaping @MainActor (ProbeEvent) -> Void)
    func scan()
    func shutdown()
}

@MainActor
public protocol ProbeDeadline: AnyObject {
    func cancel()
}

@MainActor
public protocol ProbeScheduler {
    func after(_ seconds: TimeInterval, perform: @escaping @MainActor () -> Void) -> any ProbeDeadline
}

@MainActor
public final class ProbeSession {
    public private(set) var phase: ProbePhase = .idle
    public private(set) var permission: ProbePermission = .notDetermined
    public private(set) var devices: [ProbeDevice] = []
    public private(set) var resultLimitReached = false
    public var onChange: (@MainActor () -> Void)?

    private let currentPermission: @MainActor () -> ProbePermission
    private let makeDriver: @MainActor () -> any ProbeDriver
    private let scheduler: any ProbeScheduler
    private var driver: (any ProbeDriver)?
    private var deadline: (any ProbeDeadline)?
    private var deadlineID: UUID?
    private var generation: UUID?

    public init(
        permission: @escaping @MainActor () -> ProbePermission,
        driver: @escaping @MainActor () -> any ProbeDriver,
        scheduler: any ProbeScheduler
    ) {
        currentPermission = permission
        makeDriver = driver
        self.scheduler = scheduler
    }

    public func scan() {
        guard !phase.isActive, phase != .closed else { return }
        devices = []
        resultLimitReached = false
        permission = currentPermission()
        if let terminal = permissionFailure {
            finish(terminal)
            return
        }
        let token = UUID()
        generation = token
        driver = makeDriver()
        phase = permission == .notDetermined ? .permissionPending : .preparing
        if phase == .preparing { armStartup(token) }
        onChange?()
        guard generation == token else { return }
        driver?.start { [weak self] event in self?.receive(event, token: token) }
    }

    public func cancel() {
        guard phase.isActive else { return }
        finish(.cancelled)
    }

    public func close() { finish(.closed) }

    private var permissionFailure: ProbePhase? {
        switch permission {
        case .denied: return .denied
        case .restricted: return .restricted
        case .unknown: return .unavailable
        case .notDetermined, .allowed: return nil
        }
    }

    private func receive(_ event: ProbeEvent, token: UUID) {
        guard generation == token else { return }
        switch event {
        case .radio(let authorization, let radio):
            permission = authorization
            if let failure = permissionFailure {
                finish(failure)
                return
            }
            if permission == .notDetermined {
                guard phase != .scanning else { finish(.unavailable); return }
                cancelDeadline()
                phase = .permissionPending
                onChange?()
                return
            }
            switch radio {
            case .poweredOn:
                guard phase != .scanning else { return }
                phase = .scanning
                armDeadline(8, token: token) {
                    $0.finish($0.devices.isEmpty ? .noResults : .complete)
                }
                onChange?()
                guard generation == token else { return }
                driver?.scan()
            case .poweredOff: finish(.bluetoothOff)
            case .unsupported: finish(.unsupported)
            case .unauthorized: finish(.unavailable)
            case .unknown, .resetting:
                guard phase != .scanning else { finish(.unavailable); return }
                phase = .preparing
                if deadline == nil { armStartup(token) }
                onChange?()
            }
        case .discovered(let device):
            guard phase == .scanning, device.name == "Mini Pocket Printer_BLE" else { return }
            if let index = devices.firstIndex(where: { $0.id == device.id }) {
                devices[index] = device
            } else if devices.count < 32 {
                devices.append(device)
            } else {
                resultLimitReached = true
            }
            devices.sort { $0.id.uuidString < $1.id.uuidString }
            onChange?()
        }
    }

    private func armStartup(_ token: UUID) {
        armDeadline(10, token: token) { $0.finish(.startupTimedOut) }
    }

    private func armDeadline(_ seconds: TimeInterval, token: UUID, action: @escaping @MainActor (ProbeSession) -> Void) {
        cancelDeadline()
        let id = UUID()
        deadlineID = id
        deadline = scheduler.after(seconds) { [weak self] in
            guard let self, self.generation == token, self.deadlineID == id else { return }
            action(self)
        }
    }

    private func cancelDeadline() {
        deadlineID = nil
        deadline?.cancel()
        deadline = nil
    }

    private func finish(_ state: ProbePhase) {
        // Invalidate first: a late timer/delegate event must not revive this scan.
        generation = nil
        cancelDeadline()
        driver?.shutdown()
        driver = nil
        phase = state
        onChange?()
    }
}

@MainActor
public struct ProbeTimerScheduler: ProbeScheduler {
    public init() {}
    public func after(_ seconds: TimeInterval, perform: @escaping @MainActor () -> Void) -> any ProbeDeadline {
        TimerDeadline(seconds: seconds, perform: perform)
    }
}

@MainActor
private final class TimerDeadline: ProbeDeadline {
    private var timer: Timer?
    init(seconds: TimeInterval, perform: @escaping @MainActor () -> Void) {
        let timer = Timer(timeInterval: seconds, repeats: false) { _ in
            MainActor.assumeIsolated { perform() }
        }
        self.timer = timer
        // Menu tracking must not suspend the scan deadline.
        RunLoop.main.add(timer, forMode: .common)
    }
    func cancel() { timer?.invalidate(); timer = nil }
}
