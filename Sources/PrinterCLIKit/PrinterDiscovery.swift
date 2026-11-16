import Foundation
import PocketPrinter5890BLE

public struct DiscoveredPrinter: Codable, Equatable, Sendable {
    public let id: UUID
    public let name: String
    public let rssi: Int?
    public init(id: UUID, name: String, rssi: Int?) {
        self.id = id; self.name = name; self.rssi = rssi
    }
}

public enum PrinterSelection {
    public static let advertisedName = "Mini Pocket Printer_BLE"
    public static func choose(_ devices: [PrinterDevice], id: UUID?) throws -> PrinterDevice {
        let matches = devices.filter { device in
            if let id { return device.id == id }
            return device.name == advertisedName
        }
        guard !matches.isEmpty else { throw CLIError.printerMissing }
        guard matches.count == 1 else { throw CLIError.printerAmbiguous(matches.map(\.id)) }
        return matches[0]
    }
}
