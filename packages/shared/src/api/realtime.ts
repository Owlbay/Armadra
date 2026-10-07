import { z } from "zod";

/**
 * Real-time collaboration (contract §16, docs/design/completion-architecture.md
 * §6). §16.1–§16.2 (sync frames, materialisation) are filled in by G1-9;
 * comments (§16.3) and the awareness shape (§16.4) by G2-6 / G2-5.
 */

/** Hello capability: this core speaks the `…/sync` protocol (§16.1). */
export const REALTIME_CAPABILITY = "canvas.realtime.v1";

/**
 * Outer message type of a `…/sync` binary frame (a lib0 varUint), the same
 * framing `y-websocket` uses. `sync` carries a y-protocols sync message
 * (step1 / step2 / update); `awareness` an awareness update.
 */
export const REALTIME_MESSAGE = {
  sync: 0,
  awareness: 1,
  queryAwareness: 3,
} as const;

/** Close codes of the `…/sync` socket (§16.1). */
export const REALTIME_CLOSE = {
  /** The core is stopping, or the board's document was evicted. Reconnect. */
  goingAway: 1001,
  /** One frame exceeded {@link REALTIME_MAX_FRAME_BYTES}. */
  tooLarge: 1009,
  /** A frame could not be decoded, or was a text frame. */
  badFrame: 4400,
  /**
   * An update from a connection without `canvas:write`, or write/read access
   * was revoked. Do not reconnect as a writer; treat the board as read-only.
   */
  forbidden: 4403,
} as const;

export const REALTIME_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * `GET /api/workspaces/{id}/boards/{boardId}/realtime` (§16.2): whether a
 * board has moved to a live `Y.Doc`, how far the tables are materialised, and
 * whether the setting `collab.realtime` lets a board switch.
 *
 * A page opens `…/sync` when `realtime || enabled`; otherwise it stays on the
 * lease + CAS path.
 */
export const boardRealtimeStateSchema = z.looseObject({
  realtime: z.boolean(),
  materializedSeq: z.number().int().nonnegative(),
  enabled: z.boolean().optional(),
});

export type BoardRealtimeState = z.infer<typeof boardRealtimeStateSchema>;

/** Error codes the realtime domain adds (§16.2). */
export const REALTIME_ERROR_CODES = {
  /** `PUT …/document` on a realtime board: edits go through `…/sync`. */
  active: "realtime_active",
  /** `…/sync` upgrade refused: setting off and the board is not realtime. */
  disabled: "realtime_disabled",
} as const;

/* -------------------------------------------------------------------------- */
/*                         awareness 状态（契约 §16.4）                         */
/* -------------------------------------------------------------------------- */

/**
 * awareness 状态的上限。core 的 `realtime/awareness.ts` 手写同一套检查（core
 * 不依赖本包），两边的数字必须一致。
 */
export const AWARENESS_LIMITS = {
  /** `principalId` / `deviceId` / `focusNodeId` / 选区每一项的长度。 */
  idLength: 128,
  /** 显示名长度。 */
  nameLength: 80,
  /** 成员色环长度（设计系统 §2.5），`color` 取 `1..colors`。 */
  colors: 8,
  /** 选区里最多列多少个 id。 */
  selection: 256,
  /** 序列化之后一份状态的字节上限。 */
  stateBytes: 16 * 1024,
  /** `viewport.zoom` 的取值范围（含两端）；画布自己只用 0.1–3。 */
  minZoom: 0.01,
  maxZoom: 100,
} as const;

const awarenessId = z.string().min(1).max(AWARENESS_LIMITS.idLength);

/**
 * 一个连接的 awareness 状态（补全架构 §6.2，契约 §16.4）。
 *
 *   * `principalId`：core 按连接身份**改写**，客户端填什么都不算（本机壳是
 *     owner，为 `""`）。
 *   * `deviceId`：页面的 `clientId`（同一个人的两个窗口各有一个）。
 *   * `color`：成员色序号 `1..8`（设计系统 §2.5）。加入时取在场者没用过的
 *     最小一个（从 2 起），所以各个观看者看到的同一个人颜色相同。
 *   * `cursor`：画布坐标；指针离开画布时省略。
 *   * `selection`：选中的节点 id（白板对象带 `wb:` 前缀）。
 *   * `viewport`：视口中心的画布坐标与缩放。用中心而不是平移量，窗口大小
 *     不同的两个人跟随时看到的是同一块地方。
 *
 * 认不出的状态（形状不对、超长）整条丢弃，不进在线表。
 */
