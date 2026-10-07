import { beforeEach, afterEach, expect, it } from "vitest";
import type { ControllerCommand } from "@armadra/shared";
import { fixture, type Fixture } from "../workspaces/fixture";
import { createWorkspace } from "../workspaces/table";
import { createBoard, listBoards, type Board } from "../canvas/boards";
import { loadBoard, saveBoard } from "../canvas/documents";
import { stickyNode } from "../canvas/nodes.fixture";
import { getContextLinks } from "../canvas/context-links";
import { CanvasPresence } from "../canvas/presence";
import { ControllerService } from "./service";

let core: Fixture;
let service: ControllerService;
let workspaceId: string;
let board: Board;
let token: string;
let presence: CanvasPresence;
const call = (
  method: ControllerCommand["method"],
  params = {},
  key?: string,
  credential = token,
) =>
  service.dispatch(
    {
      schemaVersion: 1,
      requestId: "test",
      instanceId: "instance",
      method,
      params,
      ...(key ? { idempotencyKey: key } : {}),
    },
    credential,
  ) as Promise<any>;
beforeEach(async () => {
  core = fixture([]);
  workspaceId = createWorkspace(core.database, {
    name: "test",
    rootPath: core.directory,
  }).id;
  board = listBoards(core.database, workspaceId)[0]!;
  presence = new CanvasPresence({ publish: () => {} });
  service = new ControllerService(core, "instance", {
    presence: () => presence,
  });
  token = (await call("connect", { workspaceId }, undefined, "")).credential;
});
afterEach(() => {
  presence.stop();
  core.close();
});
const graph = () => ({
  schemaVersion: 1,
  expectedUpdatedAt: board.updatedAt,
  operations: [
    {
      op: "createNode",
      key: "implement",
      type: "terminal",
      title: "Implement",
      data: { kind: "terminal", agent: { id: "codex" } },
    },
    {
      op: "createNode",
      key: "review",
      type: "terminal",
      title: "Review",
      data: { kind: "terminal", agent: { id: "claude" } },
    },
    {
      op: "createContextLink",
      source: { key: "implement" },
      target: { key: "review" },
      role: "peer",
    },
  ],
});

it("authorizes every non-bootstrap method and cannot forge a node or workspace identity", async () => {
  await expect(call("boards.list", {}, undefined, "")).rejects.toMatchObject({
    code: "authorization_required",
  });
  await expect(
    call("boards.list", { workspaceId: "foreign", owner: true }),
  ).rejects.toMatchObject({ code: "scope_denied" });
  expect((await call("boards.list")).boards).toHaveLength(1);
  await call("disconnect");
  await expect(call("board.get", { boardId: board.id })).rejects.toMatchObject({
    code: "authorization_revoked",
  });
});

it("applies incrementally, preserves user state and stores manual agents plus reciprocal context authorization", async () => {
  const user = stickyNode(board.id);
  board = saveBoard(core.database, workspaceId, board.id, {
    expectedUpdatedAt: board.updatedAt,
    nodes: [user],
    edges: [],
    viewport: { x: 12, y: 34, zoom: 2 },
    whiteboard: "user whiteboard",
  }).board;
  const result = await call(
    "graph.apply",
    { boardId: board.id, input: graph() },
    "one",
  );
  const document = loadBoard(core.database, workspaceId, board.id);
  expect(document.nodes).toHaveLength(3);
  expect(document.nodes.find((n) => n.id === user.id)).toEqual(user);
  expect(document.board.viewport).toEqual({ x: 12, y: 34, zoom: 2 });
  expect(document.board.whiteboard).toBe("user whiteboard");
  expect(
    document.nodes.find((n) => n.id === result.nodeIds.implement)?.data,
  ).toMatchObject({ launchPolicy: "manual" });
  expect(
    getContextLinks(core.database, result.nodeIds.implement).links[0]?.id,
  ).toBe(result.nodeIds.review);
  expect(
    core.database.prepare("SELECT count(*) n FROM terminal_sessions").get(),
  ).toMatchObject({ n: 0 });
  expect(
    core.database.prepare("SELECT actor_kind FROM controller_events").get(),
  ).toMatchObject({ actor_kind: "controller" });
});

