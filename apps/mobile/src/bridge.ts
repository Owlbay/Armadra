import { registerPlugin } from "@capacitor/core";

/**
 * 插件桥：把原生插件 `ArmadraNative` 登记进 `window.Capacitor.Plugins`。
 *
 * 页面（`apps/web`）不依赖 `@capacitor/core`，只认
 * `Capacitor.Plugins.ArmadraNative`（`apps/web/src/mobile/native-bridge.ts`）；
 * 而 Capacitor 的原生注入只提供 `nativePromise` 与插件清单，`Plugins` 表由
 * `@capacitor/core` 的 `registerPlugin` 填。所以 `scripts/prepare-web.mjs` 把这一个
 * 文件打成 IIFE（`armadra-native.js`），以普通 `<script>` 插在页面的模块脚本之前：
 * 页面求值时插件已经在了。
 *
 * 方法与返回的形状见 `native-bridge.ts` 文件头；原生实现在
 * `ios/App/App/ArmadraNativePlugin.swift` 与 `android/app/src/main/java/dev/armadra/mobile/ArmadraNativePlugin.java`。
 */
export interface StoredSession {
  readonly sourceId: string;
  readonly origin: string;
  readonly via: "direct" | "relayed";
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAtMs: number;
}

export interface StoredRemote {
  readonly serviceId: string;
  readonly issuer: string;
  readonly kind: "personal" | "saas";
  readonly refreshToken: string;
  readonly fingerprint: string;
}

export interface ArmadraNativePlugin {
  getSessions(): Promise<{ sessions?: StoredSession[] }>;
  setSession(options: { session: StoredSession }): Promise<void>;
  removeSession(options: { sourceId: string; origin?: string }): Promise<void>;
  getRemotes(): Promise<{ remotes?: StoredRemote[] }>;
  setRemote(options: { remote: StoredRemote }): Promise<void>;
  removeRemote(options: { serviceId: string }): Promise<void>;
  peek(options: { origin: string }): Promise<{
    fingerprint?: string;
    trusted?: boolean;
    pinned?: boolean;
  }>;
  pin(options: { origin: string; fingerprint: string }): Promise<void>;
  scan(): Promise<{ text?: string }>;
  appInfo(): Promise<{ version?: string; build?: string }>;
  pushRegistration(): Promise<{
    registration?: {
      platform: "ios" | "android";
      transport: "direct" | "relay";
      token: string;
      publicKey?: string;
    };
  }>;
}

export const PLUGIN_NAME = "ArmadraNative";

export const ArmadraNative = registerPlugin<ArmadraNativePlugin>(PLUGIN_NAME);
