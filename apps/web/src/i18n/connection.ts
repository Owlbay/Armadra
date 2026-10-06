import type { MessageModule } from "./index";

/** 控制面连接的关闭码（契约 §35.2，`api/ws.ts` 的 `CLOSE_MESSAGE_KEYS`）。 */
export const connection: MessageModule = {
  "zh-CN": {
    "connection.closed.normal": "连接已关闭",
    "connection.closed.goingAway": "服务已停止，正在重新连接",
    "connection.closed.badFrame": "收到无法识别的数据，正在重新连接",
    "connection.closed.expired": "登录已过期，正在重新连接",
    "connection.closed.revoked": "访问权限已被收回",
    "connection.closed.protocol": "版本不兼容，更新应用后重新打开",
    "connection.closed.tooLarge": "消息过大，正在重新连接",
    "connection.closed.limit": "订阅数已达上限，刷新页面后重试",
  },
  en: {
    "connection.closed.normal": "Connection closed",
    "connection.closed.goingAway": "Server stopped. Reconnecting",
    "connection.closed.badFrame": "Received unreadable data. Reconnecting",
    "connection.closed.expired": "Session expired. Reconnecting",
    "connection.closed.revoked": "Access was revoked",
    "connection.closed.protocol":
      "Version not compatible. Update the app and reopen it",
    "connection.closed.tooLarge": "Message too large. Reconnecting",
    "connection.closed.limit":
      "Too many subscriptions. Reload the page to try again",
  },
};
