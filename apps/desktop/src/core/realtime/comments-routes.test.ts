import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkspaceEvent } from "../bus";
import { listBoards } from "../canvas/boards";
import { Authorizer, type AuthorizationSubject } from "../identity/authorize";
import {
  currentSubject,
  installAccessGate,
  resetAccessGate,
  runAs,
} from "../identity/gate";
import { IdentityStore } from "../identity/store";
import type { ShareRole } from "../identity/roles";
import { type Fixture, fixture } from "../workspaces/fixture";
import { createWorkspace } from "../workspaces/table";
import {
  installCommentRoutes,
  mentionTokens,
  plainCommentText,
} from "./comments-routes";

const OWNER = "a".repeat(32);
const EDITOR = "b".repeat(32);
const VIEWER = "c".repeat(32);
const OUTSIDER = "d".repeat(32);
const NOBODY = "e".repeat(32);

describe("评论路由（契约 §16.3）", () => {
  let fx: Fixture;
  let workspace: string;
  let base: string;
  let events: { workspaceId: string; event: WorkspaceEvent }[];

  function subject(principalId: string): AuthorizationSubject {
    return {
      principalId,
      kind: principalId === OWNER ? "owner" : "member",
      scopes: [],
    };
  }

  function as<T>(principalId: string, fn: () => Promise<T>): Promise<T> {
    return runAs({ subject: subject(principalId) }, fn);
  }

  beforeEach(() => {
    events = [];
    fx = fixture([
      (context) =>
        installCommentRoutes(context.server.router, {
          database: context.db.database,
          publish: (workspaceId, event) => events.push({ workspaceId, event }),
          now: () => 1_000,
        }),
    ]);
    workspace = createWorkspace(fx.database, {
      name: "w",
      rootPath: fx.directory,
    }).id;
    const board = listBoards(fx.database, workspace)[0];
    if (board === undefined) throw new Error("no default board");
    base = `/api/workspaces/${workspace}/boards/${board.id}/comments`;

    const store = new IdentityStore(fx.database);
    store.transaction((tx) => {
      const people: [string, "owner" | "member", string][] = [
        [OWNER, "owner", "Olivia"],
        [EDITOR, "member", "Eddie"],
        [VIEWER, "member", "Vera"],
        [OUTSIDER, "member", "Otto"],
      ];
      for (const [principalId, kind, displayName] of people) {
        tx.accounts.createPrincipal({
          principalId,
          kind,
          displayName,
          createdAtMs: 1,
          disabledAtMs: 0,
        });
      }
      const grants: [string, ShareRole][] = [
        [EDITOR, "editor"],
        [VIEWER, "viewer"],
      ];
      for (const [principalId, role] of grants) {
        tx.accounts.createGrant({
          grantId: `f${principalId.slice(1)}`,
          subjectKind: "principal",
          subjectId: principalId,
          workspaceId: workspace,
          role,
          grantedBy: OWNER,
          createdAtMs: 1,
          revokedAtMs: 0,
        });
      }
    });
    const authorizer = new Authorizer(store);
    installAccessGate({
      subject: currentSubject,
      permits: (who, required) => authorizer.permits(who, required),
    });
  });

  afterEach(() => {
    resetAccessGate();
    fx.close();
  });

  it("只读的人能看、不能写；外人连看都不行", async () => {
    const created = await as(EDITOR, () =>
      fx.call("POST", base, {
        anchor: { kind: "node", id: "n1" },
        body: "看这里",
      }),
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      authorPrincipalId: EDITOR,
      anchor: { kind: "node", id: "n1" },
      mentions: [],
    });

    const read = await as(VIEWER, () => fx.call("GET", base));
    expect(read.status).toBe(200);
    expect((read.body as { comments: unknown[] }).comments).toHaveLength(1);
    const write = await as(VIEWER, () =>
      fx.call("POST", base, {
        anchor: { kind: "point", x: 1, y: 2 },
        body: "x",
      }),
    );
    expect(write.status).toBe(403);
    expect(write.body).toMatchObject({ code: "forbidden" });

    expect((await as(OUTSIDER, () => fx.call("GET", base))).status).toBe(403);
  });

  it("改正文只有作者；删除是作者或 owner", async () => {
    const created = await as(EDITOR, () =>
      fx.call("POST", base, {
        anchor: { kind: "point", x: 1, y: 2 },
        body: "a",
      }),
    );
    const id = (created.body as { id: string }).id;

    const ownerEdit = await as(OWNER, () =>
      fx.call("PATCH", `${base}/${id}`, { body: "替他说" }),
    );
    expect(ownerEdit.status).toBe(403);
    const ownEdit = await as(EDITOR, () =>
      fx.call("PATCH", `${base}/${id}`, { body: "b" }),
    );
    expect(ownEdit.status).toBe(200);
    expect(ownEdit.body).toMatchObject({ body: "b" });

    // 别的编辑者删不了；owner 能删。
    const other = await as(OWNER, () =>
      fx.call("POST", base, {
        anchor: { kind: "point", x: 0, y: 0 },
        body: "c",
      }),
    );
    const otherId = (other.body as { id: string }).id;
    expect(
      (await as(EDITOR, () => fx.call("DELETE", `${base}/${otherId}`))).status,
    ).toBe(403);
    expect(
      (await as(OWNER, () => fx.call("DELETE", `${base}/${id}`))).status,
    ).toBe(204);
    expect(
      (await as(OWNER, () => fx.call("DELETE", `${base}/${otherId}`))).status,
    ).toBe(204);
    const left = await as(OWNER, () => fx.call("GET", base));
    expect((left.body as { comments: unknown[] }).comments).toEqual([]);
  });

  it("解决、回复随父锚点、按锚点与未解决过滤", async () => {
    const top = await as(EDITOR, () =>
      fx.call("POST", base, {
        anchor: { kind: "item", id: "wb:1" },
        body: "t",
      }),
    );
    const topId = (top.body as { id: string }).id;
    const reply = await as(OWNER, () =>
      fx.call("POST", base, { parentId: topId, body: "r" }),
    );
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({
      parentId: topId,
      anchor: { kind: "item", id: "wb:1" },
    });
    const resolved = await as(EDITOR, () =>
      fx.call("POST", `${base}/${topId}/resolve`, { resolved: true }),
    );
    expect(resolved.body).toMatchObject({ resolvedAtMs: 1_000 });

    const open = await as(EDITOR, () =>
      fx.call("GET", `${base}?resolved=false`),
    );
    expect((open.body as { comments: unknown[] }).comments).toEqual([]);
    const onItem = await as(EDITOR, () =>
      fx.call("GET", `${base}?anchorKind=item&anchorId=wb:1`),
    );
    expect((onItem.body as { comments: unknown[] }).comments).toHaveLength(2);
    expect(
      (await as(EDITOR, () => fx.call("GET", `${base}?anchorKind=point`)))
        .status,
    ).toBe(400);

    expect(
      events.map(({ event }) => event.type === "board.comment" && event.action),
    ).toEqual(["created", "created", "resolved"]);
  });

  it("@ 解析：只认能看这块板的人，事件不带正文、不叫作者自己", async () => {
    const body =
      `@[Vera](principal:${VIEWER}) @[Otto](principal:${OUTSIDER}) ` +
      `@[Eddie](principal:${EDITOR}) @[Ghost](principal:${NOBODY}) 看看`;
    const created = await as(EDITOR, () =>
      fx.call("POST", base, { anchor: { kind: "node", id: "n9" }, body }),
    );
    expect(created.body).toMatchObject({ mentions: [VIEWER, EDITOR] });
    const event = events.at(-1);
    expect(event?.workspaceId).toBe(workspace);
    expect(event?.event).toMatchObject({
      type: "board.comment",
      action: "created",
      comment: { anchorKind: "node", anchorId: "n9", parentId: null },
      mentions: [VIEWER],
    });
    expect(JSON.stringify(event)).not.toContain("看看");

    // 改正文只叫新加的人。
    const id = (created.body as { id: string }).id;
    await as(EDITOR, () =>
      fx.call("PATCH", `${base}/${id}`, {
        body: `${body} @[Olivia](principal:${OWNER})`,
      }),
    );
    expect(events.at(-1)?.event).toMatchObject({
      action: "updated",
      mentions: [OWNER],
    });

    const people = await as(VIEWER, () => fx.call("GET", base));
    expect(
      (people.body as { people: { principalId: string }[] }).people
        .map((person) => person.principalId)
        .sort(),
    ).toEqual([EDITOR, OWNER, VIEWER].sort());
  });

  it("提及的记号与给 Agent 看的纯文本", () => {
    expect(
      mentionTokens("@[A](principal:x) @[B](principal:y) @[A](principal:x)"),
    ).toEqual(["x", "y"]);
    expect(mentionTokens("@alice 没有记号")).toEqual([]);
    expect(plainCommentText("请 @[张三](principal:p1) 看一下")).toBe(
      "请 @张三 看一下",
    );
  });
});
