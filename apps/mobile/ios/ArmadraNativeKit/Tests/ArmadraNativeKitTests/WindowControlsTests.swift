import XCTest
@testable import ArmadraNativeKit

final class WindowControlsTests: XCTestCase {
    func testFullScreenHasNoControls() {
        let controls = WindowControls(safeLeft: 0, safeTop: 24, adaptedLeft: 0, adaptedTop: 24)
        XCTAssertEqual(controls, .none)
    }

    func testWindowedSubtractsThePlainSafeArea() {
        let controls = WindowControls(safeLeft: 0, safeTop: 0, adaptedLeft: 77.5, adaptedTop: 39.2)
        XCTAssertEqual(controls.left, 78)
        XCTAssertEqual(controls.top, 40)
    }

    func testRoundingNoiseAndNegativeDifferencesAreZero() {
        XCTAssertEqual(WindowControls(left: 0.3, top: -4), .none)
    }

    func testScriptOnlyCarriesIntegerPixels() {
        let script = WindowControls(left: 78, top: 40).script
        XCTAssertTrue(script.contains("'--window-controls-left','78px'"))
        XCTAssertTrue(script.contains("'--window-controls-top','40px'"))
        XCTAssertEqual(WindowControls.none.script.contains("'0px'"), true)
    }
}
