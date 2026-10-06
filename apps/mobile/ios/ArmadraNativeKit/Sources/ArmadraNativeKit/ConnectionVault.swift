import Foundation

/// 钥匙串里的一份会话：哪个源、经哪条路、发往哪个来源，加两把密钥与访问密钥的到期时刻。
/// 一个连接一份（键 `session.<sourceId>.<via>`），不写任何用户配置。
public struct SessionRecord: Codable, Equatable {
    public let sourceId: String
    public let origin: String
    public let via: String
    public let accessToken: String
    public let refreshToken: String
    public let expiresAtMs: Double

    public init(sourceId: String, origin: String, via: String, accessToken: String, refreshToken: String, expiresAtMs: Double) {
        self.sourceId = sourceId
        self.origin = origin
        self.via = via
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAtMs = expiresAtMs
    }
}

/// 远程服务（个人中转、将来的 SaaS）的一份登录：刷新令牌只在钥匙串里（键 `remote.<serviceId>`）。
public struct RemoteRecord: Codable, Equatable {
    public let serviceId: String
    public let issuer: String
    public let kind: String
    public let refreshToken: String
    public let fingerprint: String

    public init(serviceId: String, issuer: String, kind: String, refreshToken: String, fingerprint: String) {
        self.serviceId = serviceId
        self.issuer = issuer
        self.kind = kind
        self.refreshToken = refreshToken
        self.fingerprint = fingerprint
    }
}

/// 多会话钥匙串（客户端包 §4）：会话按 `sourceId` + `via` 各一条，远程服务按 `serviceId` 各一条，
/// 钉扎按来源各一条。写入前校验形状——页面传来的东西不信，钥匙串里只落合格的。
public final class ConnectionVault {
    private let store: SecretStore

    public init(store: SecretStore) {
        self.store = store
    }

    enum Account {
        static let session = "session."
        static let remote = "remote."
        static let pin = "pin."
    }

    /// 会话密钥：`<32 位十六进制标识>.<43 位 base64url>`（core `identity/tokens.ts`）。
    private static let secretPattern = "^[0-9a-f]{32}\\.[A-Za-z0-9_-]{43}$"
    private static let namePattern = "^[A-Za-z0-9._:-]{1,128}$"
    private static let maxRemoteToken = 4096

    static func isSecret(_ text: String) -> Bool {
        text.range(of: secretPattern, options: .regularExpression) != nil
    }

    static func isName(_ text: String) -> Bool {
        text.range(of: namePattern, options: .regularExpression) != nil
    }

    private static func sessionAccount(_ sourceId: String, _ via: String) -> String {
        "\(Account.session)\(sourceId).\(via)"
    }

    // MARK: - 会话

    public func sessions() -> [SessionRecord] {
        store.list(prefix: Account.session).compactMap { account in
            guard let data = store.read(account),
                  let record = try? JSONDecoder().decode(SessionRecord.self, from: data),
                  Self.valid(record), account == Self.sessionAccount(record.sourceId, record.via)
            else { return nil }
            return record
        }
    }

    public static func valid(_ record: SessionRecord) -> Bool {
        isName(record.sourceId)
            && (record.via == "direct" || record.via == "relayed")
            && PinPolicy.isIssuer(record.origin)
            && isSecret(record.accessToken)
            && isSecret(record.refreshToken)
            && record.expiresAtMs >= 0 && record.expiresAtMs.isFinite
    }

    @discardableResult
    public func setSession(_ record: SessionRecord) -> Bool {
        guard Self.valid(record), let data = try? JSONEncoder().encode(record) else { return false }
        return store.write(Self.sessionAccount(record.sourceId, record.via), data)
    }

    /// 删这个源的会话；给了 `origin` 只删发往它的那份。别的源不动。
    public func removeSession(sourceId: String, origin: String? = nil) {
        guard Self.isName(sourceId) else { return }
        for record in sessions() where record.sourceId == sourceId {
            if let origin, record.origin != origin { continue }
            store.delete(Self.sessionAccount(record.sourceId, record.via))
        }
    }

    // MARK: - 远程服务

    public func remotes() -> [RemoteRecord] {
        store.list(prefix: Account.remote).compactMap { account in
            guard let data = store.read(account),
                  let record = try? JSONDecoder().decode(RemoteRecord.self, from: data),
                  Self.valid(record), account == Account.remote + record.serviceId
            else { return nil }
            return record
        }
    }

    public static func valid(_ record: RemoteRecord) -> Bool {
        isName(record.serviceId)
            && PinPolicy.isIssuer(record.issuer)
            && (record.kind == "personal" || record.kind == "saas")
            && !record.refreshToken.isEmpty && record.refreshToken.count <= maxRemoteToken
            && (record.fingerprint.isEmpty || PinPolicy.isFingerprint(record.fingerprint))
    }

    @discardableResult
    public func setRemote(_ record: RemoteRecord) -> Bool {
        guard Self.valid(record), let data = try? JSONEncoder().encode(record) else { return false }
        return store.write(Account.remote + record.serviceId, data)
    }

    public func removeRemote(serviceId: String) {
        guard Self.isName(serviceId) else { return }
        store.delete(Account.remote + serviceId)
    }

    // MARK: - 钉扎

    /// 每个来源一条：多个 Gateway 与个人中转各钉各的信任锚。
    public func pins() -> [Pin] {
        store.list(prefix: Account.pin).compactMap { account in
            guard let data = store.read(account), let pin = try? JSONDecoder().decode(Pin.self, from: data),
                  PinPolicy.originKey(pin.origin).map({ Account.pin + $0 }) == account
            else { return nil }
            return pin
        }
    }

    @discardableResult
    public func setPin(_ pin: Pin) -> Bool {
        guard PinPolicy.isOrigin(pin.origin), PinPolicy.isFingerprint(pin.fingerprint),
              let key = PinPolicy.originKey(pin.origin), let data = try? JSONEncoder().encode(pin)
        else { return false }
        return store.write(Account.pin + key, data)
    }

    /// 清掉所有钉扎（卸载重装后第一次启动）。
    public func clearAll() {
        for prefix in [Account.session, Account.remote, Account.pin] {
            for account in store.list(prefix: prefix) { store.delete(account) }
        }
    }
}
