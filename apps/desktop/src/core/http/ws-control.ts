import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { type RequestIdentity, requestIdentity, runAs } from "../identity/gate";
import { MAX_FRAME_BYTES } from "../identity/protocol";
import type { CoreRequest } from "./router";
import type { CoreServer } from "./server";

/**
 * 控制面 WebSocket `/api/ws` 的升级层（工程规范化 §3、工程规范化包 §2.1，契约
 * §35.1–§35.3）。
 *
 * 这条连接上只跑上游 RPC 的 peer 帧：调用、订阅、续订、错误都是它的。本仓库
 * 不往上塞自己的帧，「控制」的职责落在 oRPC 之前的这一层：
 *
 *   * **子协议**：客户端报 `armadra-rpc.v1`（和一次性票 `armadra-ticket.<票>`
 *     一起，票由 `server.ts` 的准入门在升级前兑掉）。服务端回选 `armadra-rpc.v1`；
 *     没报的升级照样完成，然后以 4409 关——升级前没有关闭码可说。
 *   * **身份**：升级时认好的那个人（准入门 / Gateway 放进来的）。每一帧调用都在
 *     它下面跑，并且先复核一次会话：已经失效的会话不再答任何调用，以 4403 关。
 *     令牌到期（4401）与授权变化（4403）的复核是 `server.ts` 给每条流的那一套。
 *   * **坏帧与超限**：二进制帧、不是 peer 消息的文本帧以 4400 关；超过
 *     `maxFrameBytes` 的以 4413 关（`ws` 的硬上限是它的两倍，再大的由 `ws` 以
 *     1009 关）。
 *   * **心跳**：`ws` 层 ping 由 `server.ts` 统一发（A3-0），间隔即 `system.hello`
 *     报的 `heartbeatMs`。
 *   * **停机**：core 关停时先以 1001 关，再断开（`server.ts` 的 `close()`）。
 *
 * `@orpc/*` 不在这里：RPC 门面（`http/rpc.ts`）把自己的 peer 处理器挂到
 * {@link installControlPlane} 交给它的连接上，并在那边数订阅、包背压队列。
 */

export const CONTROL_PATH = "/api/ws";
export const CONTROL_PROTOCOL = "armadra-rpc.v1";

/** 契约 §35.2 的关闭码表。 */
export const CLOSE_NORMAL = 1000;
export const CLOSE_GOING_AWAY = 1001;
export const CLOSE_BAD_FRAME = 4400;
export const CLOSE_EXPIRED = 4401;
export const CLOSE_REVOKED = 4403;
export const CLOSE_PROTOCOL = 4409;
export const CLOSE_TOO_LARGE = 4413;
export const CLOSE_LIMIT = 4429;

/** 一条连接上同时活着的订阅数上限（工程规范化 §3.3）。 */
export const MAX_ITERATORS = 256;
/** 每个订阅的有界队列（单元数）。 */
export const ITERATOR_MAX_FRAMES = 1024;
/** 连接的缓冲超过它，订阅就开始排队（工程规范化 §3.3：1 MiB）。 */
export const ITERATOR_HIGH_WATER_BYTES = 1024 * 1024;

/** 一条控制面连接，门面看得见的那部分。 */
export interface ControlConnection {
  readonly id: string;
  /** 升级时的那个人；本机壳（没有请求主体）是 `undefined`。 */
  readonly identity: RequestIdentity | undefined;
  /** 升级请求（头、来源）。 */
  readonly request: CoreRequest;
  /** socket 自己的发送缓冲。 */
  readonly bufferedAmount: number;
  readonly readyState: number;
  /** 正活着的订阅数，门面增减。 */
  iterators: number;
  close(code: number, reason: string): void;
}

/** 交给 peer 处理器的那一面：只有它用到的三样。 */
export interface ControlSocket {
  addEventListener(
    type: "message",
    listener: (event: { data: string }) => void,
  ): void;
  addEventListener(type: "close", listener: () => void): void;
  send(data: string): void;
}

