import CryptoKit
import Foundation
import Security

/// 存几段小秘密的地方。App 用钥匙串，单测用内存——单测绝不碰真钥匙串。
public protocol SecretStore {
    func read(_ account: String) -> Data?
    @discardableResult func write(_ account: String, _ value: Data) -> Bool
    @discardableResult func delete(_ account: String) -> Bool
}

/// 钥匙串（generic password）。`AfterFirstUnlockThisDeviceOnly`：Notification Service
/// Extension 在锁屏时也要读设备私钥，但不随备份迁到别的设备。
///
/// App 与扩展共享同一个钥匙串组：两边的 entitlement 都把
/// `$(AppIdentifierPrefix)dev.armadra.mobile.shared` 列在 `keychain-access-groups` 第一位，
/// 它就是新条目的缺省组，代码里不用写组名（未签名的模拟器构建没有 entitlement，
/// 也照样落到缺省组）。
public struct KeychainStore: SecretStore {
    public let service: String
    public let accessGroup: String?

    public init(service: String = "dev.armadra.mobile", accessGroup: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
    }

    private func query(_ account: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    public func read(_ account: String) -> Data? {
        var request = query(account)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    @discardableResult
    public func write(_ account: String, _ value: Data) -> Bool {
        let update: [String: Any] = [
            kSecValueData as String: value,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(query(account) as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        var insert = query(account)
        insert.merge(update) { _, new in new }
        return SecItemAdd(insert as CFDictionary, nil) == errSecSuccess
    }

    @discardableResult
    public func delete(_ account: String) -> Bool {
        let status = SecItemDelete(query(account) as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}

/// 内存里的 `SecretStore`（单测）。
public final class MemoryStore: SecretStore {
    private var values: [String: Data] = [:]
    public init() {}
    public func read(_ account: String) -> Data? { values[account] }
    @discardableResult public func write(_ account: String, _ value: Data) -> Bool {
        values[account] = value
        return true
    }
    @discardableResult public func delete(_ account: String) -> Bool {
        values[account] = nil
        return true
    }
}

/// 设备的推送密钥对：X25519 私钥只在钥匙串，公钥（32 字节 base64url）随登记交给 core。
public enum DeviceKey {
    public static let account = "push.deviceKey"

    public static func load(_ store: SecretStore) -> Curve25519.KeyAgreement.PrivateKey? {
        guard let raw = store.read(account) else { return nil }
        return try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw)
    }

    public static func loadOrCreate(_ store: SecretStore) -> Curve25519.KeyAgreement.PrivateKey? {
        if let existing = load(store) { return existing }
        let created = Curve25519.KeyAgreement.PrivateKey()
        return store.write(account, created.rawRepresentation) ? created : nil
    }

    public static func publicKey(_ key: Curve25519.KeyAgreement.PrivateKey) -> String {
        Base64URL.encode(key.publicKey.rawRepresentation)
    }
}
