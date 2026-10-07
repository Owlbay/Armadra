import { runInThisContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bundleBridge } from "../scripts/prepare-web.mjs";
import { nativeBridge } from "../../web/src/mobile/native-bridge";

/** core 发的会话密钥形状：`<32 位十六进制>.<43 位 base64url>`。 */
const TOKEN_A = `${"0".repeat(32)}.${"a".repeat(43)}`;
const TOKEN_B = `${"1".repeat(32)}.${"b".repeat(43)}`;

const METHODS = [
  "getSessions",
  "setSession",
  "removeSession",
  "getRemotes",
  "setRemote",
  "removeRemote",
  "peek",
  "pin",
  "scan",
  "pushRegistration",
];

type Scope = Record<string, unknown>;
const scope = globalThis as unknown as Scope;

/**
 * 扮演 Capacitor 的原生注入（`native-bridge.js` + 插件清单），再执行打好的插件桥：
 * 页面的 `nativeBridge()` 应当认到插件，调用落到 `nativePromise("ArmadraNative", …)`。
 */
async function boot(answer: (method: string, options: unknown) => unknown) {
  const nativePromise = vi.fn(
    (plugin: string, method: string, options: unknown) =>
      plugin === "ArmadraNative"
        ? Promise.resolve(answer(method, options))
        : Promise.reject(new Error("unknown plugin")),
  );
  scope.androidBridge = { postMessage: () => undefined };
  scope.Capacitor = {
    PluginHeaders: [
      {
        name: "ArmadraNative",
        methods: METHODS.map((name) => ({ name, rtype: "promise" })),
      },
    ],
    nativePromise,
    nativeCallback: vi.fn(),
  };
  vi.stubGlobal("location", new URL("https://localhost/"));
  runInThisContext(await bundleBridge());
  return nativePromise;
}

afterEach(() => {
  delete scope.androidBridge;
  delete scope.Capacitor;
  vi.unstubAllGlobals();
});

describe("plugin bridge", () => {
  it("registers ArmadraNative where the page looks for it", async () => {
    const calls = await boot((method) =>
      method === "getSessions"
        ? {
            sessions: [
              {
                sourceId: "h1",
                origin: "https://192.168.1.20:8443",
                via: "direct",
                accessToken: TOKEN_A,
                refreshToken: TOKEN_B,
                expiresAtMs: 1_000,
              },
            ],
          }
        : method === "scan"
          ? { text: "armadra://pair?host=h&ticket=t&fp=f" }
          : {},
    );
    const bridge = nativeBridge();
    expect(bridge.available).toBe(true);
    expect(bridge.canScan).toBe(true);
    await expect(bridge.getSessions()).resolves.toEqual([
      {
        sourceId: "h1",
        origin: "https://192.168.1.20:8443",
        via: "direct",
        accessToken: TOKEN_A,
        refreshToken: TOKEN_B,
        expiresAtMs: 1_000,
      },
    ]);
    await expect(bridge.scan()).resolves.toBe(
      "armadra://pair?host=h&ticket=t&fp=f",
    );
    await bridge.pin("https://192.168.1.20:8443", "c".repeat(64));
    expect(calls).toHaveBeenCalledWith("ArmadraNative", "pin", {
      origin: "https://192.168.1.20:8443",
      fingerprint: "c".repeat(64),
    });
  });

  it("lets a native pin failure reach the page", async () => {
    await boot((method) => {
      if (method === "pin") throw new Error("fingerprint mismatch");
      return {};
    });
    await expect(
      nativeBridge().pin("https://h:1", "d".repeat(64)),
    ).rejects.toThrow("fingerprint mismatch");
  });

  it("passes the relay registration through with its public key", async () => {
    await boot(() => ({
      registration: {
        platform: "android",
        transport: "relay",
        token: "relay-token",
        publicKey: "Mb0wddPMedULBQlg6Q4uAX0WLJV1JM94c8COF_6jnWM",
      },
    }));
    await expect(nativeBridge().pushRegistration()).resolves.toEqual({
      platform: "android",
      transport: "relay",
      token: "relay-token",
      publicKey: "Mb0wddPMedULBQlg6Q4uAX0WLJV1JM94c8COF_6jnWM",
    });
  });

  it("keeps several sessions and remotes, one per connection", async () => {
    const calls = await boot((method) => {
      if (method === "getRemotes")
        return {
          remotes: [
            {
              serviceId: "personal:relay.example",
              issuer: "https://relay.example",
              kind: "personal",
              refreshToken: "r".repeat(40),
              fingerprint: "e".repeat(64),
            },
            { serviceId: "bad id", issuer: "x", kind: "personal" },
          ],
        };
      if (method === "peek")
        return { fingerprint: "f".repeat(64), trusted: false, pinned: false };
      return {};
    });
    const bridge = nativeBridge();
    await bridge.setSession({
      sourceId: "h2",
      origin: "https://relay.example",
      via: "relayed",
      accessToken: TOKEN_A,
      refreshToken: TOKEN_B,
      expiresAtMs: 0,
    });
    await bridge.removeSession("h2", "https://relay.example");
    await bridge.removeRemote("personal:relay.example");
    expect(calls).toHaveBeenCalledWith("ArmadraNative", "removeSession", {
      sourceId: "h2",
      origin: "https://relay.example",
    });
    await expect(bridge.getRemotes()).resolves.toHaveLength(1);
    await expect(bridge.peek("https://relay.example")).resolves.toEqual({
      fingerprint: "f".repeat(64),
      trusted: false,
      pinned: false,
    });
  });
});
