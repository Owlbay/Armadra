/**
 * 评论路由（契约 §16.3、§36.5，补全架构 §6.3 评论段）。
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
import { type DomainHandlers, registerProcedures } from "../http/rpc";
import type { CoreServer } from "../http/server";
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

/**
 * 新建评论时域收的那几样（旧路径的体、procedure 的入参归成同一个样子）。动作收的
 * 是取它的函数：旧路径在板与权限都判过之后才读体，体不是 JSON 的拒绝排在后面。
 */
interface CreateInput {
  readonly anchor: unknown;
  readonly body: unknown;
  readonly parentId: unknown;
}

/**
 * 评论的动作。旧 REST 路径与契约 procedure（契约 §36.5，`boards.*Comment*`）调
 * 的是同一份：两边只把各自的入参归成同一个样子，拒绝在这里抛，码与原话因此一样。
 */
export function commentOperations(options: CommentRoutesOptions) {
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

  return {
    /**
     * `anchorKind` / `anchorId` 缺席是 `undefined`（旧路径的查询串没给）；`openOnly`
     * 是 `resolved=false`。
     */
    list(
      ws: string,
      rawBoard: string,
      anchorKind: string | undefined,
      anchorId: string | undefined,
      openOnly: boolean,
    ) {
      const board = getBoard(database, ws, rawBoard);
      need("canvas:read", ws);
      let anchor: { kind: "node" | "item"; id: string } | undefined;
      if (anchorKind !== undefined || anchorId !== undefined) {
        if (
          (anchorKind !== "node" && anchorKind !== "item") ||
          anchorId === undefined ||
          anchorId === ""
        ) {
          throw badRequest("anchorKind must be node or item, with anchorId");
        }
        anchor = { kind: anchorKind, id: anchorId };
      }
      const people = mentionablePeople(database, ws);
      const ids = new Set(people.map((person) => person.principalId));
      let rows = listComments(database, board.id, {
        ...(anchor === undefined ? {} : { anchor }),
      });
      if (openOnly) {
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
      return { comments, people };
    },

    create(ws: string, rawBoard: string, read: () => CreateInput): CommentView {
      const board = getBoard(database, ws, rawBoard);
      need("canvas:write", ws);
      const input = read();
      const parentId = input.parentId;
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
          anchor: (input.anchor ??
            (typeof parentId === "string"
              ? { kind: "point", x: 0, y: 0 }
              : undefined)) as CommentAnchor,
          body: input.body as string,
          authorPrincipalId: currentSubject().principalId,
          parentId: typeof parentId === "string" ? parentId : null,
        },
        now(),
      );
      const view = viewOf(created, peopleIds(ws));
      emit(ws, "created", created, view.mentions);
      return view;
    },

    edit(ws: string, rawBoard: string, id: string, read: () => unknown) {
      const board = getBoard(database, ws, rawBoard);
      need("canvas:write", ws);
      const before = getComment(database, board.id, id);
      // 改别人的话等于替别人说话：owner 也不行，owner 能做的是删。
      if (before.authorPrincipalId !== currentSubject().principalId) {
        throw forbidden("Only the author can edit a comment");
      }
      const updated = updateCommentBody(
        database,
        board.id,
        id,
        read() as string,
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
      return view;
    },

    remove(ws: string, rawBoard: string, id: string): void {
      const board = getBoard(database, ws, rawBoard);
      need("canvas:write", ws);
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
    },

    resolve(ws: string, rawBoard: string, id: string, read: () => unknown) {
      const board = getBoard(database, ws, rawBoard);
      need("canvas:write", ws);
      const raw = read();
      if (raw !== undefined && typeof raw !== "boolean") {
        throw badRequest("resolved must be a boolean");
      }
      const resolved = raw !== false;
      const comment = setCommentResolved(
        database,
        board.id,
        id,
        resolved,
        now(),
      );
      emit(ws, resolved ? "resolved" : "reopened", comment, []);
      return viewOf(comment, peopleIds(ws));
    },
  };
}

/**
 * 装上评论的旧路径，并把同一份动作登记成 `boards.*Comment*` procedure（契约
 * §36.5）。
 */
export function installCommentRoutes(
  server: CoreServer,
  options: CommentRoutesOptions,
): void {
  const { router } = server;
  const operations = commentOperations(options);

  registerProcedures(server, "boards", {
    comments: ({
      workspaceId: ws,
      boardId,
      anchorKind,
      anchorId,
      resolved,
    }: {
      workspaceId: string;
      boardId: string;
      anchorKind?: string;
      anchorId?: string;
      resolved?: boolean | string;
    }) =>
      operations.list(
        ws,
        boardId,
        anchorKind,
        anchorId,
        resolved === false || resolved === "false",
      ),
    createComment: ({
      workspaceId: ws,
      boardId,
      anchor,
      body,
      parentId,
    }: {
      workspaceId: string;
      boardId: string;
      anchor?: unknown;
      body?: string;
      parentId?: string | null;
    }) => operations.create(ws, boardId, () => ({ anchor, body, parentId })),
    updateComment: ({
      workspaceId: ws,
      boardId,
      commentId,
      body,
    }: {
      workspaceId: string;
      boardId: string;
      commentId: string;
      body?: string;
    }) => operations.edit(ws, boardId, commentId, () => body),
    deleteComment: ({
      workspaceId: ws,
      boardId,
      commentId,
    }: {
      workspaceId: string;
      boardId: string;
      commentId: string;
    }) => operations.remove(ws, boardId, commentId),
    resolveComment: ({
      workspaceId: ws,
      boardId,
      commentId,
      resolved,
    }: {
      workspaceId: string;
      boardId: string;
      commentId: string;
      resolved?: boolean;
    }) => operations.resolve(ws, boardId, commentId, () => resolved),
  } as unknown as DomainHandlers<"boards">);

  router.handle(
    "GET",
    COMMENTS_PATH,
    answered((match, request) => ({
      status: 200,
      body: operations.list(
        workspaceId(match),
        paramOf(match, "boardId"),
        request.query.get("anchorKind") ?? undefined,
        request.query.get("anchorId") ?? undefined,
        request.query.get("resolved") === "false",
      ),
    })),
  );

  router.handle(
    "POST",
    COMMENTS_PATH,
    answered((match, request) => ({
      status: 201,
      body: operations.create(
        workspaceId(match),
        paramOf(match, "boardId"),
        () => {
          const body = jsonObject(request.body);
          return {
            anchor: body.anchor,
            body: body.body,
            parentId: body.parentId,
          };
        },
      ),
    })),
  );

  router.handle(
    "PATCH",
    COMMENT_PATH,
    answered((match, request) => ({
      status: 200,
      body: operations.edit(
        workspaceId(match),
        paramOf(match, "boardId"),
        paramOf(match, "commentId"),
        () => jsonObject(request.body).body,
      ),
    })),
  );

  router.handle(
    "DELETE",
    COMMENT_PATH,
    answered((match) => {
      operations.remove(
        workspaceId(match),
        paramOf(match, "boardId"),
        paramOf(match, "commentId"),
      );
      return { status: 204, body: undefined };
    }),
  );

  router.handle(
    "POST",
    COMMENT_RESOLVE_PATH,
    answered((match, request) => ({
      status: 200,
      body: operations.resolve(
        workspaceId(match),
        paramOf(match, "boardId"),
        paramOf(match, "commentId"),
        () => jsonObject(request.body).resolved,
      ),
    })),
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
