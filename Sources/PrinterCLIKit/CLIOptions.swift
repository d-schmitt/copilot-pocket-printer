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

    public static let usage = """
    Usage:
      printer-cli print <png> [--dry-run]
      printer-cli feed [dots] [--dry-run]
      printer-cli status [--device <uuid>] [--timeout <seconds>]
      printer-cli test-pattern <png>
      printer-cli --help

    PNGs must be 384 pixels wide, 1...4096 pixels high, and single-frame.
    Feed defaults to 80 dots; allowed range is 1...255.
    Status scans only, never connects or sends commands (default: 8 seconds).
    --device selects an exact advertised UUID; otherwise the exact name
    "Mini Pocket Printer_BLE" must identify one printer, not several.
    --timeout is 1...30 seconds, plus at most 5 seconds for Bluetooth startup.
    --dry-run validates and assembles a job without accessing Bluetooth.
    Actual print/feed are BLOCKED on the pinned upstream transport defects.
    A successful dry run is not a hardware print. No automatic retries.
    """

    public static func parse(_ arguments: [String]) throws -> CLIOptions {
        if arguments.isEmpty || arguments == ["--help"] || arguments == ["help"] {
            return CLIOptions(command: .help, dryRun: false, device: nil, timeout: 8)
        }
        let verb = arguments[0]
        var positionals: [String] = []
        var dryRun = false
        var device: UUID?
        var timeout: TimeInterval = 8
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
                case "--device" where verb == "status":
                    index += 1
                    guard index < arguments.count, let value = UUID(uuidString: arguments[index]) else {
                        throw CLIError.invalidInput("--device requires a UUID.")
                    }
                    device = value
                case "--timeout" where verb == "status":
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
        return CLIOptions(command: command, dryRun: dryRun, device: device, timeout: timeout)
    }
}