it("reconciles identical retries before stale revisions, conflicts on different content and validates without writing", async () => {
  const input = graph();
  expect(
    await call("graph.validate", { boardId: board.id, input }),
  ).toMatchObject({ valid: true });
  expect(loadBoard(core.database, workspaceId, board.id).nodes).toHaveLength(0);
  const first = await call("graph.apply", { boardId: board.id, input }, "one");
  expect(
    await call("graph.apply", { input, boardId: board.id }, "one"),
  ).toEqual(first);
  expect(loadBoard(core.database, workspaceId, board.id).nodes).toHaveLength(2);
  await expect(
    call(
      "graph.apply",
      { boardId: board.id, input: { ...input, operations: [] } },
      "one",
    ),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  await expect(
    call("graph.apply", { boardId: board.id, input }, "new"),
  ).rejects.toMatchObject({ code: "revision_conflict" });
});

it("rolls back board, ownership, context documents, events and idempotency when a final write fails", async () => {
  core.database.exec(
    "CREATE TRIGGER fail_receipt BEFORE INSERT ON controller_commands BEGIN SELECT RAISE(ABORT, 'injected crash'); END",
  );
  await expect(
    call("graph.apply", { boardId: board.id, input: graph() }, "fail"),
  ).rejects.toThrow();
  expect(loadBoard(core.database, workspaceId, board.id).board.updatedAt).toBe(
    board.updatedAt,
  );
  for (const table of [
    "nodes",
    "context_links",
    "controller_objects",
    "controller_events",
    "controller_commands",
  ])
    expect(
      core.database.prepare(`SELECT count(*) n FROM ${table}`).get(),
    ).toMatchObject({ n: 0 });
});

it("rejects malicious batch entries atomically and respects edit leases", async () => {
  for (const bad of [
    { ...graph(), operations: [...graph().operations, graph().operations[0]] },
    {
      ...graph(),
      operations: [
        {
          op: "createNode",
          key: "bad",
          type: "terminal",
          title: "Bad",
          data: { kind: "terminal", sessionId: "forged" },
        },
      ],
    },
    {
      ...graph(),
      operations: [
        {
          op: "createNode",
          key: "bad",
          type: "editor",
          title: "Bad",
          data: { kind: "editor", path: "../outside" },
        },
      ],
    },
    {
      ...graph(),
      operations: [
        ...graph().operations,
        {
          op: "createContextLink",
          source: { key: "implement" },
          target: { key: "implement" },
          role: "peer",
        },
      ],
    },
  ]) {
    await expect(
      call("graph.apply", { boardId: board.id, input: bad }, "bad"),
    ).rejects.toThrow();
    expect(loadBoard(core.database, workspaceId, board.id).nodes).toHaveLength(
      0,
    );
  }
  presence.authorizeWrite(workspaceId, board.id, "another-client");
  await expect(
    call("graph.apply", { boardId: board.id, input: graph() }, "lease"),
  ).rejects.toMatchObject({ code: "lease_held" });
});

it("only edits profile-created nodes and never allows cross-board links", async () => {
  const made = await call(
    "graph.apply",
    { boardId: board.id, input: graph() },
    "made",
  );
  const second = (await call("connect", { workspaceId }, undefined, ""))
    .credential;
  const input = {
    schemaVersion: 1,
    expectedUpdatedAt: made.updatedAt,
    operations: [
      {
        op: "updateNode",
        node: { id: made.nodeIds.implement },
        changes: { title: "stolen" },
      },
    ],
  };
  await expect(
    call("graph.apply", { boardId: board.id, input }, "edit", second),
  ).rejects.toMatchObject({ code: "scope_denied" });
  const changed = await call(
    "graph.apply",
    { boardId: board.id, input },
    "edit",
  );
  expect(changed.updatedAt).not.toBe(made.updatedAt);
  input.expectedUpdatedAt = changed.updatedAt;
  input.operations = [
    {
      op: "updateNode",
      node: { id: made.nodeIds.review },
      changes: { title: "review" },
    },
  ];
  expect(
    (await call("graph.apply", { boardId: board.id, input }, "review"))
      .updatedAt,
  ).not.toBe(changed.updatedAt);
});

it("serializes concurrent retries and rejects stale competing writes with no partial graph", async () => {
  const input = graph();
  const [first, repeat] = await Promise.all([
    call("graph.apply", { boardId: board.id, input }, "race"),
    call("graph.apply", { boardId: board.id, input }, "race"),
  ]);
  expect(repeat).toEqual(first);
  await expect(
    call("graph.apply", { boardId: board.id, input }, "competitor"),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(loadBoard(core.database, workspaceId, board.id).nodes).toHaveLength(2);
  const another = createBoard(core.database, workspaceId, "another");
  await expect(
    call(
      "graph.apply",
      {
        boardId: another.id,
        input: {
          schemaVersion: 1,
          expectedUpdatedAt: another.updatedAt,
          operations: [
            {
              op: "createNode",
              key: "local",
              type: "sticky",
              title: "local",
              data: { kind: "sticky", content: "" },
            },
            {
              op: "createContextLink",
              source: { key: "local" },
              target: { id: first.nodeIds.implement },
            },
          ],
        },
      },
      "foreign-edge",
    ),
  ).rejects.toMatchObject({ code: "invalid_reference" });
  expect(loadBoard(core.database, workspaceId, another.id).nodes).toHaveLength(
    0,
  );
});

it("keeps notifications outside failed transactions and rejects lost capabilities", async () => {
  let notifications = 0;
  const unsubscribe = core.bus.on("workspace.event", () => {
    notifications++;
  });
  core.database.exec(
    "CREATE TRIGGER fail_receipt BEFORE INSERT ON controller_commands BEGIN SELECT RAISE(ABORT, 'failure'); END",
  );
  await expect(
    call("graph.apply", { boardId: board.id, input: graph() }, "fail"),
  ).rejects.toThrow();
  expect(notifications).toBe(0);
  expect(
    core.database.prepare("SELECT count(*) n FROM events").get(),
  ).toMatchObject({ n: 0 });
  core.database.exec("DROP TRIGGER fail_receipt");
  core.database
    .prepare("UPDATE controller_profiles SET capabilities_json = '[]'")
    .run();
  await expect(
    call("graph.validate", { boardId: board.id, input: graph() }),
  ).rejects.toMatchObject({ code: "scope_denied" });
  unsubscribe();
});

it("rejects a SQL graph mutation on a realtime board without ownership, receipt or outbox side effects", async () => {
  core.database
    .prepare("UPDATE boards SET realtime = 1 WHERE id = ?")
    .run(board.id);
  await expect(
    call("graph.apply", { boardId: board.id, input: graph() }, "realtime"),
  ).rejects.toMatchObject({ code: "realtime_active" });
  for (const table of [
    "nodes",
    "controller_objects",
    "controller_commands",
    "events",
  ])
    expect(
      core.database.prepare(`SELECT count(*) n FROM ${table}`).get(),
    ).toMatchObject({ n: 0 });
});
