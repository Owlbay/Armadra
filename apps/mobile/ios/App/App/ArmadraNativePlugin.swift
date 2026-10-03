import ArmadraNativeKit
import Capacitor
import Foundation
import UIKit
import UserNotifications
import WebKit

/// 原生插件 `ArmadraNative`：页面一半在 `apps/web/src/mobile/native-bridge.ts`，约定
/// 写在那个文件头里（参数与返回都是一个对象）。
///
/// | 方法                          | 这里做什么                                                  |
/// | ----------------------------- | ----------------------------------------------------------- |
/// | `getSession` / `setSession` / `clearSession` | 钥匙串里的一份会话（来源 + 两把密钥）        |
/// | `pin({ origin, fingerprint })` | 取 `/ca.crt` 按指纹核对后存为信任锚；之后对该来源的 TLS 只认它 |
/// | `scan()`                      | 相机扫二维码，取消时没有 `text`                             |
/// | `pushRegistration()`          | APNs 令牌 + 设备 X25519 公钥；配了中继时先换中继令牌         |
///
/// 另外两件页面不调用的事：深链（`armadra://…`）与点通知，都改写页面的地址片段
/// （`DeepLink.script`）。
@objc(ArmadraNativePlugin)
public class ArmadraNativePlugin: CAPPlugin, CAPBridgedPlugin, NotificationHandlerProtocol {
    public let identifier = "ArmadraNativePlugin"
    public let jsName = "ArmadraNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pushRegistration", returnType: CAPPluginReturnPromise),
    ]

    private enum Account {
        static let session = "gateway.session"
        static let pin = "gateway.pin"
    }

    private static let installedFlag = "dev.armadra.mobile.installed"
    private static let secret = "^[A-Za-z0-9_-]{43}$"

    private let store: SecretStore = KeychainStore()
    private var currentPin: Pin?
    private var pendingScript: String?
    private var loadingObservation: NSKeyValueObservation?
    private var pushCall: CAPPluginCall?
    private var pushTimeout: DispatchWorkItem?
    private var observers: [NSObjectProtocol] = []

    override public func load() {
        // 钥匙串在卸载重装后还在：第一次启动时清掉上一次安装留下的会话与钉扎。
        let defaults = UserDefaults.standard
        if !defaults.bool(forKey: Self.installedFlag) {
            store.delete(Account.session)
            store.delete(Account.pin)
            store.delete(DeviceKey.account)
            defaults.set(true, forKey: Self.installedFlag)
        }
        currentPin = store.read(Account.pin).flatMap { try? JSONDecoder().decode(Pin.self, from: $0) }

        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: .capacitorOpenURL, object: nil, queue: .main) { [weak self] note in
            guard let object = note.object as? [String: Any], let url = object["url"] as? URL else { return }
            self?.open(url.absoluteString)
        })
        observers.append(center.addObserver(forName: .capacitorDidRegisterForRemoteNotifications, object: nil, queue: .main) { [weak self] note in
            guard let token = note.object as? Data else { return }
            self?.registered(token: token)
        })
        observers.append(center.addObserver(forName: .capacitorDidFailToRegisterForRemoteNotifications, object: nil, queue: .main) { [weak self] _ in
            self?.finishPush(nil, error: "registration failed")
        })
        bridge?.notificationRouter.pushNotificationHandler = self
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
    }

    // MARK: - 会话

    @objc func getSession(_ call: CAPPluginCall) {
        guard let data = store.read(Account.session),
              let session = try? JSONSerialization.jsonObject(with: data) as? [String: String]
        else {
            call.resolve([:])
            return
        }
        call.resolve(["session": session])
    }

    @objc func setSession(_ call: CAPPluginCall) {
        guard let session = call.getObject("session"),
              let origin = session["origin"] as? String, PinPolicy.isOrigin(origin),
              let access = session["accessToken"] as? String, Self.isSecret(access),
              let refresh = session["refreshToken"] as? String, Self.isSecret(refresh),
              let data = try? JSONSerialization.data(withJSONObject: [
                  "origin": origin, "accessToken": access, "refreshToken": refresh,
              ])
        else {
            call.reject("invalid session")
            return
        }
        store.write(Account.session, data) ? call.resolve() : call.reject("keychain unavailable")
    }

    @objc func clearSession(_ call: CAPPluginCall) {
        store.delete(Account.session)
        call.resolve()
    }

    private static func isSecret(_ text: String) -> Bool {
        text.range(of: secret, options: .regularExpression) != nil
    }

    // MARK: - 证书钉扎

    /// 失败必须 reject（页面据此报「钉扎失败」，不往下配对）：参数不像样、取到了
    /// 信任锚但指纹对不上、钥匙串写不进。连不上不算失败——只存指纹，握手时链里
    /// 自带信任锚的仍能判；本地 CA 模式下连不上本来也配不成。
    @objc func pin(_ call: CAPPluginCall) {
        guard let origin = call.getString("origin"), PinPolicy.isOrigin(origin),
              let fingerprint = call.getString("fingerprint"), PinPolicy.isFingerprint(fingerprint),
              let url = URL(string: origin)
        else {
            call.reject("bad pin")
            return
        }
        AnchorFetch.run(origin: url) { [weak self] fetched in
            guard let self else { return }
            var pin = Pin(origin: origin, fingerprint: fingerprint)
            if let fetched {
                guard let anchor = PinPolicy.anchor(presented: fetched, pin: pin) else {
                    call.reject("fingerprint mismatch")
                    return
                }
                pin.anchor = anchor
            }
            guard let data = try? JSONEncoder().encode(pin), self.store.write(Account.pin, data) else {
                call.reject("keychain unavailable")
                return
            }
            DispatchQueue.main.async {
                self.currentPin = pin
                call.resolve()
            }
        }
    }

    @objc override public func handleWKWebViewURLAuthenticationChallenge(
        _ challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) -> Bool {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = space.serverTrust
        else { return false }
        guard let pin = currentPin, pin.covers(host: space.host, port: space.port) else {
            completionHandler(.performDefaultHandling, nil)
            return true
        }
        if PinPolicy.evaluate(trust: trust, host: space.host, pin: pin) {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            // 不自动信任新证书（补全架构 §7「证书轮换」）：握手失败，页面提示重新扫码。
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
        return true
    }

    // MARK: - 扫码

    @objc func scan(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else {
                call.resolve([:])
                return
            }
            QRScannerViewController.present(from: presenter) { text in
                call.resolve(text.map { ["text": $0] } ?? [:])
            }
        }
    }

    // MARK: - 推送

    @objc func pushRegistration(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            DispatchQueue.main.async {
                guard granted else {
                    call.reject("denied")
                    return
                }
                self.pushCall?.reject("superseded")
                self.pushCall = call
                let timeout = DispatchWorkItem { [weak self] in self?.finishPush(nil, error: "timeout") }
                self.pushTimeout?.cancel()
                self.pushTimeout = timeout
                DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: timeout)
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    private func registered(token: Data) {
        guard pushCall != nil else { return }
        guard let key = DeviceKey.loadOrCreate(store) else {
            finishPush(nil, error: "keychain unavailable")
            return
        }
        let hex = token.map { String(format: "%02x", $0) }.joined()
        let publicKey = DeviceKey.publicKey(key)
        let relay = getConfig().getString("relayUrl", "")?.trimmingCharacters(in: .whitespaces) ?? ""
        guard !relay.isEmpty else {
            finishPush(["platform": "ios", "transport": "direct", "token": hex, "publicKey": publicKey], error: nil)
            return
        }
        RelayRegistration.run(relay: relay, platform: "ios", token: hex) { [weak self] relayToken in
            DispatchQueue.main.async {
                guard let relayToken else {
                    self?.finishPush(nil, error: "relay registration failed")
                    return
                }
                self?.finishPush(
                    ["platform": "ios", "transport": "relay", "token": relayToken, "publicKey": publicKey],
                    error: nil
                )
            }
        }
    }

    private func finishPush(_ registration: [String: String]?, error: String?) {
        pushTimeout?.cancel()
        pushTimeout = nil
        guard let call = pushCall else { return }
        pushCall = nil
        if let registration {
            call.resolve(["registration": registration])
        } else {
            call.reject(error ?? "failed")
        }
    }

    // 前台也出横幅；点开按载荷里的深链进节点焦点页（NSE 解开后写进 `url`）。
    public func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    public func didReceive(response: UNNotificationResponse) {
        if let link = response.notification.request.content.userInfo["url"] as? String {
            open(link)
        }
    }

    // MARK: - 深链

    private func open(_ link: String) {
        guard let deepLink = DeepLink(link) else { return }
        DispatchQueue.main.async { self.deliver(deepLink.script) }
    }

    /// 页面还在加载（冷启动）时先记着，加载完再执行；否则立刻执行。
    private func deliver(_ script: String) {
        guard let webView = bridge?.webView, webView.url != nil, !webView.isLoading else {
            pendingScript = script
            watchLoading()
            return
        }
        webView.evaluateJavaScript(script)
    }

    private func watchLoading() {
        guard loadingObservation == nil, let webView = bridge?.webView else {
            if bridge?.webView == nil {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                    guard let self, let script = self.pendingScript else { return }
                    self.deliver(script)
                }
            }
            return
        }
        loadingObservation = webView.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
            DispatchQueue.main.async {
                guard let self, !view.isLoading, view.url != nil, let script = self.pendingScript else { return }
                self.pendingScript = nil
                self.loadingObservation = nil
                view.evaluateJavaScript(script)
            }
        }
    }
}

