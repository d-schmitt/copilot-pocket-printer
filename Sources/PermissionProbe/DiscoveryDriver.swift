import CoreBluetooth
import Foundation
import PermissionProbeCore

@MainActor
final class DiscoveryDriver: NSObject, ProbeDriver, CBCentralManagerDelegate {
    private var central: CBCentralManager?
    private var receive: (@MainActor (ProbeEvent) -> Void)?
    private var scanning = false

    static var permission: ProbePermission {
        switch CBCentralManager.authorization {
        case .notDetermined: return .notDetermined
        case .allowedAlways: return .allowed
        case .denied: return .denied
        case .restricted: return .restricted
        @unknown default: return .unknown
        }
    }

    func start(_ receive: @escaping @MainActor (ProbeEvent) -> Void) {
        guard central == nil else { return }
        self.receive = receive
        // Only ProbeSession.scan(), reached by an explicit button, calls start.
        central = CBCentralManager(delegate: self, queue: .main, options: [
            CBCentralManagerOptionShowPowerAlertKey: false
        ])
    }

    func scan() {
        guard let central, central.state == .poweredOn, !scanning else { return }
        scanning = true
        central.scanForPeripherals(withServices: nil, options: [
            CBCentralManagerScanOptionAllowDuplicatesKey: false
        ])
    }

    func shutdown() {
        scanning = false
        receive = nil
        central?.stopScan()
        central?.delegate = nil
        central = nil
    }

    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        MainActor.assumeIsolated {
            guard central === self.central else { return }
            let radio: ProbeRadio
            switch central.state {
            case .unknown: radio = .unknown
            case .resetting: radio = .resetting
            case .poweredOff: radio = .poweredOff
            case .unsupported: radio = .unsupported
            case .unauthorized: radio = .unauthorized
            case .poweredOn: radio = .poweredOn
            @unknown default: radio = .unknown
            }
            receive?(.radio(Self.permission, radio))
        }
    }

    nonisolated func centralManager(
        _ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any], rssi RSSI: NSNumber
    ) {
        MainActor.assumeIsolated {
            guard central === self.central, scanning else { return }
            let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? peripheral.name ?? ""
            guard name == "Mini Pocket Printer_BLE" else { return }
            receive?(.discovered(ProbeDevice(id: peripheral.identifier, name: name, rssi: RSSI.intValue)))
        }
    }
}
