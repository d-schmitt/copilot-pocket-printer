import Foundation
import PrinterBehaviorChecks

@main
struct PrinterCLIChecks {
    @MainActor
    static func main() async {
        var failures = 0
        let checks = BehaviorChecks().cases
        let integrationChecks = IntegrationChecks().cases
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
        let total = checks.count + integrationChecks.count
        print("\(total - failures)/\(total) behavioral checks passed; no Bluetooth access.")
        exit(failures == 0 ? 0 : 1)
    }
}
