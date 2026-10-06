import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractEntries } from "@armadra/shared";
import { install as installCanvas } from "../canvas/routes";
import { routeScope } from "../http/route-scopes";
import { installContract } from "../http/rpc";
import { install as installRealtime } from "../realtime";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { type Answer, type Kit, expectParity, startKit } from "./parity-kit";

/**
 * 评论的对偶测试（契约 §36.5，§16.3 的 procedure 形式）。
 *
 * 同一份夹具问三次：路由表里原来那条 handler、旧 REST 路径（经 HTTP，由契约实现
 * 经 `OpenAPIHandler` 答）、新 procedure。成功的答案规范化后逐字节相等（新评论的
 * id 与时刻换成占位）；失败的码、状态与原话相等。改动状态的动作（改正文、解决、
 * 删除）每种答法各用自己那条评论。桌面壳的本机请求就是 owner。
 */

let core: Fixture;
let kit: Kit;
let workspaceId: string;
let boardId: string;

const VOLATILE = new Set(["id", "createdAtMs", "updatedAtMs", "resolvedAtMs"]);

beforeAll(async () => {
  core = fixture([installWorkspaces, installCanvas, installRealtime]);
  installContract(core.server, {
    validateOutput: true,
    platform: core.platform,
  });
  kit = await startKit(core.server, () => undefined);
  const created = await core.call("POST", "/api/workspaces", {
    name: "Comments",
    rootPath: core.directory,
  });
  workspaceId = (created.body as { id: string }).id;
  const boards = await core.call(
    "GET",
    `/api/workspaces/${workspaceId}/boards`,
  );
  boardId = (boards.body as { id: string }[])[0]!.id;
});

afterAll(async () => {
  await core.server.close();
  core.close();
});

const commentsPath = () =>
  `/api/workspaces/${workspaceId}/boards/${boardId}/comments`;

async function three(
  method: string,
  path: string,
  name: string,
  body: Record<string, unknown> | undefined,
  input: Record<string, unknown>,
): Promise<[Answer, Answer, Answer]> {
  return [
    await kit.table(method, path, body),
    await kit.legacy(method, path, body),
    await kit.procedure(name, { workspaceId, boardId, ...input }),
  ];
}

/** 三种答法各建一条顶层评论，返回它们的 id（原 handler、旧路径、procedure）。 */
async function threeComments(text: string): Promise<[string, string, string]> {
  const anchor = { kind: "point", x: 10, y: 20 };
  const made = await three(
    "POST",
    commentsPath(),
    "boards.createComment",
    { anchor, body: text },
    { anchor, body: text },
  );
  expectParity(made, { volatile: VOLATILE, legacyStatus: 201 });
  expect(made[0].status).toBe(201);
  return made.map((answer) => (answer.body as { id: string }).id) as [
    string,
    string,
    string,
  ];
}

