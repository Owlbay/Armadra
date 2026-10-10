import { afterEach, describe, expect, it } from "vitest";
import { putContextLinks } from "../canvas/context-links";
import { rfc3339, uuidV7 } from "../workspaces/support";
import { type HookFixture, hookFixture } from "./fixture";

/**
 * `GET /node/overlay` (contract §57.4, §58): the names and counts the Claude
 * Code mod's band draws. A verified node token for the node asked about, the
 * caller's own links only, `304` on an unchanged revision, and never a body.
 */

let open: HookFixture[] = [];

function fixture(): HookFixture {
  const made = hookFixture();
  open.push(made);
  return made;
}

afterEach(() => {
  for (const one of open) one.close();
  open = [];
});

async function overlay(
  it_: HookFixture,
  nodeId: string,
  headers: Record<string, string>,
): Promise<{
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}> {
  return (await it_.server.router.dispatch("GET", "/node/overlay", {
    method: "GET",
    path: "/node/overlay",
    query: new URLSearchParams({ nodeId }),
    headers,
    body: Buffer.alloc(0),
    raw: undefined as never,
    json: <T>(): T => null as T,
  })) as { status: number; body: unknown; headers?: Record<string, string> };
}

function addNode(
  it_: HookFixture,
  title: string,
  boardId = it_.boardId,
): string {
  const id = uuidV7();
  const now = rfc3339();
  it_.core.database
    .prepare(
      "INSERT INTO nodes (id, board_id, type, x, y, title, color, data_json, created_at, updated_at) " +
        "VALUES (?, ?, 'terminal', 0, 0, ?, '#0a84ff', '{}', ?, ?)",
    )
    .run(id, boardId, title, now, now);
  return id;
}

