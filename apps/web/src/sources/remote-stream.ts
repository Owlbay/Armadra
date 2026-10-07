import { z } from "zod";

import { type CloudOptions, cloudStreamTicket } from "./cloud-client";
import {
  ManagedSocket,
  type ManagedSocketOptions,
  type ManagedSocketState,
} from "./managed-socket";
import type { SourceRegistry } from "./registry";
import {
  type CloudAuth,
  SOURCE_ERROR,
  type SourceFailure,
  type SourceState,
} from "./types";

/**
 * 远程服务的事件流（客户端包 §5；cloud 契约 §6）：每个远程服务一条
 * `GET <issuer>/v1/me/stream`，票经 `POST /v1/me/stream/ticket`（远程服务会话）。
 *
 * - `sourceOnline` → 这个签发方下那个源的连接 `connect()`（4404 之后在等它的
 *   流随之醒来）；
 * - `sourceRevoked` / `accessRevoked` → 那个连接 `revoke()`，状态
 *   `unauthorized` 带 `source_revoked` / `source_access_denied`，界面按码提示；
 * - 流（重）新打开时，这个签发方下离线或在等的源各 `connect()` 一次：断开期间
 *   错过的 `sourceOnline` 由它补上（中继重启时隧道可能比这条流先回来）；
 * - 客户端每 30 秒发 `{ type: "ping" }`；4401 = 远程服务会话失效，丢掉缓存的
 *   访问令牌、换票重连一次。
 */

export const ME_STREAM_PATH = "/v1/me/stream";
export const ME_STREAM_PING_MS = 30_000;

const meStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sourceOnline"), sourceId: z.string().min(1) }),
  z.object({ type: z.literal("sourceOffline"), sourceId: z.string().min(1) }),
  z.object({ type: z.literal("sourceRevoked"), sourceId: z.string().min(1) }),
  z.object({ type: z.literal("accessRevoked"), sourceId: z.string().min(1) }),
  z.object({ type: z.literal("linkUsed") }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("pong") }),
]);
export type MeStreamEvent = z.infer<typeof meStreamEventSchema>;

/** 一条帧 → 事件；认不出的（更高 minor 加的类型、坏 JSON）是 `null`。 */
export function parseMeStreamEvent(raw: unknown): MeStreamEvent | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = meStreamEventSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** `<issuer>` → `wss://<issuer 主机>/v1/me/stream`。 */
export function meStreamUrl(issuer: string): string {
  const url = new URL(`${issuer.replace(/\/+$/, "")}${ME_STREAM_PATH}`);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.href;
}

