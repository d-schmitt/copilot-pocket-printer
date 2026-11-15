import Foundation
import PrinterBehaviorChecks

var failures = 0
let checks = BehaviorChecks().cases
for check in checks {
    do {
        try check.run()
        print("PASS \(check.name)")
    } catch {
        failures += 1
        FileHandle.standardError.write(Data("FAIL \(check.name): \(error)\n".utf8))
    }
}
print("\(checks.count - failures)/\(checks.count) behavioral checks passed; no Bluetooth access.")
exit(failures == 0 ? 0 : 1)
