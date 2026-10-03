import Capacitor
import UIKit

/// Capacitor 的视图控制器，多装一个 App 自己的插件 `ArmadraNative`（补全架构 §10）。
///
/// 证书钉扎不在这里改 `WKNavigationDelegate`：Capacitor 的委托把每个
/// `didReceive challenge` 先交给插件的 `handleWKWebViewURLAuthenticationChallenge`，
/// 钉扎就挂在那里，页面里的 `fetch` 与 WebSocket 握手都经过它。
class ArmadraBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ArmadraNativePlugin())
    }
}
