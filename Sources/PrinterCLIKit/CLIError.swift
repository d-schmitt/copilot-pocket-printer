import Foundation

public enum CLIError: Error, LocalizedError {
    case invalidInput(String)
    case image(String)
    case bluetoothDenied
    case bluetoothHostMissingDescription
    case bluetoothUnavailable(String)
    case printerMissing
    case printerAmbiguous([UUID])
    case paperApprovalRequired
    case connectionFailed(String)
    case transferStalled(String)
    case transferInterrupted(String)
    case statusUnverified(String)

    public var code: String {
        switch self {
        case .invalidInput: return "invalid_input"
        case .image: return "invalid_image"
        case .bluetoothDenied: return "bluetooth_denied"
        case .bluetoothHostMissingDescription: return "bluetooth_host_missing_description"
        case .bluetoothUnavailable: return "bluetooth_unavailable"
        case .printerMissing: return "printer_missing_or_offline"
        case .printerAmbiguous: return "printer_ambiguous"
        case .paperApprovalRequired: return "paper_approval_required"
        case .connectionFailed: return "connection_failed"
        case .transferStalled: return "transfer_stalled"
        case .transferInterrupted: return "transfer_interrupted"
        case .statusUnverified: return "status_unverified"
        }
    }

    public var exitCode: Int32 {
        switch self {
        case .invalidInput, .image: return 2
        case .bluetoothDenied, .bluetoothHostMissingDescription, .bluetoothUnavailable: return 3
        case .printerMissing: return 4
        case .printerAmbiguous: return 5
        case .paperApprovalRequired: return 6
        case .connectionFailed: return 7
        case .transferStalled: return 8
        case .transferInterrupted: return 9
        case .statusUnverified: return 10
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
        case .paperApprovalRequired:
            return """
            No Bluetooth access or paper movement was attempted. Obtain explicit user approval \
            for this one physical operation, then supply --device <uuid> --confirm-paper. \
            Do not repeat a failed or partial print automatically. Use --dry-run for offline validation.
            """
        case .connectionFailed(let detail):
            return "Connection failed: \(detail). No automatic reconnect."
        case .transferStalled(let detail):
            return "Transfer stalled: \(detail). Pending work cancelled; paper output may be partial. Do not automatically retry."
        case .transferInterrupted(let detail):
            return "Transfer interrupted: \(detail). Paper output may be partial. Do not automatically retry."
        case .statusUnverified(let detail):
            return "No model, firmware or solicited paper value was decoded in the observation window; battery alone does not verify our queries.\n\(detail)"
        }
    }
}