function name(it_: HookFixture, nodeId: string, handle: string): void {
  it_.core.database
    .prepare(
      "INSERT INTO node_handles (board_id, handle, node_id, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(it_.boardId, handle, nodeId, rfc3339());
}

function mail(it_: HookFixture, from: string, key: string, body: string): void {
  const now = Math.floor(Date.now() / 1000);
  it_.core.database
    .prepare(
      "INSERT INTO agent_mailbox (id, workspace_id, source_node_id, target_node_id, message_key, body, created_at, expires_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      uuidV7(),
      it_.workspaceId,
      from,
      it_.nodeId,
      key,
      body,
      now,
      now + 3600,
    );
}

function headersFor(it_: HookFixture): Record<string, string> {
  return {
    "x-armadra-hook-token": it_.bearer,
    "x-armadra-node-token": it_.service.issueNodeToken(it_.nodeId),
  };
}

describe("GET /node/overlay", () => {
  it("wants the bearer and a verified token for the node asked about", async () => {
    const it_ = fixture();
    const other = addNode(it_, "Other");
    expect((await overlay(it_, it_.nodeId, {})).status).toBe(403);
    expect(
      (
        await overlay(it_, it_.nodeId, {
          "x-armadra-hook-token": it_.bearer,
        })
      ).status,
    ).toBe(403);
    // A token for this node does not open another one.
    expect((await overlay(it_, other, headersFor(it_))).status).toBe(403);
    expect((await overlay(it_, "", headersFor(it_))).status).toBe(403);
  });

  it("answers an unlinked node with zeros, its title standing in for a name", async () => {
    const it_ = fixture();
    const answer = await overlay(it_, it_.nodeId, headersFor(it_));
    expect(answer.status).toBe(200);
    const board = it_.core.database
      .prepare("SELECT name FROM boards WHERE id = ?")
      .get(it_.boardId) as { name: string };
    expect(answer.body).toMatchObject({
      node: { id: it_.nodeId, name: "Claude", role: null, agentId: "claude" },
      board: { id: it_.boardId, title: board.name },
      links: { main: [], subs: [], peers: [] },
      inbox: { pending: 0, latestSequence: 0, latestFrom: "" },
      outbox: { queued: 0 },
      approvals: { pending: 0 },
    });
    expect(typeof (answer.body as { revision: number }).revision).toBe(
      "number",
    );
    expect(answer.headers?.["cache-control"]).toBe("no-store");
  });

  it("names the links by direction, counts the inbox and never carries a body", async () => {
    const it_ = fixture();
    const lead = addNode(it_, "Lead terminal");
    const worker = addNode(it_, "Worker");
    const peer = addNode(it_, "Peer");
    name(it_, lead, "lead");
    name(it_, it_.nodeId, "reviewer");
    // A node of another workspace in the document is not the canvas's link.
    const elsewhere = it_.core.database
      .prepare(
        "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, 'B', '/b', ?, ?) RETURNING id",
      )
      .get(uuidV7(), rfc3339(), rfc3339()) as { id: string } | undefined;
    let foreign: string | undefined;
    if (elsewhere !== undefined) {
      const board = uuidV7();
      it_.core.database
        .prepare(
          "INSERT INTO boards (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, 'B', ?, ?)",
        )
        .run(board, elsewhere.id, rfc3339(), rfc3339());
      foreign = addNode(it_, "Foreign", board);
    }
    const shape = uuidV7();
    putContextLinks(
      it_.core.database,
      it_.workspaceId,
      it_.nodeId,
      [
        { id: lead, title: "Lead terminal", kind: "terminal", role: "main" },
        { id: worker, title: "Worker", kind: "terminal", role: "sub" },
        { id: peer, title: "Peer", kind: "terminal" },
        { id: shape, title: "Sticky", kind: "shape" },
        ...(foreign === undefined
          ? []
          : [{ id: foreign, title: "Foreign", kind: "terminal" }]),
      ],
      false,
    );
    mail(it_, lead, "k1", "SECRET-BODY-ONE");
    mail(it_, peer, "k2", "SECRET-BODY-TWO");
    mail(it_, lead, "receipt:x", "a receipt is not a message");

    const answer = await overlay(it_, it_.nodeId, headersFor(it_));
    expect(answer.status).toBe(200);
    const body = answer.body as Record<string, unknown>;
    expect(body).toMatchObject({
      node: { name: "reviewer", role: "sub" },
      links: {
        main: [{ id: lead, name: "lead" }],
        subs: [{ id: worker, name: "Worker" }],
        peers: [{ id: peer, name: "Peer" }],
      },
      inbox: { pending: 2, latestFrom: "Peer" },
    });
    expect((body.inbox as { latestSequence: number }).latestSequence).toBe(
      Number(
        (
          it_.core.database
            .prepare(
              "SELECT MAX(sequence) AS s FROM agent_mailbox WHERE message_key = 'k2'",
            )
            .get() as { s: number }
        ).s,
      ),
    );
    const text = JSON.stringify(body);
    expect(text).not.toContain("SECRET-BODY");
    expect(text).not.toMatch(/"body"/);
    expect(text).not.toContain(shape);
    if (foreign !== undefined) expect(text).not.toContain(foreign);
  });

  it("answers 304 to the revision it last gave, and a new one once something moved", async () => {
    const it_ = fixture();
    const headers = headersFor(it_);
    const first = await overlay(it_, it_.nodeId, headers);
    const revision = (first.body as { revision: number }).revision;
    expect(first.headers?.etag).toBe(`"${revision}"`);
    const same = await overlay(it_, it_.nodeId, {
      ...headers,
      "if-none-match": `"${revision}"`,
    });
    expect(same.status).toBe(304);
    expect(same.body).toBeUndefined();
    const peer = addNode(it_, "Peer");
    mail(it_, peer, "k1", "hello");
    const moved = await overlay(it_, it_.nodeId, {
      ...headers,
      "if-none-match": `"${revision}"`,
    });
    expect(moved.status).toBe(200);
    expect((moved.body as { revision: number }).revision).not.toBe(revision);
  });

  it("answers 404 for a node that is not on a board", async () => {
    const it_ = fixture();
    const ghost = uuidV7();
    const headers = {
      "x-armadra-hook-token": it_.bearer,
      "x-armadra-node-token": it_.service.issueNodeToken(ghost),
    };
    expect((await overlay(it_, ghost, headers)).status).toBe(404);
  });
});