export type ControlAttach = (
  socket: ControlSocket,
  connection: ControlConnection,
) => void;

/** 一条文本帧是不是 peer 消息：一个带 `i` 的对象。 */
function peerMessage(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && "i" in value;
  } catch {
    return false;
  }
}

/**
 * 升级请求 → 它背后的身份。guard 与 open 拿到的是同一个请求对象，而 open 跑在
 * `ws` 完成握手的回调里，异步上下文不保证还在。
 */
const upgraded = new WeakMap<object, RequestIdentity>();

/** 正开着的控制面连接（停机时以 1001 关）。 */
const open = new WeakMap<CoreServer, Set<WebSocket>>();

/** 关停前先以 1001 告诉客户端这是停机，不是掉线。 */
export function goingAway(server: CoreServer): void {
  for (const socket of open.get(server) ?? []) {
    if (socket.readyState !== socket.OPEN) continue;
    try {
      socket.close(CLOSE_GOING_AWAY, "going away");
    } catch {
      // 正在关的 socket。
    }
  }
}

/** 挂上 `/api/ws`。`attach` 是 RPC 门面的 peer 处理器。 */
export function installControlPlane(
  server: CoreServer,
  attach: ControlAttach,
  options: { readonly maxFrameBytes?: number } = {},
): void {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  const sockets = new Set<WebSocket>();
  open.set(server, sockets);
  server.stream(
    CONTROL_PATH,
    (socket, _params, request) => {
      if (socket.protocol !== CONTROL_PROTOCOL) {
        socket.close(CLOSE_PROTOCOL, "protocol");
        return;
      }
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      const identity = upgraded.get(request.raw ?? {});
      const connection: ControlConnection = {
        id: randomUUID(),
        identity,
        request,
        get bufferedAmount() {
          return socket.bufferedAmount;
        },
        get readyState() {
          return socket.readyState;
        },
        iterators: 0,
        close(code, reason) {
          if (socket.readyState === socket.OPEN) socket.close(code, reason);
        },
      };
      const shut = (code: number, reason: string) => {
        connection.close(code, reason);
      };
      const facade: ControlSocket = {
        addEventListener(
          type: "message" | "close",
          listener: (event: { data: string }) => void,
        ) {
          if (type === "close") {
            socket.on("close", () => (listener as () => void)());
            return;
          }
          socket.on("message", (data: Buffer, binary: boolean) => {
            if (binary) return shut(CLOSE_BAD_FRAME, "binary frame");
            if (data.byteLength > maxFrameBytes) {
              return shut(CLOSE_TOO_LARGE, "frame too large");
            }
            const text = data.toString("utf8");
            if (!peerMessage(text)) return shut(CLOSE_BAD_FRAME, "bad frame");
            if (identity === undefined) {
              listener({ data: text });
              return;
            }
            // 每一帧都按会话现在的样子跑：页面刷新过访问令牌，主体照旧；会话
            // 没了（登出、撤销设备），这条连接不再答任何调用。
            const subject =
              identity.revalidate === undefined
                ? identity.subject
                : identity.revalidate();
            if (subject === undefined) return shut(CLOSE_REVOKED, "forbidden");
            runAs({ ...identity, subject }, () => listener({ data: text }));
          });
        },
        send(data: string) {
          if (socket.readyState === socket.OPEN) socket.send(data);
        },
      } as ControlSocket;
      attach(facade, connection);
    },
    (_params, request) => {
      const identity = requestIdentity();
      if (identity !== undefined && request.raw !== undefined) {
        upgraded.set(request.raw, identity);
      }
      return undefined;
    },
    // 硬上限放宽一倍：超过 `maxFrameBytes` 的帧要以 4413 关，而不是被 `ws`
    // 自己以 1009 关掉（客户端分不清那是帧超限还是别的协议错误）。
    { maxPayload: maxFrameBytes * 2 },
  );
}
