import CardBehaviorChecks
import XCTest

final class CardRendererTests: XCTestCase {
    func testCardBehavior() {
        for check in CardChecks().cases {
            do { try check.run() }
            catch { XCTFail("\(check.name): \(error)") }
        }
    }
}
