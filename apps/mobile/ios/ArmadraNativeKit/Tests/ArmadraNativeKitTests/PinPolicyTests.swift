import ArmadraNativeKit
import Security
import XCTest

final class PinPolicyTests: XCTestCase {
    private func der(_ name: String) throws -> Data {
        try XCTUnwrap(PinPolicy.certificates(in: Fixtures.data(name)).first)
    }

    private func trust(_ chain: [Data]) throws -> SecTrust {
        let certificates = chain.compactMap { SecCertificateCreateWithData(nil, $0 as CFData) }
        var trust: SecTrust?
        let status = SecTrustCreateWithCertificates(
            certificates as CFArray, SecPolicyCreateSSL(true, nil), &trust
        )
        XCTAssertEqual(status, errSecSuccess)
        return try XCTUnwrap(trust)
    }

    func testFingerprintMatchesCoreSpelling() throws {
        // 与 `openssl x509 -outform der | shasum -a 256` 一致（小写十六进制）。
        XCTAssertEqual(
            PinPolicy.fingerprint(try der("ca.pem")),
            "82e388ac1ef80d0ab28831f8bf9e0d0cde8d6b376d100c773d899e31f3ba23ca"
        )
        XCTAssertTrue(PinPolicy.isFingerprint(PinPolicy.fingerprint(try der("leaf.pem"))))
        XCTAssertFalse(PinPolicy.isFingerprint("82E388AC"))
    }

    func testTrustsLeafSignedByPinnedStoredAnchor() throws {
        let ca = try der("ca.pem")
        let pin = Pin(origin: "https://127.0.0.1:8443", fingerprint: PinPolicy.fingerprint(ca), anchor: ca)
        // Gateway 只发叶证书：信任锚来自配对时按指纹核过的 /ca.crt。
        XCTAssertTrue(PinPolicy.evaluate(
            trust: try trust([try der("leaf.pem")]), host: "127.0.0.1", pin: pin, at: Fixtures.validDate
        ))
        XCTAssertTrue(PinPolicy.evaluate(
            trust: try trust([try der("leaf.pem")]), host: "192.168.1.20", pin: pin, at: Fixtures.validDate
        ))
    }

    func testRejectsWhenStoredAnchorIsNotThePinnedOne() throws {
        let ca = try der("ca.pem")
        let other = try der("other-ca.pem")
        // 存下的锚指纹不对（被换过）：没有一张能当锚。
        let swapped = Pin(origin: "https://127.0.0.1:8443", fingerprint: PinPolicy.fingerprint(ca), anchor: other)
        XCTAssertFalse(PinPolicy.evaluate(
            trust: try trust([try der("leaf.pem")]), host: "127.0.0.1", pin: swapped, at: Fixtures.validDate
        ))
        // 钉的是另一把 CA（同名不同钥）：叶证书验不到它。
        let wrong = Pin(origin: "https://127.0.0.1:8443", fingerprint: PinPolicy.fingerprint(other), anchor: other)
        XCTAssertFalse(PinPolicy.evaluate(
            trust: try trust([try der("leaf.pem")]), host: "127.0.0.1", pin: wrong, at: Fixtures.validDate
        ))
    }

    func testRejectsWrongHostAndExpiredLeaf() throws {
        let ca = try der("ca.pem")
        let pin = Pin(origin: "https://127.0.0.1:8443", fingerprint: PinPolicy.fingerprint(ca), anchor: ca)
        XCTAssertFalse(PinPolicy.evaluate(
            trust: try trust([try der("leaf.pem")]), host: "10.0.0.9", pin: pin, at: Fixtures.validDate
        ))
        let expired = Date(timeIntervalSince1970: 1_830_297_600) // 2028-01-01
        XCTAssertFalse(PinPolicy.evaluate(
            trust: try trust([try der("leaf.pem")]), host: "127.0.0.1", pin: pin, at: expired
        ))
    }

    func testSelfSignedLeafIsItsOwnAnchorAndSystemTrustIsIgnored() throws {
        let leaf = try der("self-signed.pem")
        // 握手链自己带着那张被钉的证书：不需要存锚。
        let pin = Pin(origin: "https://127.0.0.1:8443", fingerprint: PinPolicy.fingerprint(leaf))
        XCTAssertTrue(PinPolicy.evaluate(
            trust: try trust([leaf]), host: "127.0.0.1", pin: pin, at: Fixtures.validDate
        ))
        // 没有任何东西对得上指纹 → 拒绝（不回落到系统信任库）。
        let other = Pin(origin: "https://127.0.0.1:8443", fingerprint: String(repeating: "0", count: 64))
        XCTAssertFalse(PinPolicy.evaluate(
            trust: try trust([leaf]), host: "127.0.0.1", pin: other, at: Fixtures.validDate
        ))
    }

    func testPinCoversOnlyItsOwnHostAndPort() {
        let pin = Pin(origin: "https://192.168.1.20:8443", fingerprint: String(repeating: "a", count: 64))
        XCTAssertTrue(pin.covers(host: "192.168.1.20", port: 8443))
        XCTAssertFalse(pin.covers(host: "192.168.1.20", port: 443))
        XCTAssertFalse(pin.covers(host: "192.168.1.21", port: 8443))
        XCTAssertTrue(Pin(origin: "https://example.test", fingerprint: "").covers(host: "EXAMPLE.test", port: 443))
        XCTAssertTrue(PinPolicy.isOrigin("https://192.168.1.20:8443"))
        XCTAssertFalse(PinPolicy.isOrigin("http://192.168.1.20:8443"))
        XCTAssertFalse(PinPolicy.isOrigin("https://192.168.1.20:8443/api"))
    }

    func testCertificatesParsesPemAndDer() throws {
        let pem = try Fixtures.data("ca.pem") + Fixtures.data("leaf.pem")
        XCTAssertEqual(PinPolicy.certificates(in: pem).count, 2)
        XCTAssertEqual(PinPolicy.certificates(in: try der("ca.pem")).count, 1)
        XCTAssertEqual(PinPolicy.certificates(in: Data("not a cert".utf8)).count, 0)
    }
}
