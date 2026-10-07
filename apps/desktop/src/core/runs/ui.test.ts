import { afterEach, expect, it } from "vitest";
import { fixture, type Fixture } from "../workspaces/fixture";
import { createWorkspace } from "../workspaces/table";
import { listBoards } from "../canvas/boards";
import { saveBoard } from "../canvas/documents";
import { newNode } from "../collab/control/board";
import { connect } from "../controller/store";
import { runAs } from "../identity/gate";
import { allScopes } from "../identity/scopes";
import { installRunUi } from "./ui";
let core: Fixture | undefined;
afterEach(() => core?.close());
it("an owner explicitly submits a manual task through core, without credentials or a forged profile from the body", async () => {
  core = fixture([]);
  const ws = createWorkspace(core.database, {
    name: "ui",
    rootPath: core.directory,
    permissions: { read: true, write: true, execute: true },
  });
  const board = listBoards(core.database, ws.id)[0]!;
  const profile = connect(core.database, ws.id);
  const node = newNode(
    board.id,
    "terminal",
    "manual",
    { x: 0, y: 0 },
    { kind: "terminal", launchPolicy: "manual", agent: { id: "codex" } },
  );
  const saved = saveBoard(core.database, ws.id, board.id, {
    expectedUpdatedAt: board.updatedAt,
    nodes: [node],
    edges: [],
    viewport: board.viewport,
  });
  core.database
    .prepare("INSERT INTO controller_objects VALUES(?,?,?)")
    .run(node.id, profile.controllerId, ws.id);
  const calls: any[] = [];
  installRunUi(core, {
    start: (...args: any[]) => {
      calls.push(args);
      return { runId: "run", state: "queued" };
    },
  } as any);
  const path = `/api/workspaces/${ws.id}/boards/${board.id}/nodes/${node.id}/run`;
  const body = {
    expectedUpdatedAt: saved.board.updatedAt,
    prompt: "Implement the approved change",
    key: "ui-request",
    controllerId: "forged",
    owner: true,
  };
  expect((await core.call("POST", path, body)).status).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toMatchObject({
    kind: "controller",
    controllerId: profile.controllerId,
    workspaceId: ws.id,
  });
  expect(calls[0][4]).toMatchObject({ kind: "human" });
  expect(JSON.stringify(calls)).not.toContain(profile.credential);
  const member = await runAs(
    { subject: { kind: "member", principalId: "member", scopes: allScopes() } },
    () => core!.call("POST", path, body),
  );
  expect(member.status).toBe(403);
  expect(calls).toHaveLength(1);
});
