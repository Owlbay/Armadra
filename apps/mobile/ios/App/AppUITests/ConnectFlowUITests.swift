import XCTest

/// B 档 UI 用例「连接 → 配对 → 画布」（补全计划 G3-1），由
/// `tools/probes/mobile-shell-e2e.mjs` 驱动：探针起 core、在回环上开 Gateway（模拟器与
/// 宿主共用回环），把原生深链 `armadra://pair?host=…&ticket=…&fp=…` 经
/// `TEST_RUNNER_ARMADRA_PAIR_LINK` 交进来。页面在 WKWebView 里，按无障碍树找输入框与按钮；
/// 文案中英都认（模拟器的语言不定）。
final class ConnectFlowUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func button(_ app: XCUIApplication, _ labels: [String]) -> XCUIElement {
        app.webViews.buttons.matching(NSPredicate(format: "label IN %@", labels)).firstMatch
    }

    func testWithoutAGatewayTheAppOpensOnTheConnectScreen() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.webViews.textFields.firstMatch.waitForExistence(timeout: 60), "connect screen")
        XCTAssertTrue(button(app, ["连接", "Connect"]).exists)
    }

    func testPairsThroughThePinnedGatewayAndOpensTheCanvas() throws {
        guard let link = ProcessInfo.processInfo.environment["ARMADRA_PAIR_LINK"], !link.isEmpty else {
            throw XCTSkip("ARMADRA_PAIR_LINK not given (run through tools/probes/mobile-shell-e2e.mjs)")
        }
        let app = XCUIApplication()
        app.launch()
        let field = app.webViews.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 60), "connect screen")
        field.tap()
        field.typeText(link)
        button(app, ["连接", "Connect"]).tap()
        XCTAssertTrue(button(app, ["画布", "Canvas"]).waitForExistence(timeout: 60), "canvas after pairing")
        XCTAssertFalse(field.exists)
    }
}
