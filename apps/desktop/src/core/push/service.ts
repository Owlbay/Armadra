import type { DatabaseSync } from "node:sqlite";
import { definition } from "../agent/registry";
import type { CoreLog } from "../platform";
import type { CompletionSettings } from "../settings/schema";
import { type PushConfig, nativeStatus, resolvePushConfig } from "./config";
import type { VapidKeys } from "./crypto";
import { DeviceStore } from "./devices";
import { Outbox, PushDispatcher } from "./outbox";
import { ApnsClient, FcmClient, directSender } from "./transport-direct";
import { logSender } from "./transport-log";
import { relaySender } from "./transport-relay";
import { unifiedPushSender } from "./transport-unifiedpush";
import { loadVapidKeys, webPushSender } from "./transport-webpush";
import { type Draft, type EventFrame, TriggerRules, render } from "./triggers";
import type { PushDevice, PushSender } from "./types";

/** 设备要不要收这一种（契约 §27.1）：没设过偏好 = 全部；测试恒收。 */
export function wants(device: PushDevice, kind: Draft["kind"]): boolean {
  if (kind === "test" || device.kinds === null) return true;
  return (device.kinds as readonly string[]).includes(kind);
}

/**
 * 推送域的装配体：设备、队列、发送循环、触发规则与按设置选出的发送器。
 *
 * 发送器按「当时的设置」现选，并按配置的指纹缓存：设置页改了 APNs 的密钥路径，
 * 下一条通知就用新的客户端，旧的 HTTP/2 连接关掉。
 */

export interface PushServiceOptions {
  readonly database: DatabaseSync;
  readonly dataDir: string;
  readonly log: CoreLog;
  readonly env: NodeJS.ProcessEnv;
  readonly settings: () => CompletionSettings;
  /** 这个 principal 今天对这个工作空间有没有 `canvas:read`。 */
  readonly canRead: (
    principalId: string,
    principalKind: string,
    workspaceId: string,
  ) => boolean;
  readonly fetch?: typeof fetch;
  readonly clock?: () => number;
}

/** `GET /api/push/config` 的形状（契约 §19.1）。 */
export interface PushConfigView {
  readonly webpush: {
    readonly enabled: boolean;
    /** VAPID 公钥（P-256 未压缩点，base64url）；不可用时为 `null`。 */
    readonly publicKey: string | null;
  };
  readonly native: {
    readonly transport: PushConfig["native"];
    readonly status: "ready" | "notConfigured";
    readonly platforms: readonly ("ios" | "android")[];
  };
}

interface Senders {
  readonly fingerprint: string;
  readonly native: PushSender;
  readonly webpush: PushSender | undefined;
  readonly close: () => void;
}

export class PushService {
  readonly devices: DeviceStore;
  readonly outbox: Outbox;
  readonly dispatcher: PushDispatcher;
  private readonly rules = new TriggerRules();
  private readonly clock: () => number;
  private vapid: VapidKeys | null | undefined;
  private senders: Senders | undefined;
  private unifiedpush: PushSender | undefined;

  constructor(private readonly options: PushServiceOptions) {
    this.clock = options.clock ?? Date.now;
    this.devices = new DeviceStore(options.database, this.clock);
    this.outbox = new Outbox(options.database, this.clock);
    this.dispatcher = new PushDispatcher({
      outbox: this.outbox,
      devices: this.devices,
      senderFor: (device) => this.senderFor(device),
      log: options.log,
      clock: this.clock,
    });
  }

  config(): PushConfig {
    const settings = this.options.settings();
    return resolvePushConfig(
      settings.push,
      this.options.env,
      settings.gateway.publicOrigin,
    );
  }

  /** VAPID 密钥对：第一次要用时读或生成，坏文件记一次警告后 Web Push 不可用。 */
  vapidKeys(): VapidKeys | null {
    if (this.vapid === undefined) {
      try {
        this.vapid = loadVapidKeys(this.options.dataDir);
      } catch (error) {
        this.options.log.warn("VAPID 密钥不可用，Web Push 关闭", {
          error: (error as Error).message,
        });
        this.vapid = null;
      }
    }
    return this.vapid;
  }

  view(): PushConfigView {
    const config = this.config();
    const status = nativeStatus(config);
    const platforms: ("ios" | "android")[] =
      config.native === "relay" && status === "ready"
        ? ["ios", "android"]
        : config.native === "direct"
          ? [
              ...(config.apns === undefined ? [] : (["ios"] as const)),
              ...(config.fcm === undefined ? [] : (["android"] as const)),
            ]
          : [];
    return {
      webpush: {
        enabled: config.webpush.enabled,
        publicKey: config.webpush.enabled
          ? (this.vapidKeys()?.publicKey ?? null)
          : null,
      },
      native: { transport: config.native, status, platforms },
    };
  }

