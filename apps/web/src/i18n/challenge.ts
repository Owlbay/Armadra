import type { MessageModule } from "./index";

/** 人机验证面板（契约 §62）：登录远程服务要先过中继的 Turnstile 挑战。 */
export const challenge: MessageModule = {
  "zh-CN": {
    "challenge.title": "人机验证",
    "challenge.loading": "正在加载",
    "challenge.loadFailed": "验证没能加载",
    "challenge.retry": "重试",
  },
  en: {
    "challenge.title": "Human check",
    "challenge.loading": "Loading",
    "challenge.loadFailed": "The check couldn't load",
    "challenge.retry": "Retry",
  },
};
