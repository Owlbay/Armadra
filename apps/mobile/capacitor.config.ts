import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Armadra 手机壳（补全架构 §10）。
 *
 * 页面是 `apps/web` 的生产构建，`scripts/prepare-web.mjs` 把它连同插件桥一起
 * 拷进 `www/`，再由 `cap sync` 打进安装包——**不配 `server.url`**：商店审核
 * 不收远程网页壳（外部服务 §5.1），也不做 OTA，版本随桌面 / 服务器一起发。
 *
 * 来源固定为 iOS `capacitor://localhost`、Android `https://localhost`，Gateway
 * 的 CORS 只放行这两个（`core/gateway/admission.ts`），所以 scheme 与主机名
 * 都用缺省值，不许改。
 */
const relayUrl = process.env.ARMADRA_MOBILE_RELAY_URL?.trim() ?? "";

const config: CapacitorConfig = {
  appId: "dev.armadra.mobile",
  appName: "Armadra",
  webDir: "www",
  loggingBehavior: "debug",
  ios: {
    contentInset: "never",
    limitsNavigationsToAppBoundDomains: false,
  },
  android: {
    allowMixedContent: false,
    captureInput: false,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    ArmadraNative: {
      // 商店版走发布方的推送中继（`apps/push-relay`）；空 = 自建 App 直连
      // APNs / FCM（契约 §19.5 的 `direct`）。构建时由环境变量注入。
      relayUrl,
    },
  },
};

export default config;
