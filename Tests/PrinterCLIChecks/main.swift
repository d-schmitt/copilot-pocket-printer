import Foundation
import PrinterBehaviorChecks

@main
struct PrinterCLIChecks {
    @MainActor
    static func main() async {
        var failures = 0
        let checks = BehaviorChecks().cases
        let integrationChecks = IntegrationChecks().cases
        let probeChecks = ProbeChecks().cases
        for check in checks {
            do {
                try check.run()
                print("PASS \(check.name)")
            } catch {
                failures += 1
                FileHandle.standardError.write(Data("FAIL \(check.name): \(error)\n".utf8))
            }
        }
        for check in integrationChecks {
            do {
                try await check.run()
                print("PASS \(check.name)")
            } catch {
                failures += 1
                FileHandle.standardError.write(Data("FAIL \(check.name): \(error)\n".utf8))
            }
        }
        for check in probeChecks {
            do {
                try check.run()
                print("PASS \(check.name)")
            } catch {
                failures += 1
                FileHandle.standardError.write(Data("FAIL \(check.name): \(error)\n".utf8))
            }
        }
        var previewFailed = false
        if CommandLine.arguments.count > 1 {
            do {
                guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--probe-preview" else {
                    throw NSError(domain: "PrinterCLIChecks", code: 2,
                                  userInfo: [NSLocalizedDescriptionKey: "Usage: printer-cli-checks [--probe-preview output.png]"])
                }
                try ProbeChecks.writePreview(to: URL(fileURLWithPath: CommandLine.arguments[2]))
            } catch {
                previewFailed = true
                FileHandle.standardError.write(Data("FAIL preview: \(error)\n".utf8))
            }
        }
        let total = checks.count + integrationChecks.count + probeChecks.count
        print("\(total - failures)/\(total) behavioral checks passed; no Bluetooth access.")
        exit(failures == 0 && !previewFailed ? 0 : 1)
    }
}
