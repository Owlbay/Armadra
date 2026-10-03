import ArmadraNativeKit
import CryptoKit
import XCTest

final class PushEnvelopeTests: XCTestCase {
    private func fixture() throws -> (key: Curve25519.KeyAgreement.PrivateKey, publicKey: String, plaintext: String, envelope: [String: Any]) {
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Fixtures.data("push-envelope.json")) as? [String: Any]
        )
        let raw = try XCTUnwrap(Base64URL.decode(try XCTUnwrap(object["privateKey"] as? String)))
        return (
            try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw),
            try XCTUnwrap(object["publicKey"] as? String),
            try XCTUnwrap(object["plaintext"] as? String),
            try XCTUnwrap(object["envelope"] as? [String: Any])
        )
    }

    func testOpensWhatTheCoreSealed() throws {
        let fixture = try fixture()
        XCTAssertEqual(DeviceKey.publicKey(fixture.key), fixture.publicKey)
        let plaintext = try PushEnvelope.open(fixture.envelope, privateKey: fixture.key)
        XCTAssertEqual(String(data: plaintext, encoding: .utf8), fixture.plaintext)
        let payload = try PushEnvelope.payload(plaintext)
        XCTAssertEqual(payload.kind, "approval")
        XCTAssertEqual(payload.title, "支付服务")
        XCTAssertEqual(payload.url, "armadra://w/ws_1/n/node_1")
        XCTAssertEqual(payload.tag, "approval:p1")
    }

    func testAcceptsTheFcmStringForm() throws {
        let fixture = try fixture()
        let text = String(data: try JSONSerialization.data(withJSONObject: fixture.envelope), encoding: .utf8)!
        XCTAssertNoThrow(try PushEnvelope.open(text, privateKey: fixture.key))
    }

    func testRejectsTamperingAndOtherKeys() throws {
        let fixture = try fixture()
        var tampered = fixture.envelope
        var ct = Base64URL.decode(tampered["ct"] as! String)!
        ct[0] ^= 0x01
        tampered["ct"] = Base64URL.encode(ct)
        XCTAssertThrowsError(try PushEnvelope.open(tampered, privateKey: fixture.key)) {
            XCTAssertEqual($0 as? PushEnvelopeError, .undecryptable)
        }
        XCTAssertThrowsError(try PushEnvelope.open(fixture.envelope, privateKey: Curve25519.KeyAgreement.PrivateKey())) {
            XCTAssertEqual($0 as? PushEnvelopeError, .undecryptable)
        }
        var other = fixture.envelope
        other["alg"] = "x25519-hkdf-sha256-a128gcm"
        XCTAssertThrowsError(try PushEnvelope.open(other, privateKey: fixture.key)) {
            XCTAssertEqual($0 as? PushEnvelopeError, .unsupported)
        }
    }

    func testPayloadDropsUnknownLinksAndKinds() throws {
        let odd = Data(#"{"v":1,"kind":"test","title":"t","body":"b","url":"https://evil.example","tag":"x"}"#.utf8)
        XCTAssertEqual(try PushEnvelope.payload(odd).url, "")
        let unknown = Data(#"{"v":1,"kind":"shell","title":"t","body":"b","url":"","tag":"x"}"#.utf8)
        XCTAssertThrowsError(try PushEnvelope.payload(unknown))
    }

    func testDeviceKeyIsCreatedOnceAndKeptInTheStore() throws {
        let store = MemoryStore()
        let first = try XCTUnwrap(DeviceKey.loadOrCreate(store))
        let second = try XCTUnwrap(DeviceKey.loadOrCreate(store))
        XCTAssertEqual(first.rawRepresentation, second.rawRepresentation)
        XCTAssertEqual(Base64URL.decode(DeviceKey.publicKey(first))?.count, 32)
    }
}
