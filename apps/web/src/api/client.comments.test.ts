import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commentsApi } from "@/realtime/comments/store";
import { RuntimeRequestError } from "./request";
import { setCurrentSourceResolver } from "./source";

/**
 * 评论的页面一侧（契约 §36.5）：都发 `POST /api/rpc/boards/<动词>`，体是
 * `{ json: { … } }`，答案过页面自己的 schema。
 */

const workspaceId = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const boardId = "019ff7d1-7419-74df-89e2-b1619d36ea7d";

const comment = {
  id: "c1",
  boardId,
  anchor: { kind: "point", x: 1, y: 2 },
  body: "hello",
  authorPrincipalId: "a".repeat(32),
  parentId: null,
  createdAtMs: 1,
  updatedAtMs: 1,
  resolvedAtMs: null,
  mentions: [],
};

type Call = { url: string; init: RequestInit };
let calls: Call[];

function answer(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stub(respond: (call: Call) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call = {
        url: input instanceof Request ? input.url : String(input),
        init: init ?? {},
      };
      calls.push(call);
      return respond(call);
    }),
  );
}

const ok = (json: unknown) => stub(() => answer(200, { json }));
const sent = (index = 0): unknown =>
  JSON.parse(String(calls[index]?.init.body ?? "null"));
const procedure = (index = 0): string | undefined =>
  calls[index]?.url.split("/api/rpc/")[1];

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  setCurrentSourceResolver(null);
});

describe("评论经 boards.* procedure", () => {
  it("列出：答评论与可提及的人", async () => {
    ok({ comments: [comment], people: [{ principalId: "p", name: "P" }] });
    const list = await commentsApi.list(workspaceId, boardId);
    expect(procedure()).toBe("boards/comments");
    expect(sent()).toEqual({ json: { workspaceId, boardId } });
    expect(list.comments[0]).toMatchObject({ id: "c1", body: "hello" });
    expect(list.people).toEqual([{ principalId: "p", name: "P" }]);
  });

  it("新建、改正文、解决、删除各是一条 procedure", async () => {
    ok(comment);
    await commentsApi.create(workspaceId, boardId, {
      anchor: { kind: "node", id: "n1" },
      body: "hi",
    });
    await commentsApi.create(workspaceId, boardId, {
      parentId: "c1",
      body: "reply",
    });
    await commentsApi.edit(workspaceId, boardId, "c1", "edited");
    await commentsApi.resolve(workspaceId, boardId, "c1", false);
    ok(undefined);
    await expect(
      commentsApi.remove(workspaceId, boardId, "c1"),
    ).resolves.toBeUndefined();
    expect(calls.map((_, index) => procedure(index))).toEqual([
      "boards/createComment",
      "boards/createComment",
      "boards/updateComment",
      "boards/resolveComment",
      "boards/deleteComment",
    ]);
    expect(sent(0)).toEqual({
      json: {
        workspaceId,
        boardId,
        anchor: { kind: "node", id: "n1" },
        body: "hi",
      },
    });
    expect(sent(1)).toEqual({
      json: { workspaceId, boardId, parentId: "c1", body: "reply" },
    });
    expect(sent(2)).toEqual({
      json: { workspaceId, boardId, commentId: "c1", body: "edited" },
    });
    expect(sent(3)).toEqual({
      json: { workspaceId, boardId, commentId: "c1", resolved: false },
    });
    expect(sent(4)).toEqual({
      json: { workspaceId, boardId, commentId: "c1" },
    });
  });

  it("拒绝带着原样的状态与码", async () => {
    stub(() =>
      answer(403, {
        code: "forbidden",
        message: "Only the author can edit a comment",
        requestId: "r",
      }),
    );
    const failure = await commentsApi
      .edit(workspaceId, boardId, "c1", "x")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeRequestError);
    expect((failure as RuntimeRequestError).code).toBe("forbidden");
    expect((failure as RuntimeRequestError).status).toBe(403);
  });
});
