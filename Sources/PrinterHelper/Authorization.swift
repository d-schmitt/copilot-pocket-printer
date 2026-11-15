import CoreBluetooth
import Foundation
import PrinterCLIKit

@MainActor
final class HelperAuthorization: NSObject, CBCentralManagerDelegate {
    private var manager: CBCentralManager?
    private var timer: Timer?
    private(set) var state = "not_requested"
    var changed: (() -> Void)?

    func request() {
        guard manager == nil else { return }
        do { try BluetoothPreflight.checkKnownHost() } catch {
            state = "host_blocked"; changed?(); return
        }
        switch CBCentralManager.authorization {
        case .denied: state = "denied"; changed?(); return
        case .restricted: state = "restricted"; changed?(); return
        case .notDetermined: state = "permission_pending"
        case .allowedAlways: state = "preparing"
        @unknown default: state = "unavailable"; changed?(); return
        }
        changed?()
        manager = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionShowPowerAlertKey: false])
        if state == "preparing" { deadline() }
    }

    private func deadline() {
        guard timer == nil else { return }
        let timer = Timer(timeInterval: 10, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.state == "preparing" else { return }
                self.stop(); self.state = "startup_timeout"; self.changed?()
            }
        }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    func stop() { timer?.invalidate(); timer = nil; manager?.delegate = nil; manager = nil }

    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        MainActor.assumeIsolated {
            guard central === manager else { return }
            switch CBCentralManager.authorization {
            case .denied: state = "denied"
            case .restricted: state = "restricted"
            case .notDetermined: state = "permission_pending"
            case .allowedAlways:
                switch central.state {
                case .poweredOn: state = "ready"
                case .poweredOff: state = "off"
                case .unsupported: state = "unsupported"
                case .unauthorized: state = "denied"
                case .unknown, .resetting: state = "preparing"
                @unknown default: state = "unavailable"
                }
            @unknown default: state = "unavailable"
            }
            if state == "preparing" { deadline() } else { timer?.invalidate(); timer = nil }
            changed?()
        }
    }
}
