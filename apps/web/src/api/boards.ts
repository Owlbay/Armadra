import {
  boardRealtimeStateSchema,
  boardDocumentSchema,
  boardPresenceSchema,
  leaseRequestSchema,
  presenceHeartbeatRequestSchema,
  boardListSchema,
  boardSchema,
  createBoardRequestSchema,
  saveBoardRequestSchema,
  updateBoardRequestSchema,
  type BoardDocument,
  type UpdateBoardRequest,
} from "@armadra/shared";
import type { ArmadraClient } from "./client";
import { RuntimeRequestError } from "./request";
import type { Source } from "./source";

/**
 * 画布（契约 §36，第三批迁到契约上的域）。
 *
 * 调用经 RPC 客户端（`client.boards.*`），答案仍过页面自己的 schema——线上的
 * 形状把每个字段写全，页面的 schema 再补它自己的缺省与格式检查，调用点看到的
 * 形状与迁移前一样。客户端由 `api/client.ts` 交进来（这个模块被它 import，反过来
 * import 它就是一个环）；`source` 是 A1-2 的源语义：缺省发往当前源，实时复核
 * 这类「读数属于某个源」的调用传那个源。Yjs 的同步连接不在这里（`sockets.ts`）；
 * 在线订阅 `boards.presence` 在 `board-presence.ts`。
 */
export const boardsApiFor = (rpc: (source?: Source) => ArmadraClient) => ({
  /* ----------------------------------- 画布 ----------------------------- */
  listBoards: async (workspaceId: string) =>
    boardListSchema.parse(await rpc().boards.list({ workspaceId })),
  createBoard: async (workspaceId: string, name: string) =>
    boardSchema.parse(
      await rpc().boards.create({
        workspaceId,
        ...createBoardRequestSchema.parse({ name }),
      }),
    ),
  updateBoard: async (
    workspaceId: string,
    boardId: string,
    patch: UpdateBoardRequest,
  ) =>
    boardSchema.parse(
      await rpc().boards.update({
        workspaceId,
        boardId,
        ...updateBoardRequestSchema.parse(patch),
      }),
    ),
  deleteBoard: async (
    workspaceId: string,
    boardId: string,
  ): Promise<undefined> => {
    await rpc().boards.delete({ workspaceId, boardId });
    return undefined;
  },

  /**
   * 这块板走不走实时协同（契约 §16.2）：`realtime || enabled` 时连 `…/sync`，
   * 否则留在租约 + CAS。
   */
  boardRealtime: async (
    workspaceId: string,
    boardId: string,
    source?: Source,
  ) =>
    boardRealtimeStateSchema.parse(
      await rpc(source).boards.realtime({ workspaceId, boardId }),
    ),

  /* --------------------------------- 画布文档 --------------------------- */
  loadBoard: async (workspaceId: string, boardId: string) =>
    boardDocumentSchema.parse(
      await rpc().boards.load({ workspaceId, boardId }),
    ),
  /**
   * 带 `expectedUpdatedAt`（CAS）：并发写入由 Runtime 拒绝。`clientId` 是编辑
   * 租约的写者（core JSON §9.3）：别人持有租约时答 423 `canvas_lease_held`。
   */
  saveBoard: async (
    workspaceId: string,
    boardId: string,
    document: BoardDocument,
    clientId?: string,
  ) =>
    boardDocumentSchema.parse(
      await rpc().boards.save({
        workspaceId,
        boardId,
        // 页面这一侧的节点是按类型写的联合；线上的入参是「原样 JSON 对象」，
        // 语义检查在 core（`validation.ts`）。
        ...(saveBoardRequestSchema.parse({
          expectedUpdatedAt: document.board.updatedAt,
          nodes: document.nodes,
          edges: document.edges,
          viewport: document.board.viewport,
          // 白板快照（旧画布契约 §6.1）：同一次调用带走，Runtime 原样存。
          whiteboard: document.board.whiteboard,
          clientId,
        }) as unknown as Omit<
          Parameters<ArmadraClient["boards"]["save"]>[0],
          "workspaceId" | "boardId"
        >),
      }),
    ),

  /* ----------------------------- 在线设备与租约 ------------------------- */
  /**
   * 心跳（core JSON §9.1）：登记或续期，回当前的在线表与租约。连着控制面时由
   * 订阅 `boards.presence` 续期；这一条报「刚被操作过」，也是订阅断着时的兜底。
   */
  presenceHeartbeat: async (
    workspaceId: string,
    boardId: string,
    body: { clientId: string; deviceName: string; active: boolean },
  ) =>
    boardPresenceSchema.parse(
      await rpc().boards.heartbeat({
        workspaceId,
        boardId,
        ...presenceHeartbeatRequestSchema.parse(body),
      }),
    ),
  /** 离开。订阅结束时 core 自己也会离开；这一条让切走画布立刻生效。 */
  leavePresence: async (
    workspaceId: string,
    boardId: string,
    clientId: string,
  ) =>
    boardPresenceSchema.parse(
      await rpc().boards.leave({ workspaceId, boardId, clientId }),
    ),
  /** 拿租约；`takeover` 是用户确认过的接管（§9.2）。 */
  acquireLease: async (
    workspaceId: string,
    boardId: string,
    body: { clientId: string; deviceName: string; takeover: boolean },
  ) =>
    boardPresenceSchema.parse(
      await rpc().boards.acquireLease({
        workspaceId,
        boardId,
        ...leaseRequestSchema.parse(body),
      }),
    ),
});

/** 别人持有这块画布的编辑租约（423 `canvas_lease_held`）。 */
export function isLeaseHeld(error: unknown): boolean {
  return (
    error instanceof RuntimeRequestError && error.code === "canvas_lease_held"
  );
}
