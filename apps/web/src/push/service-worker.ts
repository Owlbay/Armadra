import {
  type PushPayload,
  pushConfigSchema,
  pushDeviceResponseSchema,
  pushPayloadSchema,
} from "@armadra/shared";

/**
 * Web Push（契约 §19、外部服务 §5.2 第 1 期）。两半在一个文件里：
 *
 *   * **worker 一半**（{@link installPushHandlers}）：service worker 里收 `push`
 *     事件、按载荷出一条系统通知；点通知时把深链交给已经开着的页面，没有就开
 *     一个。载荷先过 `pushPayloadSchema`——认不出来的不显示，不拿任意字段拼通知。
 *   * **页面一半**（{@link subscribeToPush}）：取 VAPID 公钥、注册 worker、向
 *     浏览器订阅、把订阅登记给 core。权限提示与入口在移动网页包（G2-10 的
 *     `PushPermission`）；那里也负责把 worker 产物挂到站点根下。
 *
 * worker 一半不 import 页面的任何东西（运行时地址、i18n、store）：service
 * worker 里没有 `window`。页面一半的接口调用按需动态加载。
 */

/** 点通知时发给页面的消息；页面据此打开节点焦点页。 */
export const PUSH_OPEN_MESSAGE = "armadra.push.open";

/* ------------------------------- worker 一半 ------------------------------ */

interface PushEventLike {
  readonly data: { json(): unknown } | null;
  waitUntil(promise: Promise<unknown>): void;
}

interface NotificationClickLike {
  readonly notification: { readonly data?: unknown; close(): void };
  waitUntil(promise: Promise<unknown>): void;
}

interface WindowClientLike {
  readonly url: string;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}

/** service worker 全局里用到的那几样（`ServiceWorkerGlobalScope` 的子集）。 */
export interface PushWorkerScope {
  addEventListener(
    type: "push",
    listener: (event: PushEventLike) => void,
  ): void;
  addEventListener(
    type: "notificationclick",
    listener: (event: NotificationClickLike) => void,
  ): void;
  readonly registration: {
    readonly scope: string;
    showNotification(
      title: string,
      options: {
        body: string;
        tag: string;
        data: { url: string; kind: string };
      },
    ): Promise<void>;
  };
  readonly clients: {
    matchAll(options: {
      type: "window";
      includeUncontrolled: boolean;
    }): Promise<readonly WindowClientLike[]>;
    openWindow(url: string): Promise<unknown>;
  };
}

/** 一段推送数据 → 载荷；不是 §19.4 的形状就是 `undefined`。 */
export function parsePushData(
  data: { json(): unknown } | null,
): PushPayload | undefined {
  if (data === null) return undefined;
  try {
    const parsed = pushPayloadSchema.safeParse(data.json());
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** 页面打开深链的地址：深链进片段，不进请求行。 */
export function openUrl(scope: string, deepLink: string): string {
  return `${scope.replace(/\/?$/, "/")}#push=${encodeURIComponent(deepLink)}`;
}

export function installPushHandlers(scope: PushWorkerScope): void {
  scope.addEventListener("push", (event) => {
    const payload = parsePushData(event.data);
    if (payload === undefined) return;
    event.waitUntil(
      scope.registration.showNotification(payload.title, {
        body: payload.body,
        tag: payload.tag,
        data: { url: payload.url, kind: payload.kind },
      }),
    );
  });

  scope.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const data = event.notification.data as { url?: unknown } | undefined;
    const url =
      typeof data?.url === "string" && data.url.startsWith("armadra://")
        ? data.url
        : "armadra://";
    event.waitUntil(
      scope.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then(async (windows) => {
          const open = windows.find((client) =>
            client.url.startsWith(scope.registration.scope),
          );
          if (open !== undefined) {
            await open.focus();
            open.postMessage({ type: PUSH_OPEN_MESSAGE, url });
            return;
          }
          await scope.clients.openWindow(
            openUrl(scope.registration.scope, url),
          );
        }),
    );
  });
}

/* -------------------------------- 页面一半 -------------------------------- */

export type PushSubscribeResult =
  | { readonly ok: true; readonly deviceId: string }
  | {
      readonly ok: false;
      readonly reason: "unsupported" | "disabled" | "denied" | "failed";
    };

/** 页面一半要的浏览器能力；测试换成假的。 */
export interface PushPageEnvironment {
  readonly serviceWorker?: {
    register(url: string): Promise<{
      readonly pushManager: {
        getSubscription(): Promise<{
          toJSON(): unknown;
          unsubscribe(): Promise<boolean>;
        } | null>;
        subscribe(options: {
          userVisibleOnly: true;
          applicationServerKey: Uint8Array;
        }): Promise<{ toJSON(): unknown }>;
      };
    }>;
  };
  requestPermission(): Promise<"granted" | "denied" | "default">;
  readonly api: {
    config(): Promise<unknown>;
    register(body: unknown): Promise<unknown>;
  };
}

function base64UrlBytes(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** 浏览器里的真实环境。接口调用动态加载，worker 一半不被它牵连。 */
export function browserPushEnvironment(): PushPageEnvironment {
  return {
    ...(typeof navigator !== "undefined" && "serviceWorker" in navigator
      ? {
          serviceWorker:
            navigator.serviceWorker as unknown as PushPageEnvironment["serviceWorker"],
        }
      : {}),
    requestPermission: () =>
      typeof Notification === "undefined"
        ? Promise.resolve("denied" as const)
        : Notification.requestPermission(),
    api: {
      config: async () => (await import("../api/push")).pushApi.config(),
      register: async (body) =>
        (await import("../api/push")).pushApi.register(
          body as Record<string, unknown>,
        ),
    },
  };
}

/**
 * 订阅并登记。`workerUrl` 是挂在站点根下的 worker 脚本（作用域要覆盖整个页面）。
 * 已经订阅过的浏览器复用旧订阅；core 那边是覆盖式登记，重复调用无害。
 */
export async function subscribeToPush(
  workerUrl: string,
  locale: "zh-CN" | "en",
  environment: PushPageEnvironment = browserPushEnvironment(),
): Promise<PushSubscribeResult> {
  if (environment.serviceWorker === undefined) {
    return { ok: false, reason: "unsupported" };
  }
  let config;
  try {
    config = pushConfigSchema.parse(await environment.api.config());
  } catch {
    return { ok: false, reason: "failed" };
  }
  const publicKey = config.webpush.publicKey;
  if (!config.webpush.enabled || publicKey === null) {
    return { ok: false, reason: "disabled" };
  }
  if ((await environment.requestPermission()) !== "granted") {
    return { ok: false, reason: "denied" };
  }
  try {
    const registration = await environment.serviceWorker.register(workerUrl);
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlBytes(publicKey),
      }));
    const { endpoint, keys } = subscription.toJSON() as {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    };
    const answer = pushDeviceResponseSchema.parse(
      await environment.api.register({
        platform: "web",
        transport: "webpush",
        subscription: { endpoint, keys },
        locale,
      }),
    );
    return { ok: true, deviceId: answer.device.deviceId };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
