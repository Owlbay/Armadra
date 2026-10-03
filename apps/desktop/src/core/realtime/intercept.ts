/**
 * core 自己的写者在实时板上的那条路（补全架构 §6.3「core 自己的写者」）。
 *
 * 控制动词、调度、依赖编排都照旧调 `canvas/documents.saveBoard`；板是实时板
 * 时 `saveBoard` 把请求交到这里：
 *
 *   1. 拿活动文档（没有客户端也加载，空闲 60 秒后卸载）并先物化一次，表就是
 *      文档的当前投影；
 *   2. 修订号照旧比（写者读到的那一份已经旧了就是 409，与非实时板同一个答案）；
 *   3. 请求相对它读到的那一份（此刻的表）做三方 diff，在文档的一个副本上试写，
 *      投影过一遍 `saveBoard` 的全部拒绝（校验、跨板 id、撞名）——不过就照旧
 *      报错，文档一字不动；
 *   4. 过了就以 `origin: "core"` 的事务写进真文档（更新照常落库、转发给客户
 *      端），再物化，答物化后的表。
 *
 * 文档里别人并发改的、写者没碰的字段原样保留：三方 diff 只写写者改了的那些。
 *
 * 设置 `collab.realtime` 关掉之后，一块没有客户端连着的实时板在这里退回租约
 * 模式（物化、标 `realtime = 0`），然后按非实时板保存。
 */

import type { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";

import {
  type RealtimeBoardHooks,
  readBoard,
  saveBoard,
} from "../canvas/documents";
import type { BoardDocument, SaveBoardRequest } from "../canvas/document-types";
import { validateViewport } from "../canvas/validation";
import { conflict } from "../workspaces/support";
import { type BoardProjection, applyDelta, projectDoc } from "./doc";
import type { RealtimeHub } from "./hub";
import { CORE_ORIGIN, checkProjection } from "./materialize";
import { latestSeq, realtimeRow } from "./store";

export function realtimeHooks(hub: RealtimeHub): RealtimeBoardHooks {
  return {
    beforeLoad(database, workspaceId, boardId) {
      beforeLoad(hub, database, workspaceId, boardId);
    },
    save(database, workspaceId, boardId, request) {
      return interceptSave(hub, database, workspaceId, boardId, request);
    },
  };
}

/**
 * 读实时板之前：活动文档有没落表的改动就先物化；没有活动文档、而表落后于
 * 更新流（上次没物化完就退出了）时加载一次，加载本身会补物化。
 */
function beforeLoad(
  hub: RealtimeHub,
  database: DatabaseSync,
  workspaceId: string,
  boardId: string,
): void {
  const live = hub.live(boardId);
  if (live !== undefined) {
    if (live.dirty) hub.flush(live, true);
    return;
  }
  const row = realtimeRow(database, boardId);
  if (row === undefined || !row.realtime) return;
  if (row.materializedSeq >= latestSeq(database, boardId)) return;
  try {
    hub.open(workspaceId, boardId, false);
  } catch {
    // 读不该因为补物化失败而失败：表里那一份仍然是一份完整的旧文档。
  }
}

export function interceptSave(
  hub: RealtimeHub,
  database: DatabaseSync,
  workspaceId: string,
  boardId: string,
  request: SaveBoardRequest,
): BoardDocument {
  if (!hub.enabled && hub.revertToLease(workspaceId, boardId)) {
    return saveBoard(database, workspaceId, boardId, request);
  }
  const live = hub.open(workspaceId, boardId, false);
  if (live === undefined) {
    // 板在这期间退回了租约模式（或刚被删掉）：按非实时板保存，404 由它答。
    return saveBoard(database, workspaceId, boardId, request);
  }
  hub.flush(live, true);
  hub.touch(live);
  const stored = readBoard(database, workspaceId, boardId);
  validateViewport(request.viewport);
  if (stored.board.updatedAt !== request.expectedUpdatedAt) {
    throw conflict("Board changed since it was loaded; reload before saving");
  }
  const base: BoardProjection = {
    nodes: stored.nodes,
    edges: stored.edges,
    whiteboard: stored.board.whiteboard,
  };
  const target: BoardProjection = {
    nodes: request.nodes,
    edges: request.edges,
    whiteboard: request.whiteboard ?? stored.board.whiteboard,
  };
  // 试写：副本上应用、投影、过一遍落表前的全部拒绝。
  const trial = new Y.Doc();
  Y.applyUpdate(trial, Y.encodeStateAsUpdate(live.doc));
  applyDelta(trial, base, target, CORE_ORIGIN);
  checkProjection(database, boardId, projectDoc(trial, boardId));
  trial.destroy();

  applyDelta(live.doc, base, target, CORE_ORIGIN);
  hub.flush(live, false);
  return readBoard(database, workspaceId, boardId);
}
