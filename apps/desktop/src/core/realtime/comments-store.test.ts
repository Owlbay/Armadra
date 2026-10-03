import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DomainError } from "../workspaces/support";
import {
  commentsOnNodes,
  createComment,
  deleteComment,
  listComments,
  setCommentResolved,
  updateCommentBody,
} from "./comments-store";
import { type BoardFixture, boardFixture } from "./realtime.fixture";

describe("评论存取", () => {
  let fx: BoardFixture;
  beforeEach(() => {
    fx = boardFixture();
  });
  afterEach(() => fx.close());

  it("三种锚点、一层回复、解决与删除", () => {
    const db = fx.core.database;
    const boardId = fx.board.id;
    const onNode = createComment(
      db,
      {
        boardId,
        anchor: { kind: "node", id: "n1" },
        body: "  看这里 @alice ",
        authorPrincipalId: "p1",
      },
      1_000,
    );
    expect(onNode).toMatchObject({
      anchor: { kind: "node", id: "n1" },
      body: "看这里 @alice",
      parentId: null,
      resolvedAtMs: null,
      createdAtMs: 1_000,
    });
    const atPoint = createComment(
      db,
      {
        boardId,
        anchor: { kind: "point", x: 10.5, y: -3 },
        body: "空白处",
        authorPrincipalId: "p2",
      },
      2_000,
    );
    expect(atPoint.anchor).toEqual({ kind: "point", x: 10.5, y: -3 });
    // 回复的锚点随父评论，不随请求。
    const reply = createComment(
      db,
      {
        boardId,
        anchor: { kind: "item", id: "wb:x" },
        body: "收到",
        authorPrincipalId: "p2",
        parentId: onNode.id,
      },
      3_000,
    );
    expect(reply.anchor).toEqual({ kind: "node", id: "n1" });
    expect(() =>
      createComment(db, {
        boardId,
        anchor: { kind: "node", id: "n1" },
        body: "二层",
        authorPrincipalId: "p2",
        parentId: reply.id,
      }),
    ).toThrowError(/one level/);

    expect(
      listComments(db, boardId, { anchor: { kind: "node", id: "n1" } }).map(
        (comment) => comment.id,
      ),
    ).toEqual([onNode.id, reply.id]);
    expect(commentsOnNodes(db, boardId, ["n1", "n2"])).toHaveLength(2);

    expect(
      updateCommentBody(db, boardId, onNode.id, "改过", 4_000),
    ).toMatchObject({
      body: "改过",
      updatedAtMs: 4_000,
    });
    expect(
      setCommentResolved(db, boardId, onNode.id, true, 5_000).resolvedAtMs,
    ).toBe(5_000);
    expect(
      listComments(db, boardId, { includeResolved: false }).map((c) => c.id),
    ).toEqual([atPoint.id, reply.id]);
    expect(() => setCommentResolved(db, boardId, reply.id, true)).toThrowError(
      /top-level/,
    );

    deleteComment(db, boardId, onNode.id);
    expect(listComments(db, boardId).map((comment) => comment.id)).toEqual([
      atPoint.id,
    ]);
  });

  it("坏输入与别的板上的评论", () => {
    const db = fx.core.database;
    const boardId = fx.board.id;
    const bad = [
      { anchor: { kind: "point", x: Number.NaN, y: 0 }, body: "x" },
      { anchor: { kind: "node", id: "" }, body: "x" },
      { anchor: { kind: "elsewhere" }, body: "x" },
      { anchor: { kind: "node", id: "n" }, body: "   " },
      { anchor: { kind: "node", id: "n" }, body: "x".repeat(10_001) },
    ];
    for (const input of bad) {
      expect(() =>
        createComment(db, {
          boardId,
          anchor: input.anchor as never,
          body: input.body,
          authorPrincipalId: "p",
        }),
      ).toThrowError(DomainError);
    }
    const comment = createComment(db, {
      boardId,
      anchor: { kind: "node", id: "n" },
      body: "x",
      authorPrincipalId: "p",
    });
    let error: unknown;
    try {
      deleteComment(db, "another-board", comment.id);
    } catch (caught) {
      error = caught;
    }
    expect((error as DomainError).status).toBe(404);
  });
});
