import Combine
import CoreBluetooth
import Foundation
import PocketPrinter5890BLE
import PocketPrinter5890Kit

public struct DeviceReadings {
    public var model: String?
    public var firmware: String?
    public var battery: Int?
    public var paper: UInt8?

    public init(model: String? = nil, firmware: String? = nil, battery: Int? = nil, paper: UInt8? = nil) {
        self.model = model
        self.firmware = firmware
        self.battery = battery
        self.paper = paper
    }

    public var hasQueryEvidence: Bool { model != nil || firmware != nil || paper != nil }

    public var summary: String {
        """
        Model: \(model.map(ASCIIText.transliterate) ?? "unknown")
        Firmware: \(firmware.map(ASCIIText.transliterate) ?? "unknown")
        Battery: \(battery.map { "\($0)%" } ?? "unknown")
        Paper reply: \(paper.map { String(format: "0x%02X (raw, informational)", $0) } ?? "unknown")
        Battery may come from an unsolicited notification or the library's automatic query.
        Unknown means no decoded value. Sensor meanings and physical readiness are not verified.
        """
    }
}

@MainActor
public protocol PrinterLink: AnyObject {
    var connectionEvents: AnyPublisher<BLEConnectionState, Never> { get }
    var writeEvents: AnyPublisher<BLEWriteState, Never> { get }
    var bluetoothReady: Bool { get }
    var permissionDenied: Bool { get }
    var devices: [PrinterDevice] { get }
    var hasRequiredProfile: Bool { get }
    var readings: DeviceReadings { get }
    func startScan()
    func stopScan()
    func connect(to device: PrinterDevice)
    func disconnect()
    func send(_ segments: [PrintSegment])
}

extension PocketPrinter5890BLE: PrinterLink {
    public var connectionEvents: AnyPublisher<BLEConnectionState, Never> { $connectionState.eraseToAnyPublisher() }
    public var writeEvents: AnyPublisher<BLEWriteState, Never> { $writeState.eraseToAnyPublisher() }
    // Upstream still exposes controller startup only as text; lifecycle after
    // startup uses its typed connection/write states, never localized messages.
    public var bluetoothReady: Bool { stateText == "Pret a rechercher" }
    public var permissionDenied: Bool {
        CBCentralManager.authorization == .denied || CBCentralManager.authorization == .restricted
    }
    public var hasRequiredProfile: Bool {
        selectedService == "FF00" && selectedRX == "FF02" && selectedTX == "FF01"
            && Set(selectedNotify.components(separatedBy: " + ")) == Set(["FF01", "FF03"])
    }
    public var readings: DeviceReadings {
        DeviceReadings(model: deviceModel, firmware: deviceFirmware, battery: batteryPercent, paper: printerStatus?.raw)
    }
}
