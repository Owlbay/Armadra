import Foundation

/// 原生收到的三种深链（外部服务 §5.3、契约 §17.3 / §19.4 / §18.5），以及把它交给页面的那一行 JS。
///
///  - `armadra://pair?host=…&ticket=…&fp=…`：配对。页面的入口在挂载前就定了，所以
///    写进 `#link=` 再重载，连接页拿它当输入框初值，人点「连接」才配。
///  - `armadra://join?link=<id>&issuer=<签发方>&s=<片段>`：个人中转的分享链接（cloud 契约 §10）。
///    与配对一样写进 `#link=` 再重载，连接页收到就直接挂载。
///  - `armadra://w/<工作空间>[/n/<节点>]`：通知点开。写进 `#push=`，页面
///    `mobile/push-open.ts` 认 `hashchange`，不用重载。
///  - `armadra://oauth?state=…&code=…`（或 `error=`）：原生 OAuth 的回调（R-56）。与配对一样
///    写进 `#link=` 再重载，入口在挂载前收尾。
///
/// 其余一律不认。链接按 JSON 字符串字面量嵌进脚本，不拼接原文。
public enum DeepLink: Equatable {
    case pair(String)
    case join(String)
    case node(String)
    case oauth(String)

    private static let maxLength = 2048
    private static let pairPattern = "^armadra://pair\\?[A-Za-z0-9._~%&=:+-]+$"
    private static let joinPattern = "^armadra://join\\?[A-Za-z0-9._~%&=:+-]+$"
    private static let oauthPattern = "^armadra://oauth\\?[A-Za-z0-9._~%&=:+*-]+$"
    private static let nodePattern = "^armadra://w/[A-Za-z0-9._~%-]+(/n/[A-Za-z0-9._~%-]+)?/?$"

    public init?(_ link: String) {
        guard link.count <= Self.maxLength else { return nil }
        if link.range(of: Self.pairPattern, options: .regularExpression) != nil {
            self = .pair(link)
        } else if link.range(of: Self.joinPattern, options: .regularExpression) != nil {
            self = .join(link)
        } else if link.range(of: Self.nodePattern, options: .regularExpression) != nil {
            self = .node(link)
        } else if link.range(of: Self.oauthPattern, options: .regularExpression) != nil {
            self = .oauth(link)
        } else {
            return nil
        }
    }

    public var link: String {
        switch self {
        case let .pair(link), let .join(link), let .node(link), let .oauth(link): return link
        }
    }

    /// 在页面里执行的那一行。
    public var script: String {
        let literal = Self.literal(link)
        switch self {
        case .pair, .join, .oauth:
            return "history.replaceState(null,'',location.pathname+'#link='+encodeURIComponent(\(literal)));location.reload();"
        case .node:
            return "location.hash='#push='+encodeURIComponent(\(literal));"
        }
    }

    private static func literal(_ text: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [text]),
              let array = String(data: data, encoding: .utf8)
        else { return "\"\"" }
        // `["…"]` → `"…"`；再把 JS 行终止符转义掉。
        return String(array.dropFirst().dropLast())
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }
}
