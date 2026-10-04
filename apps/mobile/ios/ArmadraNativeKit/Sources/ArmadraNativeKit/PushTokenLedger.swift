import Foundation

/// 推送令牌轮换（R-54）。core 只认登记时交的那一张（契约 §19.2）；APNs 在启动时可能给一张不同的。
/// 这里记着上次登记成功时的 APNs 令牌：之后再拿到不同的一张就标「换过」，页面对开过推送的设备
/// 重新登记（`apps/web/src/mobile/push-rotation.ts`），成功后清掉。令牌与标记都不是密钥，放
/// `UserDefaults`。
public final class PushTokenLedger {
    private enum Key {
        static let token = "dev.armadra.mobile.push.token"
        static let rotated = "dev.armadra.mobile.push.rotated"
    }

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// 登记成功过（之后才值得在启动时向 APNs 再要一次令牌）。
    public var registered: Bool { defaults.string(forKey: Key.token) != nil }

    /// 换过、还没重新登记。
    public var rotated: Bool { defaults.bool(forKey: Key.rotated) }

    /// 页面登记成功：这一张就是当前的，标记清掉。
    public func didRegister(token: String) {
        defaults.set(token, forKey: Key.token)
        defaults.set(false, forKey: Key.rotated)
    }

    /// 没人在等登记时 APNs 给了一张令牌：与上次登记的不同就标「换过」，返回是否是新换的。
    @discardableResult
    public func observe(token: String) -> Bool {
        guard let last = defaults.string(forKey: Key.token), last != token else { return false }
        let fresh = !rotated
        defaults.set(true, forKey: Key.rotated)
        return fresh
    }

    public func acknowledge() {
        defaults.set(false, forKey: Key.rotated)
    }
}