/// 配对时取一次信任锚：握手链（每张证书）加 `GET /ca.crt` 的正文。这一次请求接受
/// 任何服务端证书——取回来的东西只有指纹对得上才会被存下，不发送任何凭据。
private final class AnchorFetch: NSObject, URLSessionDelegate {
    private var presented: [Data] = []

    static func run(origin: URL, completion: @escaping ([Data]?) -> Void) {
        let delegate = AnchorFetch()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 15
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        let task = session.dataTask(with: origin.appendingPathComponent("ca.crt")) { data, response, _ in
            session.finishTasksAndInvalidate()
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let body = (200 ..< 300).contains(status) ? PinPolicy.certificates(in: data ?? Data()) : []
            if delegate.presented.isEmpty && body.isEmpty {
                completion(nil)
            } else {
                completion(delegate.presented + body)
            }
        }
        task.resume()
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        presented = PinPolicy.presented(trust)
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}

/// 商店版：把 APNs 令牌交给发布方的中继换一张中继令牌（`apps/push-relay` 的 `/v1/register`）。
/// 中继是公网服务，走系统信任库。
private enum RelayRegistration {
    static func run(relay: String, platform: String, token: String, completion: @escaping (String?) -> Void) {
        guard let base = URL(string: relay), base.scheme == "https" || base.host == "127.0.0.1" else {
            completion(nil)
            return
        }
        var request = URLRequest(url: base.appendingPathComponent("v1/register"), timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["platform": platform, "token": token])
        URLSession.shared.dataTask(with: request) { data, response, _ in
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let data,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let relayToken = object["relayToken"] as? String, !relayToken.isEmpty
            else {
                completion(nil)
                return
            }
            completion(relayToken)
        }.resume()
    }
}
