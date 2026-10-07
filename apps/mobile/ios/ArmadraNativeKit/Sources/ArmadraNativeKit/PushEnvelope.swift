import CryptoKit
import Foundation

/// 一条通知解开后的内容（契约 §19.4）：标题、短正文、深链、分组与折叠用的两个键。
public struct PushPayload: Equatable {
    public let kind: String
    public let title: String
    public let body: String
    /// 认得出的深链（`armadra://w/…`）；认不出是空串，点开只进 App。
    public let url: String
    public let tag: String
}

public enum PushEnvelopeError: Error, Equatable {
    case unsupported
    case malformed
    case undecryptable
}

/// 推送的端到端信封（契约 §19.5）：一次性 X25519 公钥 `epk` 与设备公钥做 ECDH，
/// HKDF-SHA256（salt，info = `"armadra-push-v1" ‖ 0x00 ‖ epk ‖ 设备公钥`）派生
/// AES-256-GCM 的钥；`ct` = 密文 ‖ 16 字节标签。与 core `push/crypto.ts::sealPayload`
/// 逐字节对应，中继与苹果只看到密文。
public enum PushEnvelope {
    public static let algorithm = "x25519-hkdf-sha256-a256gcm"
    private static let info = Data("armadra-push-v1".utf8)
    private static let kinds: Set<String> = [
        "approval", "agentDone", "agentError", "deliveryFailed", "schedule",
        "resources", "comment", "workflowGate", "test",
    ]

    /// APNs 的 `enc` 是字典，FCM 的 `data.enc` 是它的 JSON 字符串；两种都收。
    public static func open(
        _ envelope: Any,
        privateKey: Curve25519.KeyAgreement.PrivateKey
    ) throws -> Data {
        let fields: [String: Any]
        if let text = envelope as? String,
           let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] {
            fields = object
        } else if let object = envelope as? [String: Any] {
            fields = object
        } else if let object = envelope as? [AnyHashable: Any] {
            fields = Dictionary(uniqueKeysWithValues: object.compactMap { key, value in
                (key as? String).map { ($0, value) }
            })
        } else {
            throw PushEnvelopeError.malformed
        }
        guard (fields["v"] as? NSNumber)?.intValue == 1, fields["alg"] as? String == algorithm else {
            throw PushEnvelopeError.unsupported
        }
        guard let epk = (fields["epk"] as? String).flatMap(Base64URL.decode), epk.count == 32,
              let salt = (fields["salt"] as? String).flatMap(Base64URL.decode),
              let iv = (fields["iv"] as? String).flatMap(Base64URL.decode), iv.count == 12,
              let sealed = (fields["ct"] as? String).flatMap(Base64URL.decode), sealed.count >= 16
        else { throw PushEnvelopeError.malformed }
        do {
            let ephemeral = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: epk)
            let shared = try privateKey.sharedSecretFromKeyAgreement(with: ephemeral)
            var context = info
            context.append(0)
            context.append(epk)
            context.append(privateKey.publicKey.rawRepresentation)
            let key = shared.hkdfDerivedSymmetricKey(
                using: SHA256.self, salt: salt, sharedInfo: context, outputByteCount: 32
            )
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: iv),
                ciphertext: sealed.prefix(sealed.count - 16),
                tag: sealed.suffix(16)
            )
            return try AES.GCM.open(box, using: key)
        } catch {
            throw PushEnvelopeError.undecryptable
        }
    }

    /// 明文 → 载荷。键不全、种类不认识都算坏；深链认不出就丢掉，不丢整条通知。
    public static func payload(_ plaintext: Data) throws -> PushPayload {
        guard let object = try? JSONSerialization.jsonObject(with: plaintext) as? [String: Any],
              (object["v"] as? NSNumber)?.intValue == 1,
              let kind = object["kind"] as? String, kinds.contains(kind),
              let title = object["title"] as? String,
              let body = object["body"] as? String,
              let url = object["url"] as? String,
              let tag = object["tag"] as? String
        else { throw PushEnvelopeError.malformed }
        return PushPayload(
            kind: kind,
            title: String(title.prefix(64)),
            body: String(body.prefix(120)),
            url: DeepLink(url).map { _ in url } ?? "",
            tag: String(tag.prefix(128))
        )
    }
}
