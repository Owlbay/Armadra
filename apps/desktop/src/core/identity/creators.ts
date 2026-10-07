import type { DatabaseSync } from "node:sqlite";
import { isOwner } from "./authorize";
import { requestIdentity } from "./gate";

/**
 * 「创建者 = 触发者」（补全架构 §8.2，契约 §23）。
 *
 * 路由门判「自己的终端」看的是 `terminal_sessions.creator_principal_id`
 * （迁移 0028）。这里回答的是**那一列该写谁**：
 *
 *   * 人从页面起的终端：本人（路由门在开终端的那一刻写）。
 *   * 控制动词（`open-agent` / `open-terminal` / `team`，ama 的 runner 经
 *     `open-agent`）建的节点：调用方节点终端的创建者。
 *   * 工作流起的角色节点：起跑的那个人。
 *   * 定时冷启动：自动化的创建者。自动化今天只有 owner 能建（成员在
 *     `/api/automations` 上一律 403），所以恒为 owner。
 *   * 桌面壳、没有请求主体：owner。
 *
 * owner 记成空串，与 0028 的约定一致：空串对任何成员都是「别人的」。
 *
 * 节点的触发者记在 `node_creators`（迁移 0035），起终端时由库里的触发器继承
 * 到会话行上——无论终端是谁、从哪条路起的。
 */

/** owner、core 自己、桌面壳：都记成空串。 */
export const OWNER_CREATOR = "";

/**
 * 定时冷启动继承的创建者。自动化行没有创建者列，而建自动化只有 owner 能做，
 * 所以这里是 owner；哪天成员能建自动化，这里改成读那一列。
 */
export const AUTOMATION_CREATOR = OWNER_CREATOR;

/** 这次请求的触发者：成员是他的 principal，owner 与没有请求身份时是空串。 */
export function requestTrigger(): string {
  const subject = requestIdentity()?.subject;
  if (subject === undefined || isOwner(subject)) return OWNER_CREATOR;
  return subject.principalId;
}

/** 记下一个节点的触发者。同一节点再记一次以最后一次为准。 */
export function recordNodeCreator(
  database: DatabaseSync,
  node: { readonly nodeId: string; readonly workspaceId: string },
  principalId: string,
): void {
  database
    .prepare(
      "INSERT INTO node_creators (node_id, workspace_id, principal_id, created_at) " +
        "VALUES (?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET " +
        "principal_id = excluded.principal_id, workspace_id = excluded.workspace_id",
    )
    .run(node.nodeId, node.workspaceId, principalId, Date.now());
}

/** 节点记过的触发者；没记过是 `null`（与「记的是 owner」的空串区分开）。 */
export function nodeCreator(
  database: DatabaseSync,
  nodeId: string,
): string | null {
  try {
    const row = database
      .prepare("SELECT principal_id FROM node_creators WHERE node_id = ?")
      .get(nodeId) as { principal_id?: unknown } | undefined;
    return typeof row?.principal_id === "string" ? row.principal_id : null;
  } catch {
    return null;
  }
}

/** 节点最近一个终端会话的 id；没起过是空串。 */
export function latestNodeSession(
  database: DatabaseSync,
  nodeId: string,
): string {
  try {
    const row = database
      .prepare(
        "SELECT id FROM terminal_sessions WHERE owner_node_id = ? " +
          "ORDER BY created_at DESC LIMIT 1",
      )
      .get(nodeId) as { id?: unknown } | undefined;
    return typeof row?.id === "string" ? row.id : "";
  } catch {
    return "";
  }
}

/** 会话行上的创建者；没有这一行是空串。 */
export function sessionCreator(
  database: DatabaseSync,
  sessionId: string,
): string {
  try {
    const row = database
      .prepare(
        "SELECT creator_principal_id FROM terminal_sessions WHERE id = ?",
      )
      .get(sessionId) as { creator_principal_id?: unknown } | undefined;
    return typeof row?.creator_principal_id === "string"
      ? row.creator_principal_id
      : "";
  } catch {
    return "";
  }
}

/**
 * 一个节点「是谁的」：最近那个终端的创建者；还没起过终端时是节点记下的触发
 * 者；都没有是 owner。控制动词的调用方、驱动切换、审批都按它判。
 */
export function nodeOwnerPrincipal(
  database: DatabaseSync,
  nodeId: string,
): string {
  const session = latestNodeSession(database, nodeId);
  if (session !== "") return sessionCreator(database, session);
  return nodeCreator(database, nodeId) ?? OWNER_CREATOR;
}

/** 写会话行的创建者（冷启动在起完之后按自动化的创建者改写）。 */
export function stampSessionCreator(
  database: DatabaseSync,
  sessionId: string,
  principalId: string,
): void {
  database
    .prepare(
      "UPDATE terminal_sessions SET creator_principal_id = ? WHERE id = ?",
    )
    .run(principalId, sessionId);
}
