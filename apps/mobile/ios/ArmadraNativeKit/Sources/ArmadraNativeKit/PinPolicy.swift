import CryptoKit
import Foundation
import Security

/// 一个 Gateway 的钉扎记录：来源、二维码里的信任锚指纹、以及（取得到时）信任锚本身。
///
/// Gateway 在本地 CA 模式下只发叶证书，CA 不在握手链里；所以配对时原生先取一次
/// `GET /ca.crt`（匿名路径），**按指纹核对之后**才把它存下来当信任锚（补全架构
/// §7、§10）。取不到时只存指纹，握手链里自己带着信任锚（自签名、运维给的整条
/// 链）也能判。
public struct Pin: Codable, Equatable {
    public let origin: String
    public let fingerprint: String
    public var anchor: Data?

    public init(origin: String, fingerprint: String, anchor: Data? = nil) {
        self.origin = origin
        self.fingerprint = fingerprint
        self.anchor = anchor
    }

    /// 这次握手是不是发往被钉的来源（主机与端口都要对上，端口缺省 443）。
    public func covers(host: String, port: Int) -> Bool {
        guard let url = URL(string: origin), let pinnedHost = url.host else { return false }
        return pinnedHost.lowercased() == host.lowercased() && (url.port ?? 443) == port
    }
}

public enum PinPolicy {
    /// DER 的 SHA-256，小写十六进制——与 core `gateway/tls.ts::fingerprintOf` 同一拼法。
    public static func fingerprint(_ der: Data) -> String {
        SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
    }

    public static func isFingerprint(_ text: String) -> Bool {
        text.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
    }

    /// `https://host[:port]`，别的一律不认（钉扎只给 Gateway）。
    public static func isOrigin(_ text: String) -> Bool {
        guard let url = URL(string: text), url.scheme == "https", let host = url.host,
              !host.isEmpty, url.path.isEmpty || url.path == "/",
              url.query == nil, url.fragment == nil, url.user == nil
        else { return false }
        return true
    }

    /// PEM（可多张）或单张 DER → 每张证书的 DER。
    public static func certificates(in data: Data) -> [Data] {
        if let text = String(data: data, encoding: .utf8), text.contains("-----BEGIN CERTIFICATE-----") {
            let pattern = "-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\\s]+?)-----END CERTIFICATE-----"
            guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
            let range = NSRange(text.startIndex..., in: text)
            return regex.matches(in: text, range: range).compactMap { match in
                guard let body = Range(match.range(at: 1), in: text) else { return nil }
                let base64 = text[body].components(separatedBy: .whitespacesAndNewlines).joined()
                return Data(base64Encoded: base64)
            }
        }
        return SecCertificateCreateWithData(nil, data as CFData) == nil ? [] : [data]
    }

    /// 握手链里每张证书的 DER（叶在前）。
    public static func presented(_ trust: SecTrust) -> [Data] {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate] else { return [] }
        return chain.map { SecCertificateCopyData($0) as Data }
    }

    /// 握手链与已存的信任锚里，指纹等于钉住值的那一张。
    public static func anchor(presented: [Data], pin: Pin) -> Data? {
        let candidates = presented + (pin.anchor.map { [$0] } ?? [])
        return candidates.first { fingerprint($0) == pin.fingerprint }
    }

    /// 判定：只在「服务端链能验到指纹等于钉住值的那张信任锚、主机名对得上、都在
    /// 有效期内」时放行。系统信任库不参与——钉的就是这一张。
    ///
    /// - Parameter date: 只给测试，固定验证时刻。
    public static func evaluate(trust: SecTrust, host: String, pin: Pin, at date: Date? = nil) -> Bool {
        guard isFingerprint(pin.fingerprint),
              let anchorDER = anchor(presented: presented(trust), pin: pin),
              let anchorCertificate = SecCertificateCreateWithData(nil, anchorDER as CFData)
        else { return false }
        let policy = SecPolicyCreateSSL(true, host as CFString)
        guard SecTrustSetPolicies(trust, policy) == errSecSuccess,
              SecTrustSetAnchorCertificates(trust, [anchorCertificate] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess
        else { return false }
        if let date, SecTrustSetVerifyDate(trust, date as CFDate) != errSecSuccess { return false }
        var error: CFError?
        return SecTrustEvaluateWithError(trust, &error)
    }
}