export const awarenessStateSchema = z.object({
  principalId: z.string().max(AWARENESS_LIMITS.idLength),
  deviceId: awarenessId,
  name: z.string().max(AWARENESS_LIMITS.nameLength),
  color: z.number().int().min(1).max(AWARENESS_LIMITS.colors),
  cursor: z
    .object({ x: z.number().finite(), y: z.number().finite() })
    .optional(),
  selection: z.array(awarenessId).max(AWARENESS_LIMITS.selection).optional(),
  focusNodeId: awarenessId.optional(),
  viewport: z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
      zoom: z
        .number()
        .finite()
        .min(AWARENESS_LIMITS.minZoom)
        .max(AWARENESS_LIMITS.maxZoom),
    })
    .optional(),
});

export type AwarenessState = z.infer<typeof awarenessStateSchema>;

/* -------------------------------------------------------------------------- */
/*                              评论（契约 §16.3）                              */
/* -------------------------------------------------------------------------- */

/** 评论正文的上限（字符），与 core `realtime/comments-store.ts` 一致。 */
export const MAX_COMMENT_CHARS = 10_000;

/** 锚点：节点、白板 item（id 带 `wb:` 前缀与否由页面定）或画布坐标。 */
export const commentAnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node"), id: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("item"), id: z.string().min(1).max(200) }),
  z.object({
    kind: z.literal("point"),
    x: z.number().finite(),
    y: z.number().finite(),
  }),
]);

export type CommentAnchor = z.infer<typeof commentAnchorSchema>;

export const boardCommentSchema = z.looseObject({
  id: z.string(),
  boardId: z.string(),
  anchor: commentAnchorSchema,
  /** 正文。提及写成 `@[显示名](principal:<id>)`。 */
  body: z.string(),
  authorPrincipalId: z.string(),
  /** 回复指向的顶层评论；回复只有一层，锚点随父评论。 */
  parentId: z.string().nullable(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
  /** 只有顶层评论有；回复随父评论。 */
  resolvedAtMs: z.number().nullable(),
  /** core 认出来的提及：对这个工作空间有 `canvas:read` 的 principal。 */
  mentions: z.array(z.string()),
});

export type BoardComment = z.infer<typeof boardCommentSchema>;

/** 能被提及的人：对这个工作空间有 `canvas:read`、没停用。 */
export const commentPersonSchema = z.object({
  principalId: z.string(),
  name: z.string(),
});

export type CommentPerson = z.infer<typeof commentPersonSchema>;

/** `GET …/boards/{boardId}/comments`。 */
export const commentListSchema = z.looseObject({
  comments: z.array(boardCommentSchema),
  people: z.array(commentPersonSchema),
});

export type CommentList = z.infer<typeof commentListSchema>;

export const COMMENT_ACTIONS = [
  "created",
  "updated",
  "resolved",
  "reopened",
  "deleted",
] as const;

/**
 * 工作空间事件 `board.comment`：一条评论变了。不带正文；`mentions` 是这一次
 * 新叫到的人（不含作者），推送域按它发通知。
 */
export const boardCommentEventSchema = z.object({
  type: z.literal("board.comment"),
  boardId: z.string(),
  action: z.enum(COMMENT_ACTIONS),
  comment: z.object({
    id: z.string(),
    parentId: z.string().nullable(),
    anchorKind: z.enum(["node", "item", "point"]),
    anchorId: z.string().optional(),
  }),
  mentions: z.array(z.string()),
});

/** 提及记号：`@[显示名](principal:<id>)`。 */
export function mentionToken(name: string, principalId: string): string {
  const clean =
    name
      .replace(/[\]\n]/g, " ")
      .trim()
      .slice(0, 80) || "?";
  return `@[${clean}](principal:${principalId})`;
}
