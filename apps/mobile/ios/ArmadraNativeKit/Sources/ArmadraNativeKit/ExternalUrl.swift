import Foundation

/// 原生那一侧对「交出去的地址」的判定（与页面 `native-bridge.ts`、Android `ExternalUrl.java` 同义）：
/// `openExternal` 交给系统浏览器的地址（原生 OAuth 的授权页，R-56）只能是 https，或回环上的 http
/// （开发与 dev-stack），不带用户名口令。
public enum ExternalUrl {
    private static let maxLength = 4096

    public static func browsable(_ value: String) -> URL? {
        guard value.count <= maxLength,
              let components = URLComponents(string: value),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              let scheme = components.scheme?.lowercased(),
              let url = components.url
        else { return nil }
        if scheme == "https" { return url }
        let loopback = ["127.0.0.1", "localhost"].contains(host.lowercased())
        return scheme == "http" && loopback ? url : nil
    }
}
