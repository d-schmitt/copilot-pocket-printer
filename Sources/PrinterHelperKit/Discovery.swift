import Foundation
import PrinterCLIKit

public struct DiscoverySnapshot: Codable, Sendable {
    public var scan_id: UUID?
    public var state: String
    public var devices: [DiscoveredPrinter]
    public var message: String
    public var error_code: String?
}

@MainActor
public final class HelperDiscovery {
    public typealias Scanner = @MainActor (@escaping @MainActor ([DiscoveredPrinter]) -> Void) async throws -> Void
    public private(set) var snapshot = DiscoverySnapshot(state: "idle", devices: [], message: "Choose Scan to find advertised compatible printers.")
    public var running: Bool { task != nil }
    private let scanner: Scanner
    private let timeout: UInt64
    private var task: Task<Void, Never>?
    private var deadline: Task<Void, Never>?

    public init(timeout: UInt64 = 10_000_000_000, scanner: @escaping Scanner) {
        self.timeout = timeout; self.scanner = scanner
    }

    public func start(id: UUID, bluetooth: String) throws -> DiscoverySnapshot {
        if snapshot.scan_id == id { return snapshot }
        guard !running else { throw HelperFailure("discovery_busy", "Another scan is running. Stop it or wait for it to finish.") }
        snapshot = DiscoverySnapshot(scan_id: id, state: "scanning", devices: [], message: "Scanning for up to 10 seconds. No connection or printing.")
        guard bluetooth == "ready" else {
            snapshot.state = ["not_requested", "permission_pending", "denied", "restricted"].contains(bluetooth) ? "permission_required" : "unavailable"
            snapshot.error_code = "bluetooth_\(bluetooth)"
            snapshot.message = "Bluetooth is \(bluetooth). Use the helper's Enable Bluetooth control or macOS Bluetooth settings, then scan again."
            return snapshot
        }
        task = Task { [weak self, scanner] in
            do {
                try await scanner { [weak self] values in
                    guard let self, self.snapshot.scan_id == id, self.snapshot.state == "scanning" else { return }
                    var seen = Set<UUID>()
                    self.snapshot.devices = Array(values.filter {
                        $0.name == PrinterSelection.advertisedName && seen.insert($0.id).inserted
                    }.prefix(32))
                }
                self?.finish(id: id)
            } catch is CancellationError {
                self?.finish(id: id)
            } catch {
                self?.finish(id: id, error: error)
            }
        }
        deadline = Task { [weak self, timeout] in
            do { try await Task.sleep(nanoseconds: timeout) } catch { return }
            self?.cancel(message: "Scan time limit reached.")
        }
        return snapshot
    }

    public func status(id: UUID) throws -> DiscoverySnapshot {
        guard snapshot.scan_id == id else { throw HelperFailure("unknown_scan", "This scan is no longer available. Start a new scan explicitly.") }
        return snapshot
    }

    public func stop(id: UUID) throws -> DiscoverySnapshot {
        _ = try status(id: id)
        cancel(message: "Scan stopped.")
        return snapshot
    }

    public func shutdown() { cancel(message: "Helper closed; scan stopped.") }

    private func cancel(message: String) {
        guard running else { return }
        snapshot.state = "stopping"; snapshot.message = message
        task?.cancel()
    }

    private func finish(id: UUID, error: Error? = nil) {
        guard snapshot.scan_id == id else { return }
        deadline?.cancel(); deadline = nil; task = nil
        if let error {
            let code = (error as? CLIError)?.code ?? "discovery_failed"
            snapshot.state = code == "bluetooth_denied" ? "permission_required" :
                code == "bluetooth_unavailable" ? "unavailable" : "error"
            snapshot.error_code = code
            snapshot.message = "Scan failed. Check Bluetooth permissions and the helper, then scan again."
        } else {
            snapshot.state = "stopped"
            snapshot.message = snapshot.devices.isEmpty ? "No compatible printer advertisement was seen. Check power and range, then scan again." :
                "Scan stopped. Select your printer; nothing is selected or printed automatically."
        }
    }
}
