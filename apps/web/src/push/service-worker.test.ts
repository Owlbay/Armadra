import { describe, expect, it, vi } from "vitest";
import {
  PUSH_OPEN_MESSAGE,
  type PushPageEnvironment,
  type PushWorkerScope,
  installPushHandlers,
  openUrl,
  parsePushData,
  subscribeToPush,
} from "./service-worker";

const PAYLOAD = {
  v: 1,
  kind: "approval",
  title: "支付服务",
  body: "Claude Code 等待审批",
  url: "armadra://w/w1/n/n1",
  tag: "approval:p1",
};

function data(value: unknown) {
  return { json: () => value };
}

function fakeScope(windows: { url: string }[] = []) {
  const listeners = new Map<string, (event: never) => void>();
  const shown: unknown[] = [];
  const opened: string[] = [];
  const posted: unknown[] = [];
  const focused: string[] = [];
  const scope = {
    addEventListener: (type: string, listener: (event: never) => void) => {
      listeners.set(type, listener);
    },
    registration: {
      scope: "https://armadra.example/",
      showNotification: (title: string, options: unknown) => {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      matchAll: () =>
        Promise.resolve(
          windows.map((window) => ({
            url: window.url,
            focus: () => {
              focused.push(window.url);
              return Promise.resolve();
            },
            postMessage: (message: unknown) => posted.push(message),
          })),
        ),
      openWindow: (url: string) => {
        opened.push(url);
        return Promise.resolve();
      },
    },
  } as unknown as PushWorkerScope;
  installPushHandlers(scope);
  const fire = async (type: string, event: object) => {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)?.({
      ...event,
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    } as never);
    await Promise.all(waits);
  };
  return { fire, shown, opened, posted, focused };
}

describe("worker：收推送", () => {
  it("按载荷出通知，深链放进 data", async () => {
    const scope = fakeScope();
    await scope.fire("push", { data: data(PAYLOAD) });
    expect(scope.shown).toEqual([
      {
        title: "支付服务",
        options: {
          body: "Claude Code 等待审批",
          tag: "approval:p1",
          data: { url: "armadra://w/w1/n/n1", kind: "approval" },
        },
      },
    ]);
  });

  it("认不出来的载荷不显示：多一个字段、不是 armadra 深链、坏 JSON", async () => {
    expect(parsePushData(data({ ...PAYLOAD, output: "终端原文" }))).toBe(
      undefined,
    );
    expect(parsePushData(data({ ...PAYLOAD, url: "https://evil" }))).toBe(
      undefined,
    );
    expect(
      parsePushData({
        json: () => {
          throw new SyntaxError("bad");
        },
      }),
    ).toBe(undefined);
    expect(parsePushData(null)).toBe(undefined);
    const scope = fakeScope();
    await scope.fire("push", { data: data({ title: "x" }) });
    expect(scope.shown).toEqual([]);
  });
});

describe("worker：点通知", () => {
  it("已经开着的页面：聚焦并把深链交给它", async () => {
    const scope = fakeScope([{ url: "https://armadra.example/#/w1" }]);
    const close = vi.fn();
    await scope.fire("notificationclick", {
      notification: { data: { url: "armadra://w/w1/n/n1" }, close },
    });
    expect(close).toHaveBeenCalled();
    expect(scope.focused).toEqual(["https://armadra.example/#/w1"]);
    expect(scope.posted).toEqual([
      { type: PUSH_OPEN_MESSAGE, url: "armadra://w/w1/n/n1" },
    ]);
    expect(scope.opened).toEqual([]);
  });

  it("没有开着的页面：开一个，深链在片段里", async () => {
    const scope = fakeScope();
    await scope.fire("notificationclick", {
      notification: { data: { url: "javascript:alert(1)" }, close: () => {} },
    });
    expect(scope.opened).toEqual([
      openUrl("https://armadra.example/", "armadra://"),
    ]);
    expect(scope.opened[0]).toBe(
      "https://armadra.example/#push=armadra%3A%2F%2F",
    );
  });
});

describe("页面：订阅并登记", () => {
  function environment(
    overrides: Partial<PushPageEnvironment> = {},
    config: unknown = {
      webpush: { enabled: true, publicKey: "BAAA" },
      native: { transport: "log", status: "notConfigured", platforms: [] },
    },
  ) {
    const registered: unknown[] = [];
    const subscribe = vi.fn(() =>
      Promise.resolve({
        toJSON: () => ({
          endpoint: "https://push.example/wp/1",
          keys: { p256dh: "p", auth: "a" },
          expirationTime: null,
        }),
      }),
    );
    const env: PushPageEnvironment = {
      serviceWorker: {
        register: () =>
          Promise.resolve({
            pushManager: {
              getSubscription: () => Promise.resolve(null),
              subscribe,
            },
          }),
      },
      requestPermission: () => Promise.resolve("granted"),
      api: {
        config: () => Promise.resolve(config),
        register: (body) => {
          registered.push(body);
          return Promise.resolve({
            device: {
              deviceId: "d1",
              platform: "web",
              transport: "webpush",
              appVersion: "",
              locale: "en",
              encrypted: true,
              createdAt: "2026-10-03T00:00:00.000Z",
              current: true,
            },
          });
        },
      },
      ...overrides,
    };
    return { env, registered, subscribe };
  }

  it("取公钥 → 订阅 → 登记订阅（不带 expirationTime）", async () => {
    const { env, registered, subscribe } = environment();
    expect(await subscribeToPush("/push-sw.js", "en", env)).toEqual({
      ok: true,
      deviceId: "d1",
    });
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: Uint8Array.from([4, 0, 0]),
    });
    expect(registered).toEqual([
      {
        platform: "web",
        transport: "webpush",
        subscription: {
          endpoint: "https://push.example/wp/1",
          keys: { p256dh: "p", auth: "a" },
        },
        locale: "en",
      },
    ]);
  });

  it("不支持、被关、被拒都不登记", async () => {
    const unsupported = environment();
    const { serviceWorker: _, ...withoutWorker } = unsupported.env;
    expect(await subscribeToPush("/sw.js", "zh-CN", withoutWorker)).toEqual({
      ok: false,
      reason: "unsupported",
    });
    const disabled = environment(
      {},
      {
        webpush: { enabled: false, publicKey: null },
        native: { transport: "log", status: "notConfigured", platforms: [] },
      },
    );
    expect(await subscribeToPush("/sw.js", "zh-CN", disabled.env)).toEqual({
      ok: false,
      reason: "disabled",
    });
    const denied = environment({
      requestPermission: () => Promise.resolve("denied"),
    });
    expect(await subscribeToPush("/sw.js", "zh-CN", denied.env)).toEqual({
      ok: false,
      reason: "denied",
    });
    expect([
      ...unsupported.registered,
      ...disabled.registered,
      ...denied.registered,
    ]).toEqual([]);
  });
});
