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

    @MainActor
    func testIntegrationChecks() async {
        for check in IntegrationChecks().cases {
            do {
                try await check.run()
            } catch {
                XCTFail("\(check.name): \(error)")
            }
        }
    }
}
