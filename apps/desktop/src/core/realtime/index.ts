/**
 * 实时协同域：每块板一个 `Y.Doc`，更新流与快照落库，物化回 `nodes` /
 * `edges` / `whiteboard_json`（补全架构 §6）。
 *
 * 边界：
 *   * 实时板上 core 自己的写者（控制动词、调度、依赖编排）经
 *     `canvas/documents.saveBoard` 前的拦截写进文档，不绕过文档直写表
 *     （`intercept.ts`）；带 `clientId` 的 HTTP 保存答 409 `realtime_active`。
 *   * 评论不进 `Y.Doc`，落 `board_comments`，由 core 判权限与锚点
 *     （`comments-store.ts`，路由 `comments-routes.ts`）。
 *   * `WS …/boards/{boardId}/sync` 升级要 `canvas:read`、更新帧要
 *     `canvas:write`（`http/route-scopes.ts`）。契约 §16.1–§16.2。
 *   * 是否允许把板切到实时看设置 `collab.realtime`（缺省开）；关掉之后没有
 *     客户端连着的实时板在卸载或下一次 core 写入时退回租约模式。
 */

import type { WebSocket } from "ws";

import { setRealtimeHooks } from "../canvas/documents";
import { canvasPresence } from "../canvas/routes";
import { getBoard } from "../canvas/boards";
import {
  type RequestIdentity,
  accessGate,
  allows,
  onAccessChanged,
  requestIdentity,
} from "../identity/gate";
import { scope } from "../identity/scopes";
import type { CoreContext } from "../main";
import { registerCapability } from "../schedule/capabilities";
import { completionSettings, settingsDomain } from "../settings";
import { answered, workspaceId } from "../workspaces/routes";
import { internalError } from "../workspaces/support";
import { RealtimeHub, type LiveBoard } from "./hub";
import { installCommentRoutes } from "./comments-routes";
import { realtimeHooks } from "./intercept";
import { isRealtime, realtimeRow } from "./store";
import { CLOSE_BACKPRESSURE, SendQueue, wsTarget } from "../http/stream-queue";
import {
  CLOSE_BAD_FRAME,
  CLOSE_FORBIDDEN,
  MAX_FRAME_BYTES,
  SyncConnection,
} from "./sync";

/** 平台规格 core 包 §3.3：实时协同 `pause`，256 帧、2 MiB。 */
export const SYNC_MAX_FRAMES = 256;
export const SYNC_HIGH_WATER_BYTES = 2 * 1024 * 1024;

export { RealtimeHub } from "./hub";
export { SyncConnection } from "./sync";

/** Hello 里报的能力名：这个 core 说实时协议（契约 §16.1）。 */
export const REALTIME_CAPABILITY = "canvas.realtime.v1";

export const SYNC_PATH = "/api/workspaces/{workspaceId}/boards/{boardId}/sync";
export const REALTIME_STATE_PATH =
  "/api/workspaces/{workspaceId}/boards/{boardId}/realtime";

let assembled: RealtimeHub | undefined;

/** 运行中的 core 的实时中枢；`main.ts` 退出时用它物化。 */
export function realtimeDomain(): RealtimeHub | undefined {
  return assembled;
}

/** 设置 `collab.realtime`。读不到设置（测试里没装设置域）按缺省开。 */
export function realtimeEnabled(): boolean {
  return completionSettings(settingsDomain()?.settings.snapshot() ?? {}).collab
    .realtime;
}

/** 升级请求 → 它背后的身份（与事件流同一个做法）。 */
const subscribers = new WeakMap<object, RequestIdentity>();

function permitted(
  identity: RequestIdentity | undefined,
  permission: "canvas:read" | "canvas:write",
  workspace: string,
): boolean {
  if (identity === undefined) return allows([scope(permission, workspace)]);
  const subject =
    identity.revalidate === undefined
      ? identity.subject
      : identity.revalidate();
  if (subject === undefined) return false;
  return accessGate().permits(subject, [scope(permission, workspace)]);
}

