import ArmadraNativeKit
import Capacitor
import UIKit
import WebKit
import os

/// Capacitor 的视图控制器，多装一个 App 自己的插件 `ArmadraNative`（补全架构 §10）。
///
/// 证书钉扎不在这里改 `WKNavigationDelegate`：Capacitor 的委托把每个
/// `didReceive challenge` 先交给插件的 `handleWKWebViewURLAuthenticationChallenge`，
/// 钉扎就挂在那里，页面里的 `fetch` 与 WebSocket 握手都经过它。
///
/// 另外把 iPadOS 窗口化时左上角窗口控件占掉的区域交给页面（`WindowControls`）：
/// 它不在 `safe-area-inset-*` 里，页面自己量不到。布局一变（窗口缩放、横竖屏、进出
/// 台前调度）就重算，页面每次加载完再补一次（重载会丢掉内联样式）。
class ArmadraBridgeViewController: CAPBridgeViewController {
    private static let log = Logger(subsystem: "dev.armadra.mobile", category: "window")
    private var windowControls: WindowControls?
    private var loadingObservation: NSKeyValueObservation?

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ArmadraNativePlugin())
        #if DEBUG
        // UI 用例（`AppUITests`）带 `-ArmadraUITest` 启动：开屏动画先记成「这一页面会话已放过」
        // （`apps/web/src/splash/session.ts` 的键）。动画盖在页面上、按下即跳过，用例的第一下点按会
        // 被它吞掉；30fps 的 SVG 动画还会让无障碍快照在慢的 CI 模拟器上超时。只在 Debug 构建里认。
        if ProcessInfo.processInfo.arguments.contains("-ArmadraUITest") {
            webView?.configuration.userContentController.addUserScript(WKUserScript(
                source: "try{sessionStorage.setItem('armadra.splash.shown','1')}catch(e){}",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
        }
        #endif
        loadingObservation = webView?.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
            DispatchQueue.main.async {
                guard let self, !view.isLoading, view.url != nil else { return }
                self.applyWindowControls(force: true)
            }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        applyWindowControls(force: false)
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        applyWindowControls(force: false)
    }

    private func measureWindowControls() -> WindowControls {
        guard #available(iOS 26.0, *), let view else { return .none }
        let safe = view.safeAreaInsets
        let horizontal = view.edgeInsets(for: .safeArea(cornerAdaptation: .horizontal))
        let vertical = view.edgeInsets(for: .safeArea(cornerAdaptation: .vertical))
        return WindowControls(
            safeLeft: safe.left,
            safeTop: safe.top,
            adaptedLeft: horizontal.left,
            adaptedTop: vertical.top
        )
    }

    private func applyWindowControls(force: Bool) {
        let measured = measureWindowControls()
        guard force || measured != windowControls else { return }
        windowControls = measured
        Self.log.info("window controls left=\(Int(measured.left)) top=\(Int(measured.top))")
        guard let webView, webView.url != nil, !webView.isLoading else { return }
        webView.evaluateJavaScript(measured.script)
    }
}
