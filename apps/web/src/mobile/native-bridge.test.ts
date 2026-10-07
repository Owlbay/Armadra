import { afterEach, describe, expect, it, vi } from "vitest";

import { isNativeApp, nativeBridge } from "./native-bridge";

// core 发的会话密钥是 `<32 位十六进制>.<43 位 base64url>`（`identity/tokens.ts`）。
const SECRET = `${"0".repeat(32)}.${"a".repeat(43)}`;
const OTHER = `${"1".repeat(32)}.${"b".repeat(43)}`;
const FP = "0".repeat(64);
const ORIGIN = "https://192.168.1.8:8443";

/** 让页面看起来在 Capacitor 原生壳里，插件是给的这个。 */
function inApp(plugin: Record<string, unknown> | undefined) {
  vi.stubGlobal("location", new URL("capacitor://localhost/"));
  vi.stubGlobal("Capacitor", {
    isNativePlatform: () => true,
    Plugins: plugin ? { ArmadraNative: plugin } : {},
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("不在原生 App 里时是空实现", () => {
  it("每个方法都答「没有」，不报错", async () => {
    const bridge = nativeBridge();
    expect(bridge.available).toBe(false);
    expect(bridge.canScan).toBe(false);
    expect(isNativeApp()).toBe(false);
    await expect(bridge.getSessions()).resolves.toEqual([]);
    await expect(bridge.getRemotes()).resolves.toEqual([]);
    await expect(bridge.peek(ORIGIN)).resolves.toBeNull();
    await expect(bridge.scan()).resolves.toBeNull();
    await expect(bridge.pushRegistration()).resolves.toBeNull();
    await expect(bridge.pin(ORIGIN, FP)).resolves.toBeUndefined();
  });

  it("浏览器停在 https://localhost 上也不算 App", () => {
    vi.stubGlobal("location", new URL("https://localhost/"));
    vi.stubGlobal("Capacitor", { isNativePlatform: () => false });
    expect(isNativeApp()).toBe(false);
  });
});

describe("原生插件", () => {
  it("钥匙串里的会话要形状对才用，坏的一份只丢那一份", async () => {
    const good = {
      sourceId: "h1",
      origin: ORIGIN,
      via: "direct" as const,
      accessToken: SECRET,
      refreshToken: OTHER,
      expiresAtMs: 5,
    };
    const plugin = {
      getSessions: vi.fn(async () => ({
        sessions: [
          good,
          { ...good, sourceId: "h2", accessToken: "short" },
          // 只有密钥半段、没有标识的不算会话密钥。
          { ...good, sourceId: "h3", accessToken: "a".repeat(43) },
          { ...good, sourceId: "h4", via: "satellite" },
          { ...good, sourceId: "bad id" },
        ],
      })),
      setSession: vi.fn(async () => undefined),
      removeSession: vi.fn(async () => undefined),
    };
    inApp(plugin);
    const bridge = nativeBridge();
    expect(bridge.available).toBe(true);
    await expect(bridge.getSessions()).resolves.toEqual([good]);
    plugin.getSessions.mockRejectedValueOnce(new Error("locked"));
    await expect(bridge.getSessions()).resolves.toEqual([]);
    await bridge.setSession(good);
    expect(plugin.setSession).toHaveBeenCalledWith({ session: good });
    await bridge.removeSession("h1");
    expect(plugin.removeSession).toHaveBeenCalledWith({ sourceId: "h1" });
    await bridge.removeSession("h1", ORIGIN);
    expect(plugin.removeSession).toHaveBeenLastCalledWith({
      sourceId: "h1",
      origin: ORIGIN,
    });
  });

  it("钉扎失败要抛：钉不上就不能连", async () => {
    const pin = vi.fn(async () => undefined);
    inApp({ pin });
    const bridge = nativeBridge();
    await bridge.pin(ORIGIN, FP);
    expect(pin).toHaveBeenCalledWith({ origin: ORIGIN, fingerprint: FP });
    await expect(bridge.pin(ORIGIN, "nothex")).rejects.toThrow();
    pin.mockRejectedValueOnce(new Error("no"));
    await expect(bridge.pin(ORIGIN, FP)).rejects.toThrow();
    inApp({});
    await expect(nativeBridge().pin(ORIGIN, FP)).rejects.toThrow();
  });

  it("扫码：取消是 null", async () => {
    const scan = vi.fn(async () => ({ text: "armadra://pair?x" }));
    inApp({ scan });
    const bridge = nativeBridge();
    expect(bridge.canScan).toBe(true);
    await expect(bridge.scan()).resolves.toBe("armadra://pair?x");
    scan.mockResolvedValueOnce({} as never);
    await expect(bridge.scan()).resolves.toBeNull();
  });

  it("推送注册：中继必须带公钥", async () => {
    const pushRegistration = vi.fn(
      async (): Promise<unknown> => ({
        registration: { platform: "ios", transport: "direct", token: "tok" },
      }),
    );
    inApp({ pushRegistration });
    const bridge = nativeBridge();
    await expect(bridge.pushRegistration()).resolves.toEqual({
      platform: "ios",
      transport: "direct",
      token: "tok",
    });
    pushRegistration.mockResolvedValueOnce({
      registration: { platform: "android", transport: "relay", token: "tok" },
    });
    await expect(bridge.pushRegistration()).resolves.toBeNull();
    pushRegistration.mockResolvedValueOnce({
      registration: {
        platform: "android",
        transport: "relay",
        token: "tok",
        publicKey: "AbC-_9",
      },
    });
    await expect(bridge.pushRegistration()).resolves.toMatchObject({
      publicKey: "AbC-_9",
    });
  });
});

describe("推送轮换、UnifiedPush 与系统浏览器（G5-22）", () => {
  const KEY = "a".repeat(43);

  it("UnifiedPush：只给 Android、必须带公钥、端点要 https 或回环 http；可以没有令牌", async () => {
    const pushRegistration = vi.fn();
    inApp({ pushRegistration });
    const bridge = nativeBridge();
    const up = (endpoint: string, extra: Record<string, unknown> = {}) => ({
      registration: {
        platform: "android",
        transport: "direct",
        publicKey: KEY,
        unifiedpush: { endpoint },
        ...extra,
      },
    });
    pushRegistration.mockResolvedValueOnce(up("https://ntfy.example/up1?up=1"));
    await expect(bridge.pushRegistration()).resolves.toEqual({
      platform: "android",
      transport: "direct",
      publicKey: KEY,
      unifiedpush: { endpoint: "https://ntfy.example/up1?up=1" },
    });
    pushRegistration.mockResolvedValueOnce(up("http://127.0.0.1:8093/t?up=1"));
    await expect(bridge.pushRegistration()).resolves.not.toBeNull();
    for (const bad of [
      up("http://ntfy.example/t"),
      up("https://user:pw@ntfy.example/t"),
      up("https://ntfy.example/t#x"),
      up("javascript:alert(1)"),
      up("https://ntfy.example/t", { platform: "ios" }),
      up("https://ntfy.example/t", { publicKey: undefined }),
      { registration: { platform: "android", transport: "direct" } },
    ]) {
      pushRegistration.mockResolvedValueOnce(bad);
      await expect(bridge.pushRegistration()).resolves.toBeNull();
    }
  });

  it("令牌换过：查询、确认与事件订阅；插件旧（没有这些方法）时都是「没有」", async () => {
    const remove = vi.fn();
    let fire: () => void = () => undefined;
    const plugin = {
      pushRotated: vi.fn(async () => ({ rotated: true })),
      ackPushRotation: vi.fn(async () => undefined),
      addListener: vi.fn(async (_event: string, listener: () => void) => {
        fire = listener;
        return { remove };
      }),
    };
    inApp(plugin);
    const bridge = nativeBridge();
    await expect(bridge.pushRotated()).resolves.toBe(true);
    await bridge.ackPushRotation();
    expect(plugin.ackPushRotation).toHaveBeenCalledTimes(1);
    const heard = vi.fn();
    const stop = bridge.onPushRotated(heard);
    await Promise.resolve();
    await Promise.resolve();
    expect(plugin.addListener).toHaveBeenCalledWith("pushTokenRotated", heard);
    fire();
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    expect(remove).toHaveBeenCalledTimes(1);

    inApp({});
    const old = nativeBridge();
    await expect(old.pushRotated()).resolves.toBe(false);
    expect(old.onPushRotated(() => undefined)).toBeTypeOf("function");
    await expect(old.openExternal("https://idp.example/a")).resolves.toBe(
      false,
    );
  });

  it("系统浏览器只开 https 与回环 http", async () => {
    const openExternal = vi.fn(async () => undefined);
    inApp({ openExternal });
    const bridge = nativeBridge();
    await expect(
      bridge.openExternal("https://idp.example/authorize?x=1"),
    ).resolves.toBe(true);
    await expect(bridge.openExternal("http://127.0.0.1:5556/a")).resolves.toBe(
      true,
    );
    for (const bad of [
      "http://idp.example/a",
      "javascript:alert(1)",
      "armadra://oauth?state=x",
      "https://u:p@idp.example/",
    ]) {
      await expect(bridge.openExternal(bad)).resolves.toBe(false);
    }
    expect(openExternal).toHaveBeenCalledTimes(2);
    openExternal.mockRejectedValueOnce(new Error("no browser"));
    await expect(bridge.openExternal("https://idp.example/")).resolves.toBe(
      false,
    );
  });
});
