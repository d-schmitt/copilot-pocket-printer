import PrinterBehaviorChecks
import XCTest

final class PrinterCLIKitTests: XCTestCase {
    func testBehaviorChecks() {
        for check in BehaviorChecks().cases {
            do {
                try check.run()
            } catch {
                XCTFail("\(check.name): \(error)")
            }
        }
    }
}
