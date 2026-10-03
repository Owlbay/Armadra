import ArmadraNativeKit
import XCTest

final class DeepLinkTests: XCTestCase {
    func testClassifiesTheTwoKinds() {
        let pair = "armadra://pair?host=192.168.1.20%3A8443&ticket=abc_DEF-123&fp=" + String(repeating: "a", count: 64)
        XCTAssertEqual(DeepLink(pair), .pair(pair))
        XCTAssertEqual(DeepLink("armadra://w/ws_1/n/node_1"), .node("armadra://w/ws_1/n/node_1"))
        XCTAssertEqual(DeepLink("armadra://w/ws_1"), .node("armadra://w/ws_1"))
        XCTAssertNil(DeepLink("armadra://w/ws_1/x/y"))
        XCTAssertNil(DeepLink("https://armadra.dev/pair"))
        XCTAssertNil(DeepLink("armadra://pair?host=a&x=<script>"))
        XCTAssertNil(DeepLink("armadra://w/" + String(repeating: "a", count: 3000)))
    }

    func testScriptsQuoteTheLinkAsAStringLiteral() {
        XCTAssertEqual(
            DeepLink("armadra://w/ws_1/n/node_1")?.script,
            #"location.hash='#push='+encodeURIComponent("armadra:\/\/w\/ws_1\/n\/node_1");"#
        )
        let pair = DeepLink("armadra://pair?host=h%3A1&ticket=t&fp=f")!.script
        XCTAssertTrue(pair.hasPrefix("history.replaceState(null,'',location.pathname+'#link='+encodeURIComponent("))
        XCTAssertTrue(pair.hasSuffix("location.reload();"))
        // 一个 `'` 都拼不进去：认不出的字符在分类时就挡掉了。
        XCTAssertNil(DeepLink("armadra://w/a'+alert(1)+'"))
    }
}
