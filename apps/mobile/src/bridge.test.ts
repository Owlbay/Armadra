import { runInThisContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bundleBridge } from "../scripts/prepare-web.mjs";
import { nativeBridge } from "../../web/src/mobile/native-bridge";

const METHODS = [
  "getSession",
  "setSession",
  "clearSession",
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
      method === "getSession"
        ? {
            session: {
              origin: "https://192.168.1.20:8443",
              accessToken: "a".repeat(43),
              refreshToken: "b".repeat(43),
            },
          }
        : method === "scan"
          ? { text: "armadra://pair?host=h&ticket=t&fp=f" }
          : {},
    );
    const bridge = nativeBridge();
    expect(bridge.available).toBe(true);
    expect(bridge.canScan).toBe(true);
    await expect(bridge.loadSession()).resolves.toEqual({
      origin: "https://192.168.1.20:8443",
      accessToken: "a".repeat(43),
      refreshToken: "b".repeat(43),
    });
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
});
