import ArmadraNativeKit
import XCTest

final class ExternalUrlTests: XCTestCase {
    func testOnlyHttpsOrLoopbackHttpGoesToTheSystemBrowser() {
        XCTAssertNotNil(ExternalUrl.browsable("https://idp.example/authorize?state=a&client_id=b"))
        XCTAssertNotNil(ExternalUrl.browsable("http://127.0.0.1:5556/dex/auth?x=1"))
        XCTAssertNotNil(ExternalUrl.browsable("http://localhost:5556/"))
        XCTAssertNil(ExternalUrl.browsable("http://idp.example/authorize"))
        XCTAssertNil(ExternalUrl.browsable("https://user:pw@idp.example/"))
        XCTAssertNil(ExternalUrl.browsable("javascript:alert(1)"))
        XCTAssertNil(ExternalUrl.browsable("armadra://oauth?state=a"))
        XCTAssertNil(ExternalUrl.browsable("https://" + String(repeating: "a", count: 5000)))
    }
}
