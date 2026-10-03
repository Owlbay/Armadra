import XCTest

/// B 档 UI 用例「连接 → 配对 → 画布」（补全计划 G3-1），由
/// `tools/probes/mobile-shell-e2e.mjs` 驱动：探针起 core、在回环上开 Gateway（模拟器与
/// 宿主共用回环），把原生深链 `armadra://pair?host=…&ticket=…&fp=…` 经
/// `TEST_RUNNER_ARMADRA_PAIR_LINK` 交进来，用例经深链交给 App。页面在 WKWebView 里，按无障碍树
/// 找输入框与按钮；文案中英都认（模拟器的语言不定）。XCTest 按名字排序：配对之后 App 记住了
/// Gateway，「没有 Gateway」那条必须在前（`test1…`、`test2…`）。
final class ConnectFlowUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func button(_ app: XCUIApplication, _ labels: [String]) -> XCUIElement {
        app.webViews.buttons.matching(NSPredicate(format: "label IN %@", labels)).firstMatch
    }

    func test1WithoutAGatewayTheAppOpensOnTheConnectScreen() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.webViews.textFields.firstMatch.waitForExistence(timeout: 60), "connect screen")
        XCTAssertTrue(button(app, ["连接", "Connect"]).exists)
    }

    func test2PairsThroughThePinnedGatewayAndOpensTheCanvas() throws {
        guard let link = ProcessInfo.processInfo.environment["ARMADRA_PAIR_LINK"], !link.isEmpty else {
            throw XCTSkip("ARMADRA_PAIR_LINK not given (run through tools/probes/mobile-shell-e2e.mjs)")
        }
        let app = XCUIApplication()
        app.launch()
        let field = app.webViews.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 60), "connect screen")
        // 链接走深链交给 App（也就测了 `armadra://pair` → `#link=` 预填）；连接页由人点「连接」。
        app.open(try XCTUnwrap(URL(string: link)))
        let connect = button(app, ["连接", "Connect"])
        let filled = NSPredicate(format: "value BEGINSWITH %@", "armadra://pair?")
        expectation(for: filled, evaluatedWith: app.webViews.textFields.firstMatch)
        waitForExpectations(timeout: 30)
        XCTAssertTrue(connect.waitForExistence(timeout: 10))
        // WKWebView 里的元素常报「不可点」（无障碍树的可点判定跟不上页面布局），按坐标点。
        connect.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let canvas = button(app, ["画布", "Canvas"])
        if !canvas.waitForExistence(timeout: 60) {
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.lifetime = .keepAlways
            add(shot)
            XCTFail("canvas after pairing: \(app.webViews.staticTexts.allElementsBoundByIndex.prefix(12).map(\.label))")
            return
        }
        // 重开 App：会话从钥匙串读回，直接进画布、不再问配对。
        app.terminate()
        app.launch()
        XCTAssertTrue(button(app, ["画布", "Canvas"]).waitForExistence(timeout: 60), "canvas after relaunch")
        XCTAssertFalse(button(app, ["连接", "Connect"]).exists)
    }
}
