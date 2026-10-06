import ArmadraNativeKit
import Capacitor
import Foundation
import UIKit
import UserNotifications
import WebKit
import os

/// 原生插件 `ArmadraNative`：页面一半在 `apps/web/src/mobile/native-bridge.ts`，约定
/// 写在那个文件头里（参数与返回都是一个对象）。
///
/// | 方法                          | 这里做什么                                                  |
/// | ----------------------------- | ----------------------------------------------------------- |
/// | `getSessions` / `setSession` / `removeSession` | 钥匙串里的会话，一个连接一份（`sourceId` + `via` 为键） |
/// | `getRemotes` / `setRemote` / `removeRemote` | 远程服务（个人中转）的刷新令牌，`serviceId` 为键 |
/// | `peek({ origin })`            | 不带凭据取一次信任锚指纹（`/ca.crt` 或握手链），什么也不存    |
/// | `pin({ origin, fingerprint })` | 取 `/ca.crt` 按指纹核对后存为信任锚；之后对该来源的 TLS 只认它，多个来源各存一份 |
/// | `scan()`                      | 相机扫二维码，取消时没有 `text`                             |
/// | `pushRegistration()`          | APNs 令牌 + 设备 X25519 公钥；配了中继时先换中继令牌         |
/// | `pushRotated()` / `ackPushRotation()` | 启动时 APNs 给了与上次登记不同的令牌（R-54，`PushTokenLedger`） |
/// | `openExternal({ url })`       | 系统浏览器打开原生 OAuth 的授权页（R-56），只开 https 与回环 http |
///
/// 令牌换过的那一刻还发 `pushTokenRotated` 事件。
/// 另外两件页面不调用的事：深链（`armadra://…`，含 OAuth 回调）与点通知，都改写页面的地址片段
/// （`DeepLink.script`）。
@objc(ArmadraNativePlugin)
public class ArmadraNativePlugin: CAPPlugin, CAPBridgedPlugin, NotificationHandlerProtocol {
    public let identifier = "ArmadraNativePlugin"
    public let jsName = "ArmadraNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getSessions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getRemotes", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRemote", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeRemote", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "peek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pushRegistration", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pushRotated", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ackPushRotation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExternal", returnType: CAPPluginReturnPromise),
    ]

    private static let installedFlag = "dev.armadra.mobile.installed"
    /// 只记结果（钉扎成没成、为什么），不记来源以外的任何参数，更不记密钥。
    private static let log = Logger(subsystem: "dev.armadra.mobile", category: "native")
    private let store: SecretStore = KeychainStore()
    private lazy var vault = ConnectionVault(store: store)
    private let ledger = PushTokenLedger()
    /// 这一次 `pushRegistration` 拿到的 APNs 令牌（登记成功时记进 `ledger`）。
    private var pendingToken: String?
    /// 每个来源一份钉扎（Gateway 与个人中转各钉各的）；握手时按主机与端口找。
    private var pins: [Pin] = []
    private var pendingScript: String?
    private var loadingObservation: NSKeyValueObservation?
    private var pushCall: CAPPluginCall?
    private var pushTimeout: DispatchWorkItem?
    private var observers: [NSObjectProtocol] = []

    override public func load() {
        // 钥匙串在卸载重装后还在：第一次启动时清掉上一次安装留下的会话与钉扎。
        let defaults = UserDefaults.standard
        if !defaults.bool(forKey: Self.installedFlag) {
            vault.clearAll()
            store.delete(DeviceKey.account)
            defaults.set(true, forKey: Self.installedFlag)
        }
        pins = vault.pins()

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
        refreshTokenIfRegistered()
    }

    /// 开过推送的：启动时向 APNs 再要一次令牌，与上次登记的不同就标「换过」（R-54）。
    private func refreshTokenIfRegistered() {
        guard ledger.registered else { return }
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized else { return }
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
    }

    // MARK: - 会话（多连接）

    @objc func getSessions(_ call: CAPPluginCall) {
        let sessions = vault.sessions().map { record -> [String: Any] in
            [
                "sourceId": record.sourceId, "origin": record.origin, "via": record.via,
                "accessToken": record.accessToken, "refreshToken": record.refreshToken,
                "expiresAtMs": record.expiresAtMs,
            ]
        }
        call.resolve(["sessions": sessions])
    }

    @objc func setSession(_ call: CAPPluginCall) {
        guard let session = call.getObject("session"),
              let sourceId = session["sourceId"] as? String,
              let origin = session["origin"] as? String,
              let via = session["via"] as? String,
              let access = session["accessToken"] as? String,
              let refresh = session["refreshToken"] as? String
        else {
            call.reject("invalid session")
            return
        }
        let expires = (session["expiresAtMs"] as? NSNumber)?.doubleValue ?? 0
        let record = SessionRecord(
            sourceId: sourceId, origin: origin, via: via,
            accessToken: access, refreshToken: refresh, expiresAtMs: expires
        )
        guard ConnectionVault.valid(record) else {
            call.reject("invalid session")
            return
        }
        vault.setSession(record) ? call.resolve() : call.reject("keychain unavailable")
    }

    @objc func removeSession(_ call: CAPPluginCall) {
        guard let sourceId = call.getString("sourceId") else {
            call.reject("invalid session")
            return
        }
        vault.removeSession(sourceId: sourceId, origin: call.getString("origin"))
        call.resolve()
    }

    // MARK: - 远程服务

    @objc func getRemotes(_ call: CAPPluginCall) {
        let remotes = vault.remotes().map { record -> [String: Any] in
            [
                "serviceId": record.serviceId, "issuer": record.issuer, "kind": record.kind,
                "refreshToken": record.refreshToken, "fingerprint": record.fingerprint,
            ]
        }
        call.resolve(["remotes": remotes])
    }

    @objc func setRemote(_ call: CAPPluginCall) {
        guard let remote = call.getObject("remote"),
              let serviceId = remote["serviceId"] as? String,
              let issuer = remote["issuer"] as? String,
              let kind = remote["kind"] as? String,
              let refresh = remote["refreshToken"] as? String,
              let fingerprint = remote["fingerprint"] as? String
        else {
            call.reject("invalid remote")
            return
        }
        let record = RemoteRecord(serviceId: serviceId, issuer: issuer, kind: kind, refreshToken: refresh, fingerprint: fingerprint)
        guard ConnectionVault.valid(record) else {
            call.reject("invalid remote")
            return
        }
        vault.setRemote(record) ? call.resolve() : call.reject("keychain unavailable")
    }

    @objc func removeRemote(_ call: CAPPluginCall) {
        guard let serviceId = call.getString("serviceId") else {
            call.reject("invalid remote")
            return
        }
        vault.removeRemote(serviceId: serviceId)
        call.resolve()
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
            Self.log.info("pin: fetched \(fetched?.all.count ?? -1, privacy: .public) certificate(s)")
            if let fetched {
                guard let anchor = PinPolicy.anchor(presented: fetched.all, pin: pin) else {
                    Self.log.error("pin: no fetched certificate matches the pinned fingerprint")
                    call.reject("fingerprint mismatch")
                    return
                }
                pin.anchor = anchor
            }
            guard self.vault.setPin(pin) else {
                Self.log.error("pin: keychain write failed")
                call.reject("keychain unavailable")
                return
            }
            DispatchQueue.main.async {
                // 同一个来源重钉是替换，别的来源的钉扎不动。
                self.pins.removeAll { PinPolicy.originKey($0.origin) == PinPolicy.originKey(pin.origin) }
                self.pins.append(pin)
                call.resolve()
            }
        }
    }

    /// 不带凭据取一次信任锚指纹，让页面把它给人核对（个人中转自签 CA 的首次信任）。
    /// 什么也不存：真正的钉扎要等人确认之后页面再调 `pin`。
    ///
    /// 指纹取服务端发的 `/ca.crt`（与中转启动日志打印的同一个），没有就取握手链最后一张。
    /// `trusted` 是系统本来就信这条链（ACME 等），`pinned` 是已经钉过、而且服务端仍发着那一张。
    @objc func peek(_ call: CAPPluginCall) {
        guard let origin = call.getString("origin"), PinPolicy.isOrigin(origin), let url = URL(string: origin) else {
            call.reject("bad origin")
            return
        }
        AnchorFetch.run(origin: url) { [weak self] fetched in
            guard let self else { return }
            guard let fetched, let anchor = fetched.body.last ?? fetched.presented.last else {
                call.resolve([:])
                return
            }
            let fingerprint = PinPolicy.fingerprint(anchor)
            DispatchQueue.main.async {
                let existing = self.pins.first { PinPolicy.originKey($0.origin) == PinPolicy.originKey(origin) }
                let pinned = existing.map { PinPolicy.anchor(presented: fetched.all, pin: $0) != nil } ?? false
                call.resolve([
                    "fingerprint": pinned ? existing!.fingerprint : fingerprint,
                    "trusted": fetched.systemTrusted,
                    "pinned": pinned,
                ])
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
        guard let pin = pins.first(where: { $0.covers(host: space.host, port: space.port) }) else {
            completionHandler(.performDefaultHandling, nil)
            return true
        }
        let trusted = PinPolicy.evaluate(trust: trust, host: space.host, pin: pin)
        Self.log.info("tls: pinned origin \(trusted ? "trusted" : "refused", privacy: .public)")
        if trusted {
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
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] granted, _ in
            DispatchQueue.main.async {
                guard let self else { return }
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
        let hex = token.map { String(format: "%02x", $0) }.joined()
        guard pushCall != nil else {
            // 没人在等：启动时的那一次。换了就告诉页面。
            if ledger.observe(token: hex) { notifyListeners("pushTokenRotated", data: [:]) }
            return
        }
        guard let key = DeviceKey.loadOrCreate(store) else {
            finishPush(nil, error: "keychain unavailable")
            return
        }
        pendingToken = hex
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
            if let token = pendingToken { ledger.didRegister(token: token) }
            pendingToken = nil
            call.resolve(["registration": registration])
        } else {
            call.reject(error ?? "failed")
        }
    }

    @objc func pushRotated(_ call: CAPPluginCall) {
        call.resolve(["rotated": ledger.rotated])
    }

    @objc func ackPushRotation(_ call: CAPPluginCall) {
        ledger.acknowledge()
        call.resolve()
    }

    // MARK: - 系统浏览器

    /// 原生 OAuth 的授权页（R-56）：在系统浏览器里走完，回调经 `armadra://oauth` 深链回来。
    @objc func openExternal(_ call: CAPPluginCall) {
        guard let url = ExternalUrl.browsable(call.getString("url") ?? "") else {
            call.reject("bad url")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                opened ? call.resolve() : call.reject("no browser")
            }
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
    /// 取到的东西：握手链、`/ca.crt` 的正文、以及系统是否本来就信这条链。
    struct Fetched {
        let presented: [Data]
        let body: [Data]
        let systemTrusted: Bool
        var all: [Data] { presented + body }
    }

    private var presented: [Data] = []
    private var systemTrusted = false

    static func run(origin: URL, completion: @escaping (Fetched?) -> Void) {
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
                completion(Fetched(presented: delegate.presented, body: body, systemTrusted: delegate.systemTrusted))
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
        // 先看系统信不信，再放行这一次取证书的请求。
        var error: CFError?
        systemTrusted = SecTrustEvaluateWithError(trust, &error)
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