  private build(config: PushConfig): Senders {
    const log = this.options.log;
    const closers: (() => void)[] = [];
    let native: PushSender;
    const status = nativeStatus(config);
    if (status !== "ready") {
      native = logSender(log, `native:${config.native}`);
    } else if (config.native === "relay") {
      native = relaySender({
        url: config.relayUrl,
        ...(this.options.fetch === undefined
          ? {}
          : { fetch: this.options.fetch }),
      });
    } else {
      let apns: ApnsClient | undefined;
      let fcm: FcmClient | undefined;
      try {
        if (config.apns !== undefined) {
          apns = new ApnsClient(config.apns, this.clock);
          const client = apns;
          closers.push(() => client.close());
        }
      } catch (error) {
        log.warn("APNs 密钥读不出来，iOS 直连推送不可用", {
          error: (error as Error).message,
        });
      }
      try {
        if (config.fcm !== undefined) {
          fcm = new FcmClient(config.fcm, this.options.fetch, this.clock);
        }
      } catch (error) {
        log.warn("FCM 服务账号读不出来，Android 直连推送不可用", {
          error: (error as Error).message,
        });
      }
      native = directSender({
        ...(apns === undefined ? {} : { apns }),
        ...(fcm === undefined ? {} : { fcm }),
      });
    }
    const keys = config.webpush.enabled ? this.vapidKeys() : null;
    const webpush =
      keys === null
        ? undefined
        : webPushSender({
            keys,
            subject: config.webpush.subject,
            now: this.clock,
            ...(this.options.fetch === undefined
              ? {}
              : { fetch: this.options.fetch }),
          });
    return {
      fingerprint: JSON.stringify(config),
      native,
      webpush,
      close: () => {
        for (const close of closers) close();
      },
    };
  }

  senderFor(device: PushDevice): PushSender {
    // UnifiedPush 按设备走（契约 §27.2）：端点是这台手机自己报上来的，与
    // `push.transport` 无关，不需要任何服务端配置。
    if (device.unifiedpushEndpoint !== "") {
      this.unifiedpush ??= unifiedPushSender(
        this.options.fetch === undefined ? {} : { fetch: this.options.fetch },
      );
      return this.unifiedpush;
    }
    const config = this.config();
    const fingerprint = JSON.stringify(config);
    if (this.senders?.fingerprint !== fingerprint) {
      this.senders?.close();
      this.senders = this.build(config);
    }
    const senders = this.senders;
    if (device.transport === "webpush") {
      return senders.webpush ?? logSender(this.options.log, "webpush:disabled");
    }
    if (device.transport !== config.native) {
      // App 按旧配置登记的（比如登记时是直连、现在改成了中继）：令牌在这条路上
      // 没有意义，只记一笔，等 App 下次启动按新配置重新登记。
      return logSender(
        this.options.log,
        `transportMismatch:${device.transport}`,
      );
    }
    return senders.native;
  }

  /* --------------------------------- 触发 --------------------------------- */

  private workspaceName(workspaceId: string): string {
    const row = this.options.database
      .prepare("SELECT name FROM workspaces WHERE id = ?")
      .get(workspaceId) as { name?: string } | undefined;
    return row?.name ?? "";
  }

  private agentName(draft: Draft): string {
    let agentId = draft.agentId;
    if (agentId === undefined && draft.nodeId !== undefined) {
      try {
        const row = this.options.database
          .prepare("SELECT agent_id FROM agent_status WHERE node_id = ?")
          .get(draft.nodeId) as { agent_id?: string } | undefined;
        agentId = row?.agent_id;
      } catch {
        agentId = undefined;
      }
    }
    return (
      (agentId === undefined ? undefined : definition(agentId)?.label) ??
      "Agent"
    );
  }

  /** 一条草稿 → 每台有权限的设备一行队列。返回入队的条数。 */
  enqueue(draft: Draft, only?: (device: PushDevice) => boolean): number {
    const recipients = this.devices.recipients();
    if (recipients.length === 0) return 0;
    const allowed = new Map<string, boolean>();
    const names = {
      workspace: this.workspaceName(draft.workspaceId),
      agent: (value: Draft) => this.agentName(value),
    };
    let queued = 0;
    for (const { device, principalKind } of recipients) {
      if (only !== undefined && !only(device)) continue;
      if (!wants(device, draft.kind)) continue;
      if (
        draft.principals !== undefined &&
        !draft.principals.includes(device.principalId)
      ) {
        continue;
      }
      let ok = allowed.get(device.principalId);
      if (ok === undefined) {
        ok = this.options.canRead(
          device.principalId,
          principalKind,
          draft.workspaceId,
        );
        allowed.set(device.principalId, ok);
      }
      if (!ok) continue;
      this.outbox.enqueue(device.deviceId, render(draft, device.locale, names));
      queued += 1;
    }
    if (queued > 0) this.dispatcher.kick();
    return queued;
  }

  handleEvent(workspaceId: string, event: EventFrame): number {
    const draft = this.rules.draft(workspaceId, event);
    return draft === undefined ? 0 : this.enqueue(draft);
  }

  /** 给一台设备发一条测试通知（`POST /api/push/test`）。 */
  sendTest(device: PushDevice): string {
    const id = this.outbox.enqueue(
      device.deviceId,
      render(
        { kind: "test", workspaceId: "", tag: `test:${device.deviceId}` },
        device.locale,
        { workspace: "Armadra", agent: () => "" },
      ),
    );
    this.dispatcher.kick();
    return id;
  }

  start(): void {
    this.outbox.prune(this.clock());
    // 上次没发完的接着发。
    this.dispatcher.kick();
  }

  stop(): void {
    this.dispatcher.stop();
    this.senders?.close();
    this.senders = undefined;
  }
}