describe("boards：评论（§36.5）", () => {
  it("新建、列出、按锚点筛", async () => {
    await threeComments("first");
    const anchor = { kind: "node", id: "node-1" };
    expectParity(
      await three(
        "POST",
        commentsPath(),
        "boards.createComment",
        { anchor, body: "on a node" },
        { anchor, body: "on a node" },
      ),
      { volatile: VOLATILE, legacyStatus: 201 },
    );
    const listed = await three(
      "GET",
      commentsPath(),
      "boards.comments",
      undefined,
      {},
    );
    expectParity(listed, { volatile: VOLATILE });
    expect((listed[0].body as { comments: unknown[] }).comments).toHaveLength(
      6,
    );
    const onNode = await three(
      "GET",
      `${commentsPath()}?anchorKind=node&anchorId=node-1`,
      "boards.comments",
      undefined,
      { anchorKind: "node", anchorId: "node-1" },
    );
    expectParity(onNode, { volatile: VOLATILE });
    expect((onNode[0].body as { comments: unknown[] }).comments).toHaveLength(
      3,
    );
  });

  it("回复、改正文、解决与重新打开、只看未解决的", async () => {
    const [one, two, threeId] = await threeComments("thread");
    const ids = [one, two, threeId];
    // 回复：锚点随父评论。
    const replies = [
      await kit.table("POST", commentsPath(), {
        parentId: one,
        body: "reply",
      }),
      await kit.legacy("POST", commentsPath(), {
        parentId: two,
        body: "reply",
      }),
      await kit.procedure("boards.createComment", {
        workspaceId,
        boardId,
        parentId: threeId,
        body: "reply",
      }),
    ] as const;
    expect(replies.map((answer) => answer.status)).toEqual([201, 201, 200]);
    for (const [index, answer] of replies.entries()) {
      expect(answer.body).toMatchObject({
        parentId: ids[index],
        body: "reply",
      });
    }

    expectParity(
      [
        await kit.table("PATCH", `${commentsPath()}/${one}`, {
          body: "edited",
        }),
        await kit.legacy("PATCH", `${commentsPath()}/${two}`, {
          body: "edited",
        }),
        await kit.procedure("boards.updateComment", {
          workspaceId,
          boardId,
          commentId: threeId,
          body: "edited",
        }),
      ],
      { volatile: VOLATILE },
    );

    expectParity(
      [
        await kit.table("POST", `${commentsPath()}/${one}/resolve`, {}),
        await kit.legacy("POST", `${commentsPath()}/${two}/resolve`, {}),
        await kit.procedure("boards.resolveComment", {
          workspaceId,
          boardId,
          commentId: threeId,
        }),
      ],
      { volatile: VOLATILE },
    );

    // 解决了的线程连同回复一起不在「只看未解决的」里。
    const open = await three(
      "GET",
      `${commentsPath()}?resolved=false`,
      "boards.comments",
      undefined,
      { resolved: false },
    );
    expectParity(open, { volatile: VOLATILE });
    const openIds = (
      open[0].body as { comments: { id: string }[] }
    ).comments.map((comment) => comment.id);
    for (const id of ids) expect(openIds).not.toContain(id);
    // 旧路径的查询串写法经 procedure 也认。
    const asString = await kit.procedure("boards.comments", {
      workspaceId,
      boardId,
      resolved: "false",
    });
    expect(asString.body).toEqual(open[2].body);

    expectParity(
      [
        await kit.table("POST", `${commentsPath()}/${one}/resolve`, {
          resolved: false,
        }),
        await kit.legacy("POST", `${commentsPath()}/${two}/resolve`, {
          resolved: false,
        }),
        await kit.procedure("boards.resolveComment", {
          workspaceId,
          boardId,
          commentId: threeId,
          resolved: false,
        }),
      ],
      { volatile: VOLATILE },
    );
  });

  it("删除：旧路径 204，procedure 200 无体；删过的再删是 404", async () => {
    const [one, two, threeId] = await threeComments("doomed");
    expectParity(
      [
        await kit.table("DELETE", `${commentsPath()}/${one}`),
        await kit.legacy("DELETE", `${commentsPath()}/${two}`),
        await kit.procedure("boards.deleteComment", {
          workspaceId,
          boardId,
          commentId: threeId,
        }),
      ],
      { legacyStatus: 204 },
    );
    expectParity([
      await kit.table("DELETE", `${commentsPath()}/${one}`),
      await kit.legacy("DELETE", `${commentsPath()}/${two}`),
      await kit.procedure("boards.deleteComment", {
        workspaceId,
        boardId,
        commentId: threeId,
      }),
    ]);
  });

  it("拒绝：码、状态与原话一样", async () => {
    // 锚点不对。
    const badAnchor = { kind: "elsewhere" };
    expectParity(
      await three(
        "POST",
        commentsPath(),
        "boards.createComment",
        { anchor: badAnchor, body: "x" },
        { anchor: badAnchor, body: "x" },
      ),
    );
    // 正文空。
    const anchor = { kind: "point", x: 0, y: 0 };
    expectParity(
      await three(
        "POST",
        commentsPath(),
        "boards.createComment",
        { anchor, body: "" },
        { anchor, body: "" },
      ),
    );
    // 筛选的锚点缺 id。
    expectParity(
      await three(
        "GET",
        `${commentsPath()}?anchorKind=node`,
        "boards.comments",
        undefined,
        { anchorKind: "node" },
      ),
    );
    // 没有这条评论、没有这块板。
    expectParity(
      await three(
        "PATCH",
        `${commentsPath()}/missing`,
        "boards.updateComment",
        { body: "x" },
        { commentId: "missing", body: "x" },
      ),
    );
    const missingBoard = `/api/workspaces/${workspaceId}/boards/missing/comments`;
    expectParity([
      await kit.table("GET", missingBoard),
      await kit.legacy("GET", missingBoard),
      await kit.procedure("boards.comments", {
        workspaceId,
        boardId: "missing",
      }),
    ]);
    // `resolved` 不是布尔：原 handler 答域里的原话，旧路径与 procedure 由契约的
    // 入参校验先答（码与状态一样，原话是字段路径）。
    const [old, rest, rpc] = [
      await kit.table("POST", `${commentsPath()}/missing/resolve`, {
        resolved: "yes",
      }),
      await kit.legacy("POST", `${commentsPath()}/missing/resolve`, {
        resolved: "yes",
      }),
      await kit.procedure("boards.resolveComment", {
        workspaceId,
        boardId,
        commentId: "missing",
        resolved: "yes",
      }),
    ];
    for (const answer of [old, rest, rpc]) {
      expect(answer.status).toBe(400);
      expect((answer.body as { code: string }).code).toBe("bad_request");
    }
  });
});

describe("契约与路由表（评论）", () => {
  const entries = contractEntries().filter((entry) =>
    /^boards\.(comments|\w+Comment)$/.test(entry.name),
  );

  it("五条，scope 与路由表给旧路径的一致，旧路径都在路由表里", () => {
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      "boards.comments",
      "boards.createComment",
      "boards.deleteComment",
      "boards.resolveComment",
      "boards.updateComment",
    ]);
    for (const entry of entries) {
      const legacy = entry.meta.legacy!;
      expect(entry.meta.workspaceKey, entry.name).toBe("workspaceId");
      expect(
        routeScope(legacy.method, legacy.path)?.permission ?? null,
        entry.name,
      ).toBe(entry.meta.scope);
      expect(
        core.server.router.match(legacy.path)?.entry.methods,
        entry.name,
      ).toContain(legacy.method);
    }
  });
});
