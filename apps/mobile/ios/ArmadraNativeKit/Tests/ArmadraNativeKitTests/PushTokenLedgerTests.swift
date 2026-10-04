import ArmadraNativeKit
import XCTest

final class PushTokenLedgerTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "dev.armadra.mobile.tests.ledger"

    override func setUp() {
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    func testNothingRotatesBeforeTheFirstRegistration() {
        let ledger = PushTokenLedger(defaults: defaults)
        XCTAssertFalse(ledger.registered)
        XCTAssertFalse(ledger.observe(token: "aa"))
        XCTAssertFalse(ledger.rotated)
    }

    func testADifferentTokenAfterRegistrationIsARotationUntilAcknowledged() {
        let ledger = PushTokenLedger(defaults: defaults)
        ledger.didRegister(token: "aa")
        XCTAssertTrue(ledger.registered)
        XCTAssertFalse(ledger.observe(token: "aa"))
        XCTAssertFalse(ledger.rotated)
        XCTAssertTrue(ledger.observe(token: "bb"))
        XCTAssertTrue(ledger.rotated)
        // 同一次换过只报一次事件，标记留着直到页面重新登记。
        XCTAssertFalse(ledger.observe(token: "bb"))
        XCTAssertTrue(PushTokenLedger(defaults: defaults).rotated)
        ledger.didRegister(token: "bb")
        XCTAssertFalse(ledger.rotated)
        ledger.observe(token: "cc")
        ledger.acknowledge()
        XCTAssertFalse(ledger.rotated)
    }
}
