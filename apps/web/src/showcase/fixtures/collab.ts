import type { BoardComment, CommentPerson } from "@armadra/shared";

import type { Peer } from "@/realtime/awareness";

/**
 * `collab` 分区的假在线成员（设计展示页 §2.1，设计系统 §5.6）。纯对象；
 * 名字是数据不是界面文案，允许中文。
 */

const NAMES = ["林舟", "Ada", "周远", "Mika", "陈一", "Noor"];

function peer(index: number, cursor?: { x: number; y: number }): Peer {
  return {
    clientId: 100 + index,
    state: {
      principalId: `p${index}`,
      deviceId: `d${index}`,
      name: NAMES[index] ?? `#${index}`,
      color: 2 + index,
      ...(cursor ? { cursor } : {}),
    },
  };
}

/** 头像堆叠的三档：只有一个别人、三个、六个（溢出成 +N）。 */
export const PEER_SETS: readonly (readonly Peer[])[] = [
  [peer(0)],
  [peer(0), peer(1), peer(2)],
  [peer(0), peer(1), peer(2), peer(3), peer(4), peer(5)],
];

/** 光标样本：画在 360×180 的小画布上。 */
export const CURSOR_PEERS: readonly Peer[] = [
  peer(0, { x: 60, y: 40 }),
  peer(1, { x: 210, y: 110 }),
];

/* --------------------------------- 评论 ---------------------------------- */

/** 评论样本的「现在」：时间都相对它，截图稳定。 */
export const COMMENT_NOW = Date.parse("2026-10-03T08:00:00.000Z");

export const COMMENT_SELF = "a".repeat(32);

export const COMMENT_PEOPLE: readonly CommentPerson[] = [
  { principalId: COMMENT_SELF, name: "林舟" },
  { principalId: "b".repeat(32), name: "Ada" },
  { principalId: "c".repeat(32), name: "周远" },
];

function comment(
  id: string,
  author: number,
  minutesAgo: number,
  body: string,
  patch: Partial<BoardComment> = {},
): BoardComment {
  const at = COMMENT_NOW - minutesAgo * 60_000;
  return {
    id,
    boardId: "board",
    anchor: { kind: "node", id: "node-1" },
    body,
    authorPrincipalId: COMMENT_PEOPLE[author]!.principalId,
    parentId: null,
    createdAtMs: at,
    updatedAtMs: at,
    resolvedAtMs: null,
    mentions: [],
    ...patch,
  };
}

/** 一条带回复、带提及的未解决线程，一条已解决的。 */
export const COMMENT_ROOT = comment(
  "c1",
  1,
  3,
  `这里的重试次数 @[周远](principal:${"c".repeat(32)}) 再确认一下？`,
);
export const COMMENT_REPLY = comment("c2", 2, 1, "确认过了，3 次。", {
  parentId: "c1",
});
export const COMMENT_RESOLVED = comment("c3", 0, 120, "标题改成英文", {
  anchor: { kind: "point", x: 0, y: 0 },
  resolvedAtMs: COMMENT_NOW - 60 * 60_000,
});