export interface RemoteStreamOptions {
  readonly issuer: string;
  readonly auth: CloudAuth;
  readonly onEvent: (event: MeStreamEvent) => void;
  /** 流打开了（首次或重连）。 */
  readonly onOpen?: () => void;
  readonly onStateChange?: (state: ManagedSocketState) => void;
  readonly cloud?: CloudOptions;
  /** `ManagedSocket` 的环境、计时器与 `WebSocket`（测试注入）。 */
  readonly socket?: Pick<
    ManagedSocketOptions,
    "WebSocket" | "environment" | "setTimeout" | "clearTimeout" | "backoff"
  >;
  readonly setInterval?: (run: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

export interface RemoteStream {
  readonly issuer: string;
  readonly state: ManagedSocketState;
  close(): void;
}

/** 一个远程服务的一条事件流。 */
export function createRemoteStream(options: RemoteStreamOptions): RemoteStream {
  const { issuer, auth } = options;
  const every =
    options.setInterval ?? ((run, ms) => globalThis.setInterval(run, ms));
  const stop =
    options.clearInterval ??
    ((handle) =>
      globalThis.clearInterval(handle as ReturnType<typeof setInterval>));
  let pinger: unknown = null;
  const stopPing = () => {
    if (pinger !== null) stop(pinger);
    pinger = null;
  };

  const socket = new ManagedSocket({
    ...options.socket,
    url: () => meStreamUrl(issuer),
    ticket: async () =>
      cloudStreamTicket(issuer, await auth.access(issuer), options.cloud),
    // 4401：远程服务会话失效（登出、撤销设备、令牌过期）。丢掉缓存再换一次票。
    renew: async () => {
      auth.invalidate(issuer);
      try {
        await auth.access(issuer);
        return true;
      } catch {
        return false;
      }
    },
    onOpen(raw) {
      stopPing();
      pinger = every(() => {
        try {
          raw.send(JSON.stringify({ type: "ping" }));
        } catch {
          /* 关着：close 会接着来。 */
        }
      }, ME_STREAM_PING_MS);
      options.onOpen?.();
    },
    onClose: () => stopPing(),
    onMessage(event) {
      const parsed = parseMeStreamEvent(event.data);
      if (parsed !== null) options.onEvent(parsed);
    },
    onStateChange(state) {
      if (state !== "open") stopPing();
      options.onStateChange?.(state);
    },
  });

  return {
    issuer,
    get state() {
      return socket.state;
    },
    close() {
      stopPing();
      socket.close();
    },
  };
}

/* ------------------------------- 接到源表上 ------------------------------- */

/** 远程服务事件落到的那个源：源表里的连接，或中继托管页面上的当前源。 */
export interface StreamTarget {
  readonly status: { readonly state: SourceState };
  connect(): Promise<void>;
  revoke(failure: SourceFailure): void;
}

/** 事件 → 对这个源做什么。 */
export function applyMeStreamEvent(
  event: MeStreamEvent,
  target: StreamTarget | undefined,
): void {
  if (target === undefined) return;
  switch (event.type) {
    case "sourceOnline":
      if (target.status.state !== "ready")
        void target.connect().catch(() => undefined);
      return;
    case "sourceRevoked":
      target.revoke({ code: SOURCE_ERROR.revoked, message: "" });
      return;
    case "accessRevoked":
      target.revoke({ code: SOURCE_ERROR.accessRevoked, message: "" });
      return;
    default:
      // `sourceOffline`：不抢先改状态——流会以 4404 收尾，请求会答 503，各自
      // 落到 `waitingForSource`；源可能只是隧道换节点。
      return;
  }
}

/** 流重新打开：错过的上线事件由一次 `connect()` 补上。 */
export function resyncTargets(targets: Iterable<StreamTarget>): void {
  for (const target of targets) {
    const state = target.status.state;
    if (state === "waitingForSource" || state === "offline")
      void target.connect().catch(() => undefined);
  }
}

export interface AttachOptions {
  readonly auth: CloudAuth;
  readonly cloud?: CloudOptions;
  readonly socket?: RemoteStreamOptions["socket"];
  readonly setInterval?: RemoteStreamOptions["setInterval"];
  readonly clearInterval?: RemoteStreamOptions["clearInterval"];
  /** 造流（测试注入）。 */
  readonly createStream?: (options: RemoteStreamOptions) => RemoteStream;
}

/**
 * 让源表里经远程服务到达的源（`relayed` / `hosted`，有 `cloudIssuer`）各签发方
 * 一条事件流：源表变了就增减，没有这类源就一条也不开。返回拆除函数。
 */
export function attachRemoteStreams(
  registry: SourceRegistry,
  options: AttachOptions,
): () => void {
  const streams = new Map<string, RemoteStream>();
  const create = options.createStream ?? createRemoteStream;

  const targetsOf = (issuer: string) =>
    registry
      .list()
      .filter(
        (connection) =>
          connection.descriptor.kind !== "local" &&
          connection.descriptor.cloudIssuer === issuer,
      );

  const sync = () => {
    const wanted = new Set(
      registry
        .list()
        .filter(
          (connection) =>
            (connection.descriptor.kind === "relayed" ||
              connection.descriptor.kind === "hosted") &&
            connection.descriptor.cloudIssuer !== "",
        )
        .map((connection) => connection.descriptor.cloudIssuer),
    );
    for (const [issuer, stream] of [...streams]) {
      if (wanted.has(issuer)) continue;
      stream.close();
      streams.delete(issuer);
    }
    for (const issuer of wanted) {
      if (streams.has(issuer)) continue;
      streams.set(
        issuer,
        create({
          issuer,
          auth: options.auth,
          ...(options.cloud === undefined ? {} : { cloud: options.cloud }),
          ...(options.socket === undefined ? {} : { socket: options.socket }),
          ...(options.setInterval === undefined
            ? {}
            : { setInterval: options.setInterval }),
          ...(options.clearInterval === undefined
            ? {}
            : { clearInterval: options.clearInterval }),
          onEvent(event) {
            if (!("sourceId" in event)) return;
            const target = registry.get(event.sourceId);
            if (target?.descriptor.cloudIssuer !== issuer) return;
            applyMeStreamEvent(event, target);
          },
          onOpen: () => resyncTargets(targetsOf(issuer)),
        }),
      );
    }
  };

  sync();
  const unsubscribe = registry.subscribe(sync);
  return () => {
    unsubscribe();
    for (const stream of streams.values()) stream.close();
    streams.clear();
  };
}
