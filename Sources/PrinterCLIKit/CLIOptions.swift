import Foundation

public struct CLIOptions: Equatable {
    public enum Command: Equatable {
        case help
        case printPNG(String)
        case feed(Int)
        case status
        case testPattern(String)
    }

    public let command: Command
    public let dryRun: Bool
    public let device: UUID?
    public let timeout: TimeInterval
    public let connect: Bool
    public let confirmPaper: Bool

    public static let usage = """
    Usage:
      printer-cli print <png> [--dry-run | --device <uuid> --confirm-paper]
      printer-cli feed [dots] [--dry-run | --device <uuid> --confirm-paper]
      printer-cli status [--device <uuid>] [--connect] [--timeout <seconds>]
      printer-cli test-pattern <png>
      printer-cli --help

    PNGs must be 384 pixels wide, 1...4096 pixels high, and single-frame.
    Feed defaults to 80 dots; allowed range is 1...255.
    Status scans only unless --connect is supplied with an explicit --device.
    --connect confirms FF00/FF02 and FF01+FF03 notifications, then queries
    model, firmware, battery and paper using activation/wake/stop writes.
    No feed, raster or settings writes are requested.
    --device selects an exact advertised UUID; otherwise the exact name
    "Mini Pocket Printer_BLE" must identify one printer, not several.
    --timeout is 1...30 seconds for each scan/connection phase (default: 8).
    Bluetooth startup is capped at 5 seconds. Transfers: 120 seconds total,
    10 seconds without progress. Reply collection and disconnect: 2 seconds each.
    --dry-run validates and assembles a job without accessing Bluetooth.
    Physical operations require separate user approval and --confirm-paper.
    SUBMITTED ONLY means local CoreBluetooth submission, not paper completion.
    No automatic retries or reconnects, including after a partial transfer.
    """

    public static func parse(_ arguments: [String]) throws -> CLIOptions {
        if arguments.isEmpty || arguments == ["--help"] || arguments == ["help"] {
            return CLIOptions(command: .help, dryRun: false, device: nil, timeout: 8, connect: false, confirmPaper: false)
        }
        let verb = arguments[0]
        var positionals: [String] = []
        var dryRun = false
        var device: UUID?
        var timeout: TimeInterval = 8
        var connect = false
        var confirmPaper = false
        var seen = Set<String>()
        var index = 1
        while index < arguments.count {
            let argument = arguments[index]
            if argument.hasPrefix("--") {
                guard seen.insert(argument).inserted else {
                    throw CLIError.invalidInput("Duplicate option: \(argument)")
                }
                switch argument {
                case "--dry-run" where verb == "print" || verb == "feed":
                    dryRun = true
                case "--connect" where verb == "status":
                    connect = true
                case "--confirm-paper" where verb == "print" || verb == "feed":
                    confirmPaper = true
                case "--device" where ["status", "print", "feed"].contains(verb):
                    index += 1
                    guard index < arguments.count, let value = UUID(uuidString: arguments[index]) else {
                        throw CLIError.invalidInput("--device requires a UUID.")
                    }
                    device = value
                case "--timeout" where ["status", "print", "feed"].contains(verb):
                    index += 1
                    guard index < arguments.count, let value = Double(arguments[index]),
                          value.isFinite, (1...30).contains(value) else {
                        throw CLIError.invalidInput("--timeout must be 1...30 seconds.")
                    }
                    timeout = value
                default:
                    throw CLIError.invalidInput("Unknown or inapplicable option: \(argument)")
                }
            } else {
                positionals.append(argument)
            }
            index += 1
        }

        let command: Command
        switch verb {
        case "print" where positionals.count == 1:
            command = .printPNG(positionals[0])
        case "feed" where positionals.count <= 1:
            guard let dots = Int(positionals.first ?? "80"), (1...255).contains(dots) else {
                throw CLIError.invalidInput("Feed must be 1...255 dots.")
            }
            command = .feed(dots)
        case "status" where positionals.isEmpty:
            command = .status
        case "test-pattern" where positionals.count == 1:
            command = .testPattern(positionals[0])
        default:
            throw CLIError.invalidInput("Invalid command or arguments. Use printer-cli --help.")
        }
        guard !connect || device != nil else {
            throw CLIError.invalidInput("--connect requires an explicit --device UUID.")
        }
        guard !dryRun || !confirmPaper else {
            throw CLIError.invalidInput("--dry-run and --confirm-paper cannot be combined.")
        }
        return CLIOptions(command: command, dryRun: dryRun, device: device, timeout: timeout, connect: connect, confirmPaper: confirmPaper)
    }

    public func requirePaperApproval() throws {
        guard confirmPaper, device != nil else { throw CLIError.paperApprovalRequired }
    }
}