export function install(context: CoreContext): RealtimeHub {
  const database = context.db.database;
  assembled?.stop();
  const hub = new RealtimeHub({
    database,
    enabled: realtimeEnabled,
    publishChanged: (workspace, boardId, updatedAt) => {
      context.bus.emit("workspace.event", {
        workspaceId: workspace,
        event: { type: "board.changed", boardId, updatedAt },
      });
    },
    log: context.log,
  });
  assembled = hub;
  setRealtimeHooks(database, realtimeHooks(hub));
  canvasPresence()?.setRealtimeProbe((boardId) =>
    isRealtime(database, boardId),
  );
  registerCapability(REALTIME_CAPABILITY);

  // 一块板的实时状态：页面据此选同步路径（契约 §16.2）。
  context.server.router.handle(
    "GET",
    REALTIME_STATE_PATH,
    answered((match) => {
      const board = getBoard(database, workspaceId(match), boardIdOf(match));
      const row = realtimeRow(database, board.id);
      return {
        status: 200,
        body: {
          realtime: row?.realtime ?? false,
          materializedSeq: row?.materializedSeq ?? 0,
          enabled: hub.enabled,
        },
      };
    }),
  );

  // 评论（契约 §16.3）：不进文档，读写都在 `board_comments`。
  installCommentRoutes(context.server.router, {
    database,
    publish: (workspace, event) => {
      context.bus.emit("workspace.event", { workspaceId: workspace, event });
    },
  });

  context.server.stream(
    SYNC_PATH,
    (socket, params, request) => {
      const workspace = params.workspaceId ?? "";
      const boardId = params.boardId ?? "";
      const identity = subscribers.get(request.raw);
      let live: LiveBoard | undefined;
      try {
        live = hub.open(workspace, boardId, hub.enabled);
      } catch {
        live = undefined;
      }
      if (live === undefined) {
        socket.close(CLOSE_FORBIDDEN, "realtime unavailable");
        return;
      }
      let writable = permitted(identity, "canvas:write", workspace);
      // 发送端在连接之前造，回调到时（greet 之后）连接早已在。
      const conn: SyncConnection = new SyncConnection(
        live,
        socketPeer(socket, () => conn),
        {
          principalId: identity?.subject.principalId ?? "",
          canWrite: () => writable,
        },
      );
      const room = live;
      hub.attach(room, conn);
      conn.greet();
      socket.on("message", (data, isBinary) => {
        if (!isBinary) {
          conn.close(CLOSE_BAD_FRAME, "binary frames only");
          return;
        }
        conn.receive(bytesOf(data));
      });
      // 授权一变就复核：看不了了、或者本来能写现在不能写了，都以 4403 关流
      // （契约 §16.1）。页面据此转只读，而不是带着一份写不回去的本地改动。
      const stop = onAccessChanged(() => {
        if (!permitted(identity, "canvas:read", workspace)) {
          conn.close(CLOSE_FORBIDDEN, "forbidden");
          return;
        }
        const now = permitted(identity, "canvas:write", workspace);
        if (writable && !now) conn.close(CLOSE_FORBIDDEN, "forbidden");
        writable = now;
      });
      const end = () => {
        stop();
        hub.detach(room, conn);
      };
      socket.on("close", end);
      socket.on("error", end);
    },
    (params, request) => {
      const workspace = params.workspaceId ?? "";
      const boardId = params.boardId ?? "";
      try {
        getBoard(database, workspace, boardId);
      } catch {
        return { status: 404, reason: "Not Found" };
      }
      if (!allows([scope("canvas:read", workspace)])) {
        return { status: 403, reason: "Forbidden" };
      }
      // 设置关着、板也还不是实时板：不切，页面留在租约模式。
      if (!hub.enabled && hub.live(boardId) === undefined) {
        const row = realtimeRow(database, boardId);
        if (row === undefined || !row.realtime) {
          return { status: 409, reason: "realtime_disabled" };
        }
      }
      const identity = requestIdentity();
      if (identity !== undefined && request.raw !== undefined) {
        subscribers.set(request.raw, identity);
      }
      return undefined;
    },
    // 首个 step2 可以有整块板那么大（契约 §16.1 的 16 MiB）；超过由 `ws` 以
    // 1009 关流，与 `SyncConnection.receive` 自己的检查同一个码。
    { maxPayload: MAX_FRAME_BYTES },
  );

  return hub;
}

function boardIdOf(match: {
  params: Readonly<Record<string, string>>;
}): string {
  const id = match.params.boardId;
  if (id === undefined) throw internalError("boardId is not in the path");
  return id;
}

/**
 * 一条连接的发送端：背压按平台规格 core 包 §3.3 的 `pause`——积压过 2 MiB
 * 就让这条连接停收广播（`SyncConnection.pause`），排空后一次补齐；排着的只有
 * 回答它自己请求的帧，满 256 帧就以 1013 关流（客户端重连后按 step1 / step2
 * 重新同步）。
 */
function socketPeer(socket: WebSocket, flow: () => SyncConnection) {
  const queue = new SendQueue(wsTarget(socket, { binary: true }), {
    policy: "pause",
    maxFrames: SYNC_MAX_FRAMES,
    highWaterBytes: SYNC_HIGH_WATER_BYTES,
    onPause: () => flow().pause(),
    onResume: () => flow().resume(),
    onOverflow: () => socket.close(CLOSE_BACKPRESSURE, "backpressure"),
  });
  socket.on("close", () => queue.close());
  return {
    send(frame: Uint8Array) {
      queue.push(frame);
    },
    close(code: number, reason: string) {
      socket.close(code, reason);
    },
  };
}

function bytesOf(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data))
    return new Uint8Array(Buffer.concat(data as Buffer[]));
  return new Uint8Array();
}
