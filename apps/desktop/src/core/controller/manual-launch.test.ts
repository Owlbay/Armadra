import { expect, it } from "vitest";
import { fixture } from "../workspaces/fixture";
import { createWorkspace } from "../workspaces/table";
import { listBoards } from "../canvas/boards";
import { saveBoard } from "../canvas/documents";
import { newNode } from "../collab/control/board";
import {
  install as installTerminals,
  type TerminalDomain,
} from "../terminal/install";

it("the browser terminal create route cannot start a manual controller node", async () => {
  let terminals: TerminalDomain | undefined;
  const core = fixture([
    (context) => {
      terminals = installTerminals(context, { configured: "direct" });
    },
  ]);
  try {
    const workspace = createWorkspace(core.database, {
      name: "manual",
      rootPath: core.directory,
    });
    const board = listBoards(core.database, workspace.id)[0]!;
    const node = newNode(
      board.id,
      "terminal",
      "Manual",
      { x: 0, y: 0 },
      { kind: "terminal", launchPolicy: "manual", agent: { id: "codex" } },
    );
    saveBoard(core.database, workspace.id, board.id, {
      expectedUpdatedAt: board.updatedAt,
      nodes: [node],
      edges: [],
      viewport: board.viewport,
    });
    const response = await core.call("POST", "/api/terminals", {
      workspaceId: workspace.id,
      nodeId: node.id,
      cwd: core.directory,
      agent: { id: "codex" },
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "manual_launch_required" });
    expect(
      core.database.prepare("SELECT count(*) n FROM terminal_sessions").get(),
    ).toMatchObject({ n: 0 });
  } finally {
    await terminals?.stop();
    core.close();
  }
});
