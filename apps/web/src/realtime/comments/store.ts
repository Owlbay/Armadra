import { create } from "zustand";
import {
  boardCommentSchema,
  commentListSchema,
  mentionToken,
  type BoardComment,
  type CommentAnchor,
  type CommentPerson,
} from "@armadra/shared";

import { onWorkspaceEvent } from "@/api/events";
import { json, noContentSchema, request } from "@/api/request";

/**
 * 评论（契约 §16.3，设计系统 §5.7）的页面状态：当前板的评论与可提及的人、
 * 评论模式、正在看的线程与新钉的草稿。
 *
 * 真相在 core：每次写入之后、以及收到同一块板的 `board.comment` 时整表重拉
 * （一块板的评论是几十条的量，增量合并换不来什么）。
 */

const base = (workspaceId: string, boardId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/boards/${encodeURIComponent(boardId)}/comments`;

export const commentsApi = {
  list: (workspaceId: string, boardId: string) =>
    request(base(workspaceId, boardId), commentListSchema),
  create: (
    workspaceId: string,
    boardId: string,
    input: { anchor?: CommentAnchor; body: string; parentId?: string },
  ) =>
    request(base(workspaceId, boardId), boardCommentSchema, {
      method: "POST",
      ...json(input),
    }),
  edit: (workspaceId: string, boardId: string, id: string, body: string) =>
    request(
      `${base(workspaceId, boardId)}/${encodeURIComponent(id)}`,
      boardCommentSchema,
      { method: "PATCH", ...json({ body }) },
    ),
  remove: (workspaceId: string, boardId: string, id: string) =>
    request(
      `${base(workspaceId, boardId)}/${encodeURIComponent(id)}`,
      noContentSchema,
      { method: "DELETE" },
    ),
  resolve: (
    workspaceId: string,
    boardId: string,
    id: string,
    resolved: boolean,
  ) =>
    request(
      `${base(workspaceId, boardId)}/${encodeURIComponent(id)}/resolve`,
      boardCommentSchema,
      { method: "POST", ...json({ resolved }) },
    ),
};

/** 一条顶层评论与它的回复。 */
export interface CommentThreadData {
  readonly root: BoardComment;
  readonly replies: readonly BoardComment[];
}

/** 按创建顺序把评论排成线程；父评论不在表里的回复丢掉。 */
export function threadsOf(
  comments: readonly BoardComment[],
): CommentThreadData[] {
  const replies = new Map<string, BoardComment[]>();
  for (const comment of comments) {
    if (comment.parentId === null) continue;
    const list = replies.get(comment.parentId) ?? [];
    list.push(comment);
    replies.set(comment.parentId, list);
  }
  return comments
    .filter((comment) => comment.parentId === null)
    .map((root) => ({ root, replies: replies.get(root.id) ?? [] }));
}

/** 锚点的键：同一个节点 / item / 坐标上的线程聚成一枚钉。 */
export function anchorKey(anchor: CommentAnchor): string {
  return anchor.kind === "point"
    ? `point:${Math.round(anchor.x)}:${Math.round(anchor.y)}`
    : `${anchor.kind}:${anchor.id}`;
}

/** 正文里的一段：纯文本，或一个提及。 */
export type BodyPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "mention"; readonly name: string; readonly id: string };

const MENTION = /@\[([^\]\n]{1,80})\]\(principal:([A-Za-z0-9._:-]{1,128})\)/g;

export function bodyParts(body: string): BodyPart[] {
  const parts: BodyPart[] = [];
  let last = 0;
  for (const match of body.matchAll(MENTION)) {
    const index = match.index ?? 0;
    if (index > last) {
      parts.push({ kind: "text", text: body.slice(last, index) });
    }
    parts.push({ kind: "mention", name: match[1] ?? "", id: match[2] ?? "" });
    last = index + match[0].length;
  }
  if (last < body.length) parts.push({ kind: "text", text: body.slice(last) });
  return parts;
}

/**
 * 输入框里写的是 `@显示名`；发出去之前把选过的人换成提及记号。没选过的
 * `@某某` 原样留着（core 也不会叫任何人）。
 */
export function encodeMentions(
  text: string,
  picked: readonly CommentPerson[],
): string {
  let out = text;
  // 长名字先换：`@Ann` 不该吃掉 `@Anna` 的前半截。
  const byLength = [...picked].sort((a, b) => b.name.length - a.name.length);
  for (const person of byLength) {
    const plain = `@${person.name}`;
    out = out.split(plain).join(mentionToken(person.name, person.principalId));
  }
  return out;
}

/** 编辑已有评论时反过来：记号还原成 `@显示名`，并记下这些人。 */
export function decodeMentions(body: string): {
  text: string;
  picked: CommentPerson[];
} {
  const picked: CommentPerson[] = [];
  const text = body.replace(MENTION, (_whole, name: string, id: string) => {
    if (!picked.some((person) => person.principalId === id)) {
      picked.push({ principalId: id, name });
    }
    return `@${name}`;
  });
  return { text, picked };
}

interface CommentsState {
  workspaceId: string | null;
  boardId: string | null;
  comments: BoardComment[];
  people: CommentPerson[];
  loaded: boolean;
  /** 评论模式：点画布放钉，右侧开评论抽屉。 */
  mode: boolean;
  /** 抽屉里只列未解决的线程。 */
  onlyOpen: boolean;
  /** 弹层里打开的那一枚钉（锚点键）。 */
  openPin: string | null;
  /** 刚点下、还没发出去的新钉。 */
  draft: CommentAnchor | null;
}

const EMPTY: Pick<
  CommentsState,
  "comments" | "people" | "loaded" | "openPin" | "draft"
> = {
  comments: [],
  people: [],
  loaded: false,
  openPin: null,
  draft: null,
};

export const useCommentsStore = create<CommentsState>(() => ({
  workspaceId: null,
  boardId: null,
  mode: false,
  onlyOpen: false,
  ...EMPTY,
}));

export function setCommentMode(mode: boolean): void {
  useCommentsStore.setState(
    mode ? { mode } : { mode, draft: null, openPin: null },
  );
}

export function setOnlyOpen(onlyOpen: boolean): void {
  useCommentsStore.setState({ onlyOpen });
}

export function openPin(key: string | null): void {
  useCommentsStore.setState({ openPin: key, draft: null });
}

export function startDraft(anchor: CommentAnchor | null): void {
  useCommentsStore.setState({ draft: anchor, openPin: null });
}

let generation = 0;

/** 重新拉当前板的评论；换了板的旧答复丢掉。 */
export async function refreshComments(): Promise<void> {
  const { workspaceId, boardId } = useCommentsStore.getState();
  if (workspaceId === null || boardId === null) return;
  const mine = ++generation;
  try {
    const list = await commentsApi.list(workspaceId, boardId);
    if (mine !== generation) return;
    useCommentsStore.setState({
      comments: list.comments,
      people: list.people,
      loaded: true,
    });
  } catch {
    // 拉不到（没有权限、core 旧）就当没有评论；下一次事件再试。
    if (mine === generation) useCommentsStore.setState({ loaded: true });
  }
}

/**
 * 跟着当前板：换板清空并重拉，同一块板的 `board.comment` 触发重拉。
 * 返回退订函数。
 */
export function followBoard(
  workspaceId: string | null,
  boardId: string | null,
): () => void {
  const current = useCommentsStore.getState();
  if (current.workspaceId !== workspaceId || current.boardId !== boardId) {
    generation += 1;
    useCommentsStore.setState({ workspaceId, boardId, ...EMPTY });
  }
  if (workspaceId === null || boardId === null) return () => undefined;
  void refreshComments();
  return onWorkspaceEvent("board.comment", (event) => {
    if (event.boardId === useCommentsStore.getState().boardId) {
      void refreshComments();
    }
  });
}

/** 写一次，然后重拉（事件也会到，这一次是为了自己立刻看到）。 */
export async function mutateComments<T>(work: () => Promise<T>): Promise<T> {
  const result = await work();
  await refreshComments();
  return result;
}
