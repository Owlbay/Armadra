/**
 * 评论路由（契约 §16.3，补全架构 §6.3 评论段）。
 *
 *   * `GET  …/boards/{boardId}/comments`：一块板的评论与可提及的人。
 *   * `POST …/boards/{boardId}/comments`：新建（顶层或一层回复）。
 *   * `PATCH / DELETE …/comments/{commentId}`：改正文只有作者；删除作者或 owner。
 *   * `POST …/comments/{commentId}/resolve`：解决 / 重新打开顶层评论。
 *
 * 读要 `canvas:read`、写要 `canvas:write`——路由门按 `http/route-scopes.ts`
 * 判过一次，这里再按同一条 scope 判一次：评论不只是从路由门进来（测试、以后
 * 的控制动词），而「只读的人写不了评论」不该只靠调用方记得。
 *
 * 提及写在正文里：`@[显示名](principal:<id>)`。core 只认对这个工作空间有
 * `canvas:read` 的、没停用的 principal；认不出的照原文留着，不叫任何人。
 * 每次写入发一条 `board.comment`（不带正文）：页面据此刷新，推送域按
 * `mentions` 叫人——新建时是全部提及，改正文时只是新加的那些。
 */

import type { DatabaseSync } from "node:sqlite";

import type { WorkspaceEvent } from "../bus";
import { getBoard } from "../canvas/boards";
import { audit } from "../identity/audit";
import { Authorizer, isOwner } from "../identity/authorize";
import { allows, currentSubject } from "../identity/gate";
import { scope } from "../identity/scopes";
import { IdentityStore } from "../identity/store";
import type { Router } from "../http/router";
import { answered, workspaceId } from "../workspaces/routes";
import {
  badRequest,
  forbidden,
  internalError,
  jsonObject,
} from "../workspaces/support";
import { mentionTokens } from "./comment-text";
import {
  type BoardComment,
  type CommentAnchor,
  createComment,
  deleteComment,
  getComment,
  listComments,
  setCommentResolved,
  updateCommentBody,
} from "./comments-store";

export const COMMENTS_PATH =
  "/api/workspaces/{workspaceId}/boards/{boardId}/comments";
export const COMMENT_PATH = `${COMMENTS_PATH}/{commentId}`;
export const COMMENT_RESOLVE_PATH = `${COMMENT_PATH}/resolve`;

export { MAX_MENTIONS, mentionTokens, plainCommentText } from "./comment-text";

/** 一个能被提及的人。 */
export interface CommentPerson {
  readonly principalId: string;
  readonly name: string;
}

/** 评论的线上形状：存取层的字段加上认出来的提及。 */
export interface CommentView extends BoardComment {
  readonly mentions: readonly string[];
}

export type CommentAction =
  | "created"
  | "updated"
  | "resolved"
  | "reopened"
  | "deleted";

export interface CommentRoutesOptions {
  readonly database: DatabaseSync;
  /** 发一条工作空间事件（`context.bus.emit("workspace.event", …)`）。 */
  readonly publish: (workspaceId: string, event: WorkspaceEvent) => void;
  readonly now?: () => number;
}

interface PrincipalRow {
  principal_id: string;
  kind: string;
  display_name: string;
}

/**
 * 对这个工作空间有 `canvas:read` 的、没停用的人。没有身份表（桌面壳的统一库
 * 之前）就没有可提及的人。
 */
export function mentionablePeople(
  database: DatabaseSync,
  workspace: string,
): CommentPerson[] {
  let rows: PrincipalRow[];
  try {
    rows = database
      .prepare(
        "SELECT principal_id, kind, display_name FROM identity_principals " +
          "WHERE disabled_at_ms = 0 AND kind <> 'service' ORDER BY display_name, principal_id",
      )
      .all() as unknown as PrincipalRow[];
  } catch {
    return [];
  }
  const authorizer = new Authorizer(new IdentityStore(database));
  const required = [scope("canvas:read", workspace)];
  return rows
    .filter((row) =>
      authorizer.permits(
        {
          principalId: row.principal_id,
          kind: row.kind === "owner" ? "owner" : "member",
          scopes: [],
        },
        required,
      ),
    )
    .map((row) => ({ principalId: row.principal_id, name: row.display_name }));
}

function viewOf(
  comment: BoardComment,
  people: ReadonlySet<string>,
): CommentView {
  return {
    ...comment,
    mentions: mentionTokens(comment.body).filter((id) => people.has(id)),
  };
}

