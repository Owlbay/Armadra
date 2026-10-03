import ArmadraNativeKit
import UserNotifications

/// 推送解密（补全架构 §10、契约 §19.5）：APNs 送来的只有密文 `enc` 与占位的本地化
/// 标题 / 正文；这里用钥匙串里的设备私钥解开，换上真正的标题、正文，把深链写进
/// `userInfo["url"]` 给 App 点开时用。解不开就原样显示占位文案（「有新通知」）。
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var content: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        self.content = content
        var info = content.userInfo
        let envelope = info.removeValue(forKey: "enc")
        content.userInfo = info
        if let envelope,
           let key = DeviceKey.load(KeychainStore()),
           let plaintext = try? PushEnvelope.open(envelope, privateKey: key),
           let payload = try? PushEnvelope.payload(plaintext) {
            content.title = payload.title
            content.body = payload.body
            content.threadIdentifier = payload.kind
            info["url"] = payload.url
            content.userInfo = info
        }
        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let contentHandler, let content {
            contentHandler(content)
        }
    }
}
