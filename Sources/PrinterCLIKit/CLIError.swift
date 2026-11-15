import Foundation

public enum CLIError: Error, LocalizedError {
    case invalidInput(String)
    case image(String)
    case bluetoothDenied
    case bluetoothHostMissingDescription
    case bluetoothUnavailable(String)
    case printerMissing
    case printerAmbiguous([UUID])
    case transportBlocked

    public var code: String {
        switch self {
        case .invalidInput: return "invalid_input"
        case .image: return "invalid_image"
        case .bluetoothDenied: return "bluetooth_denied"
        case .bluetoothHostMissingDescription: return "bluetooth_host_missing_description"
        case .bluetoothUnavailable: return "bluetooth_unavailable"
        case .printerMissing: return "printer_missing_or_offline"
        case .printerAmbiguous: return "printer_ambiguous"
        case .transportBlocked: return "upstream_transport_blocked"
        }
    }

    public var exitCode: Int32 {
        switch self {
        case .invalidInput, .image: return 2
        case .bluetoothDenied, .bluetoothHostMissingDescription, .bluetoothUnavailable: return 3
        case .printerMissing: return 4
        case .printerAmbiguous: return 5
        case .transportBlocked: return 6
        }
    }

    public var errorDescription: String? {
        switch self {
        case .invalidInput(let message), .image(let message):
            return message
        case .bluetoothDenied:
            return """
            Bluetooth access is denied or restricted. In System Settings > Privacy & Security > \
            Bluetooth, allow the exact responsible application named by the macOS prompt. \
            A managed restriction may require your administrator. Do not reset TCC.
            """
        case .bluetoothHostMissingDescription:
            return """
            GitHub Copilot (com.github.githubapp) is the observed responsible Bluetooth host, \
            but its installed app lacks NSBluetoothAlwaysUsageDescription. macOS cannot \
            present a valid approval prompt and would terminate this CLI. Status stopped \
            before CoreBluetooth initialization. The app needs an owner-supplied fix; \
            do not edit its signed bundle, reset TCC, or remove the host marker to bypass this.
            """
        case .bluetoothUnavailable(let reason):
            return "Bluetooth unavailable: \(reason)"
        case .printerMissing:
            return """
            No matching printer advertisement was seen within the scan window. \
            It may be off, out of range, connected elsewhere, or advertising another name. \
            This scan cannot distinguish those causes.
            """
        case .printerAmbiguous(let identifiers):
            return """
            Multiple matching printers were found. Repeat status with --device and one UUID: \
            \(identifiers.map(\.uuidString).sorted().joined(separator: ", "))
            """
        case .transportBlocked:
            return """
            Actual print/feed are disabled for upstream revision 20118975. Raster tails can \
            bypass credits and notification readiness is not exposed. No Bluetooth access \
            or paper movement was attempted. Use --dry-run for offline validation. \
            See README hardware blocker; do not remove this guard without a reviewed fix.
            """
        }
    }
}