export function installCommentRoutes(
  router: Router,
  options: CommentRoutesOptions,
): void {
  const { database, publish } = options;
  const now = options.now ?? Date.now;

  const need = (permission: "canvas:read" | "canvas:write", ws: string) => {
    if (!allows([scope(permission, ws)])) {
      throw forbidden("You do not have access to comments on this board");
    }
  };
  const peopleIds = (ws: string) =>
    new Set(
      mentionablePeople(database, ws).map((person) => person.principalId),
    );

  const emit = (
    ws: string,
    action: CommentAction,
    comment: BoardComment,
    mentions: readonly string[],
  ) => {
    const author = comment.authorPrincipalId;
    publish(ws, {
      type: "board.comment",
      boardId: comment.boardId,
      action,
      comment: {
        id: comment.id,
        parentId: comment.parentId,
        anchorKind: comment.anchor.kind,
        ...(comment.anchor.kind === "point"
          ? {}
          : { anchorId: comment.anchor.id }),
      },
      // 不叫自己。
      mentions: mentions.filter((id) => id !== author),
    });
  };

  router.handle(
    "GET",
    COMMENTS_PATH,
    answered((match, request) => {
      const ws = workspaceId(match);
      const board = getBoard(database, ws, paramOf(match, "boardId"));
      need("canvas:read", ws);
      const anchorKind = request.query.get("anchorKind");
      const anchorId = request.query.get("anchorId");
      let anchor: { kind: "node" | "item"; id: string } | undefined;
      if (anchorKind !== null || anchorId !== null) {
        if (
          (anchorKind !== "node" && anchorKind !== "item") ||
          anchorId === null ||
          anchorId === ""
        ) {
          throw badRequest("anchorKind must be node or item, with anchorId");
        }
        anchor = { kind: anchorKind, id: anchorId };
      }
      const resolved = request.query.get("resolved");
      const people = mentionablePeople(database, ws);
      const ids = new Set(people.map((person) => person.principalId));
      let rows = listComments(database, board.id, {
        ...(anchor === undefined ? {} : { anchor }),
      });
      if (resolved === "false") {
        // 回复自己没有解决状态，随父评论：父评论解决了，回复一起收起。
        const closed = new Set(
          rows.filter((row) => row.resolvedAtMs !== null).map((row) => row.id),
        );
        rows = rows.filter(
          (row) =>
            row.resolvedAtMs === null &&
            (row.parentId === null || !closed.has(row.parentId)),
        );
      }
      const comments = rows.map((comment) => viewOf(comment, ids));
      return { status: 200, body: { comments, people } };
    }),
  );

  router.handle(
    "POST",
    COMMENTS_PATH,
    answered((match, request) => {
      const ws = workspaceId(match);
      const board = getBoard(database, ws, paramOf(match, "boardId"));
      need("canvas:write", ws);
      const body = jsonObject(request.body);
      const parentId = body.parentId;
      if (
        parentId !== undefined &&
        parentId !== null &&
        typeof parentId !== "string"
      ) {
        throw badRequest("parentId must be a string");
      }
      const created = createComment(
        database,
        {
          boardId: board.id,
          // 回复的锚点随父评论；没给锚点的回复照样能建。
          anchor: (body.anchor ??
            (typeof parentId === "string"
              ? { kind: "point", x: 0, y: 0 }
              : undefined)) as CommentAnchor,
          body: body.body as string,
          authorPrincipalId: currentSubject().principalId,
          parentId: typeof parentId === "string" ? parentId : null,
        },
        now(),
      );
      const view = viewOf(created, peopleIds(ws));
      emit(ws, "created", created, view.mentions);
      return { status: 201, body: view };
    }),
  );

  router.handle(
    "PATCH",
    COMMENT_PATH,
    answered((match, request) => {
      const ws = workspaceId(match);
      const board = getBoard(database, ws, paramOf(match, "boardId"));
      need("canvas:write", ws);
      const id = paramOf(match, "commentId");
      const before = getComment(database, board.id, id);
      // 改别人的话等于替别人说话：owner 也不行，owner 能做的是删。
      if (before.authorPrincipalId !== currentSubject().principalId) {
        throw forbidden("Only the author can edit a comment");
      }
      const body = jsonObject(request.body);
      const updated = updateCommentBody(
        database,
        board.id,
        id,
        body.body as string,
        now(),
      );
      const ids = peopleIds(ws);
      const view = viewOf(updated, ids);
      const earlier = new Set(mentionTokens(before.body));
      emit(
        ws,
        "updated",
        updated,
        view.mentions.filter((principal) => !earlier.has(principal)),
      );
      return { status: 200, body: view };
    }),
  );

  router.handle(
    "DELETE",
    COMMENT_PATH,
    answered((match) => {
      const ws = workspaceId(match);
      const board = getBoard(database, ws, paramOf(match, "boardId"));
      need("canvas:write", ws);
      const id = paramOf(match, "commentId");
      const comment = getComment(database, board.id, id);
      const subject = currentSubject();
      if (
        comment.authorPrincipalId !== subject.principalId &&
        !isOwner(subject)
      ) {
        throw forbidden("Only the author or the owner can delete a comment");
      }
      deleteComment(database, board.id, id);
      audit({
        action: "canvas.comment.delete",
        target: id,
        workspaceId: ws,
        detail: {
          boardId: board.id,
          author: comment.authorPrincipalId,
          own: comment.authorPrincipalId === subject.principalId,
        },
      });
      emit(ws, "deleted", comment, []);
      return { status: 204, body: undefined };
    }),
  );

  router.handle(
    "POST",
    COMMENT_RESOLVE_PATH,
    answered((match, request) => {
      const ws = workspaceId(match);
      const board = getBoard(database, ws, paramOf(match, "boardId"));
      need("canvas:write", ws);
      const body = jsonObject(request.body);
      if (body.resolved !== undefined && typeof body.resolved !== "boolean") {
        throw badRequest("resolved must be a boolean");
      }
      const resolved = body.resolved !== false;
      const comment = setCommentResolved(
        database,
        board.id,
        paramOf(match, "commentId"),
        resolved,
        now(),
      );
      emit(ws, resolved ? "resolved" : "reopened", comment, []);
      return { status: 200, body: viewOf(comment, peopleIds(ws)) };
    }),
  );
}

function paramOf(
  match: { params: Readonly<Record<string, string>> },
  name: string,
): string {
  const value = match.params[name];
  if (value === undefined) throw internalError(`${name} is not in the path`);
  return value;
}
