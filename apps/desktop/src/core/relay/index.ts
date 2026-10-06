/**
 * 出站中继隧道（契约 §32，平台规格 core 包 §4）：让登记过的远程服务的客户端经中继
 * 访问本机 core。每个有效登记（`cloud_registrations`，A2-3）一条隧道；隧道来的
 * 每条流交给一个只给隧道用的监听（`createListener({ admitted: true, gate })`），
 * 准入按 Gateway 的 Bearer 模式（`admission.ts`）。
 *
 * 旁路保证：装配不联网；`main.ts` 在回环监听开始之后才 `startAll()`，而且不等；
 * 隧道的失败、断开与重连只进它自己的状态（`identity.cloud.status` 的 `tunnel`、
 * 事件 `cloud.tunnel`），不碰回环上的任何东西。
 *
 * 装好之后挂到云登录域（`cloudDomain().attachRelay`）：登记时起、撤销时停、状态
 * 从这里读。设置 `cloud.relay.enabled` 关掉即全部停，打开即按登记全部起。
 */

import type { TunnelStatus } from "@armadra/platform-protocol/core-api";

import { eventStream } from "../events";
import { identityInstanceId } from "../identity";
import { type CloudService, IDLE_TUNNEL, cloudDomain } from "../identity/cloud";
import type { CloudRelay } from "../identity/cloud";
import { IdentityService } from "../identity/service";
import { IdentityStore } from "../identity/store";
import { WsTickets } from "../identity/transport";
import { VERSION } from "../instance";
import type { CoreContext } from "../main";
import {
  type Transport,
  networkTransport,
  pinnedAnchor,
} from "../sources/http-client";
import { createTunnelGate } from "./admission";
import { TunnelClient, type TunnelState } from "./client";
import { NodeDirectory } from "./nodes";
import {
  type RelaySettings,
  currentRelaySettings,
  onRelaySettings,
} from "./settings";

export { TunnelDuplex } from "./streams";
export { sessionOriginOf } from "./admission";

/** 取 CA 的超时（与登记的外呼同一档）。 */
const ANCHOR_TIMEOUT_MS = 10_000;

export interface RelayService extends CloudRelay {
  /** 按全部有效登记起隧道（不等）。没有登记行时什么都不做。 */
  startAll(): void;
  stopAll(): void;
  statusAll(): { issuer: string; tunnel: TunnelStatus }[];
  /** core 退出：全部停、退订设置。 */
  close(): void;
}

export interface RelayDeps {
  /** 以下给测试：云登录域、出站发送点、设置、退避、是否放行 `ws://`。 */
  readonly cloud?: CloudService;
  readonly identity?: IdentityService;
  readonly transport?: Transport;
  readonly settings?: () => RelaySettings;
  readonly backoff?: (attempt: number) => number;
  readonly allowInsecure?: () => boolean;
}

let assembled: RelayService | undefined;

/** 这一轮 core 装好的隧道；没装（库没过统一迁移、没有身份域）是 `undefined`。 */
export function relayDomain(): RelayService | undefined {
  return assembled;
}

/** 测试用：卸下。 */
export function resetRelayDomain(): void {
  assembled = undefined;
}

export function install(context: CoreContext): RelayService | undefined {
  return installRelay(context);
}

export function installRelay(
  context: CoreContext,
  deps: RelayDeps = {},
): RelayService | undefined {
  const cloud = deps.cloud ?? cloudDomain();
  if (!context.db.unified || cloud === undefined) return undefined;
  const identity =
    deps.identity ??
    new IdentityService(
      new IdentityStore(context.db.database),
      identityInstanceId(),
    );
  const settings = deps.settings ?? currentRelaySettings;
  const transport = deps.transport ?? networkTransport;
  const allowInsecure =
    deps.allowInsecure ??
    (() => process.env.ARMADRA_RELAY_ALLOW_INSECURE === "1");
  const tickets = new WsTickets();
  const listener = context.server.createListener({
    admitted: true,
    gate: createTunnelGate({
      service: identity,
      tickets,
      registration: (issuer) => cloud.registration(issuer),
    }),
  });
  const clients = new Map<string, TunnelClient>();

  const publish = (issuer: string, state: TunnelState) => {
    const watched = eventStream()?.watchedWorkspaces() ?? [];
    for (const workspaceId of watched) {
      context.bus.emit("workspace.event", {
        workspaceId,
        event: { type: "cloud.tunnel", issuer, state },
      });
    }
  };

  const clientFor = (issuer: string): TunnelClient => {
    const existing = clients.get(issuer);
    if (existing !== undefined) return existing;
    const client = new TunnelClient({
      issuer,
      sourceId: () => identity.hostId(),
      coreVersion: VERSION,
      directory: new NodeDirectory({
        issuer,
        transport,
        signSourceJws: (audience) => cloud.signSourceJws(audience),
        fingerprint: () => cloud.fingerprint(issuer),
        preferredNode: () => settings().preferredNode,
      }),
      signBytes: (data) => cloud.signBytes(data),
      listener,
      ca: (url) =>
        pinnedAnchor(url.href, cloud.fingerprint(issuer), ANCHOR_TIMEOUT_MS),
      allowInsecure,
      onStatus: (status, previous) => {
        if (status.state !== previous) publish(issuer, status.state);
      },
      onRevoked: () => {
        // 中继说登记已撤销：本机也撤（停隧道、记撤销时刻），之后它签的断言不再认。
        queueMicrotask(() => {
          // 中继侧已经撤了，不必再去删它的源记录。
          cloud
            .revoke({ issuer }, undefined, { relaySide: "revoked" })
            .catch(() => {
              // 已经撤过了。
            });
          context.log.warn("远程服务撤销了这台机器的登记，本机登记已同步撤销", {
            issuer,
          });
        });
      },
      log: context.log,
      ...(deps.backoff === undefined ? {} : { backoff: deps.backoff }),
    });
    clients.set(issuer, client);
    return client;
  };

  const relay: RelayService = {
    start: (issuer) => {
      if (!settings().enabled) return;
      if (cloud.registration(issuer) === undefined) return;
      clientFor(issuer).start();
    },
    stop: (issuer) => {
      const client = clients.get(issuer);
      if (client === undefined) return;
      clients.delete(issuer);
      client.stop();
    },
    status: (issuer) => clients.get(issuer)?.status() ?? { ...IDLE_TUNNEL },
    statusAll: () =>
      cloud.registrations().map((row) => ({
        issuer: row.issuer,
        tunnel: relay.status(row.issuer),
      })),
    startAll: () => {
      for (const row of cloud.registrations()) relay.start(row.issuer);
    },
    stopAll: () => {
      for (const issuer of [...clients.keys()]) relay.stop(issuer);
    },
    close: () => {
      unsubscribe();
      relay.stopAll();
    },
  };

  // 只认开关的翻转：别的设置改动不该把停下的隧道（协议不兼容）又拉起来。
  let enabled = settings().enabled;
  const unsubscribe = onRelaySettings((next) => {
    if (next.enabled === enabled) return;
    enabled = next.enabled;
    if (next.enabled) relay.startAll();
    else relay.stopAll();
  });
  cloud.attachRelay(relay);
  assembled = relay;
  return relay;
}
