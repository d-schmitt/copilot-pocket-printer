import CoreBluetooth
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

@MainActor
public enum PrinterDiscovery {
    public static func status(deviceID: UUID?, timeout: TimeInterval) async throws -> String {
        try BluetoothPreflight.checkKnownHost()
        if CBCentralManager.authorization == .denied || CBCentralManager.authorization == .restricted {
            throw CLIError.bluetoothDenied
        }
        let transport = PocketPrinter5890BLE()
        // Scan only. connect() would trigger upstream's automatic battery writes.
        transport.showOnlyLikelyPrinters = false
        defer { transport.stopScan() }
        let startupDeadline = ProcessInfo.processInfo.systemUptime + 5
        while transport.stateText != "Pret a rechercher" {
            try checkBluetooth(transport)
            guard ProcessInfo.processInfo.systemUptime < startupDeadline else {
                throw CLIError.bluetoothUnavailable("Startup or permission prompt did not resolve within 5 seconds. Approve the native prompt if shown, then explicitly retry status.")
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        transport.startScan()
        let scanDeadline = ProcessInfo.processInfo.systemUptime + timeout
        // Wait the full window so a second matching printer is not silently ignored.
        while ProcessInfo.processInfo.systemUptime < scanDeadline {
            try checkBluetooth(transport)
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        transport.stopScan()
        let selected = try PrinterSelection.choose(transport.devices, id: deviceID)
        return """
        DISCOVERED ONLY: \(ASCIIText.transliterate(selected.name))
        Device: \(selected.id.uuidString)
        Signal: \(selected.rssi) dBm
        No connection or command writes. Battery, paper, model, firmware and print readiness are unknown.
        """
    }

    private static func checkBluetooth(_ transport: PocketPrinter5890BLE) throws {
        if CBCentralManager.authorization == .denied || CBCentralManager.authorization == .restricted {
            throw CLIError.bluetoothDenied
        }
        // Pinned upstream exposes localized state text, not CBManagerState.
        // Keep these exact mappings tied to the reviewed dependency revision.
        switch transport.stateText {
        case "Autorisation Bluetooth refusee":
            throw CLIError.bluetoothDenied
        case "Bluetooth desactive":
            throw CLIError.bluetoothUnavailable("Bluetooth is powered off. Enable it in System Settings > Bluetooth.")
        case "Bluetooth non pris en charge":
            throw CLIError.bluetoothUnavailable("This host does not support Bluetooth Low Energy.")
        case "Bluetooth indisponible":
            throw CLIError.bluetoothUnavailable("The Bluetooth controller is resetting or unavailable.")
        default:
            break
        }
    }
}
