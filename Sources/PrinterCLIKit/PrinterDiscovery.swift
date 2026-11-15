import Foundation
import PocketPrinter5890BLE

public enum PrinterSelection {
    public static func choose(_ devices: [PrinterDevice], id: UUID?) throws -> PrinterDevice {
        let matches = devices.filter { device in
            if let id { return device.id == id }
            return device.name == "Mini Pocket Printer_BLE"
        }
        guard !matches.isEmpty else { throw CLIError.printerMissing }
        guard matches.count == 1 else { throw CLIError.printerAmbiguous(matches.map(\.id)) }
        return matches[0]
    }
}
