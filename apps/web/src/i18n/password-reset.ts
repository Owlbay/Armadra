import type { MessageModule } from "./index";

/**
 * 口令重置链接：签发对话框与整页「设置新口令」（G5-03，契约 §25）。
 *
 * G5-00 先登记空模块，免得各包同时改 `index.ts`；键由实现它的包填，两种语言
 * 同步加。
 */
export const passwordReset: MessageModule = {
  "zh-CN": {
    "reset.title": "设置新口令",
    "reset.password": "新口令",
    "reset.repeat": "再输一次",
    "reset.mismatch": "两次输入不一样",
    "reset.submit": "设置口令",
    "reset.invalid": "链接已失效",
    "reset.invalidHint": "请联系管理员重新签发",
    "reset.done": "口令已设置",
    "reset.signIn": "去登录",
    "reset.expires": "{time} 前有效",
    "reset.issue": "签发重置链接",
    "reset.link": "重置链接",
    "reset.qr": "重置链接二维码",
    "reset.copy": "复制",
    "reset.copied": "已复制",
  },
  en: {
    "reset.title": "Set a new password",
    "reset.password": "New password",
    "reset.repeat": "Repeat password",
    "reset.mismatch": "Passwords don't match",
    "reset.submit": "Set password",
    "reset.invalid": "This link is no longer valid",
    "reset.invalidHint": "Ask your administrator for a new one",
    "reset.done": "Password set",
    "reset.signIn": "Sign in",
    "reset.expires": "Valid until {time}",
    "reset.issue": "Issue reset link",
    "reset.link": "Reset link",
    "reset.qr": "Reset link QR code",
    "reset.copy": "Copy",
    "reset.copied": "Copied",
  },
};
