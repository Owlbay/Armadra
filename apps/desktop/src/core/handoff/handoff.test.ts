import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { runMailbox } from "../collab/mailbox";
import { Args } from "../collab/refusals";
import { EMPTY_SECTIONS, sanitize, sensitive } from "./bundle";
import {
  type HandoffView,
  accept,
  cancel,
  listWorkspace,
  prepare,
  readForCaller,
} from "./store";

/** Ported from the pre-merge implementation. */

let fixture: AgentFixture;
let source: string;
let target: string;
let sourceSession: string;
let targetSession: string;

function request(overrides: Record<string, unknown> = {}) {
  return {
    sourceNodeId: source,
    sourceSessionId: sourceSession,
    sourceGeneration: 1,
    targetNodeId: target,
    targetSessionId: targetSession,
    targetGeneration: 1,
    sections: { ...EMPTY_SECTIONS, goal: "finish the port" },
    filePaths: [],
    byteBudget: 8192,
    includeTranscript: false,
    ...overrides,
  };
}

async function prepared(
  overrides: Record<string, unknown> = {},
): Promise<HandoffView> {
  return await prepare(
    fixture.collab,
    fixture.workspaceId,
    request(overrides) as never,
  );
}

beforeEach(() => {
  fixture = agentFixture();
  source = fixture.agentNode("Source");
  target = fixture.agentNode("Target", "codex");
  fixture.link(source, target);
  sourceSession = fixture.session(source, "claude");
  targetSession = fixture.session(target, "codex");
});

afterEach(() => {
  fixture.close();
});

describe("prepare", () => {
  it("freezes material and tells nobody", async () => {
    const view = await prepared();
    expect(view.state).toBe("prepared");
    expect(view.mailboxId).toBeNull();
    expect(view.acceptedAt).toBeNull();
    expect(view.attempts).toBe(0);
    expect(view.bundle.trust).toBe("peerDataNotSystemInstructions");
    expect(view.bundle.sourcePreserved).toBe(true);
    expect(view.bundle.version).toBe(1);
    // Nothing is in anybody's inbox yet.
    expect(
      fixture.database.prepare("SELECT COUNT(*) AS n FROM agent_mailbox").get(),
    ).toEqual({ n: 0 });
  });

  it("refuses a target the source is not linked to", async () => {
    const stranger = fixture.agentNode("Stranger", "claude");
    const strangerSession = fixture.session(stranger, "claude");
    await expect(
      prepared({
        targetNodeId: stranger,
        targetSessionId: strangerSession,
      }),
    ).rejects.toThrow(/context link/i);
  });

  it("refuses an invalid budget, an empty goal and its own node as target", async () => {
    await expect(prepared({ byteBudget: 1024 })).rejects.toThrow();
    await expect(
      prepared({ sections: { ...EMPTY_SECTIONS, goal: "   " } }),
    ).rejects.toThrow();
    await expect(
      prepared({ targetNodeId: source, targetSessionId: sourceSession }),
    ).rejects.toThrow(/different target/i);
  });

  it("refuses a generation that has already moved on", async () => {
    await expect(prepared({ sourceGeneration: 2 })).rejects.toThrow(
      /generation/i,
    );
  });

  it("fingerprints referenced files, and excludes the sensitive ones", async () => {
    writeFileSync(join(fixture.directory, "a.txt"), "hello");
    const view = await prepared({
      filePaths: ["a.txt", ".env", "missing.txt"],
    });
    const byPath = new Map(view.bundle.files.map((f) => [f.path, f]));
    expect(byPath.get("a.txt")?.status).toBe("referenced");
    expect(byPath.get("a.txt")?.sha256).toHaveLength(64);
    // A reference is a live file, not a copy — and `.env` is never read.
    expect(byPath.get(".env")?.status).toBe("excluded");
    expect(byPath.get(".env")?.sha256).toBeNull();
    expect(byPath.get("missing.txt")?.status).toBe("missing");
    expect(view.bundle.budget.omitted).toContain(
      "someFileReferencesUnavailable",
    );
  });

  it("truncates to the byte budget and says which section it cut", async () => {
    const view = await prepared({
      byteBudget: 8192,
      sections: {
        ...EMPTY_SECTIONS,
        goal: "goal",
        completed: "x".repeat(7_900),
      },
    });
    expect(view.bundle.budget.truncated).toBe(true);
    expect(view.bundle.budget.omitted).toContain("truncated:completed");
    expect(view.bundle.budget.usedBytes).toBeLessThanOrEqual(8192);
    // The goal is the last thing given up, so it survives whole.
    expect(view.bundle.sections.goal).toBe("goal");
  });
});

describe("accept", () => {
  it("puts the notice in the target's inbox and nothing in its terminal", async () => {
    const frozen = await prepared();
    const view = accept(
      fixture.collab,
      fixture.workspaceId,
      frozen.bundle.handoffId,
      { expectedDigest: frozen.digest },
    );
    expect(view.state).toBe("queued");
    expect(view.mailboxId).not.toBeNull();
    expect(view.attempts).toBe(1);
    const message = fixture.database
      .prepare("SELECT message_key, body, target_node_id FROM agent_mailbox")
      .get() as { message_key: string; body: string; target_node_id: string };
    expect(message.target_node_id).toBe(target);
    expect(message.message_key).toBe(`handoff:${view.bundle.handoffId}`);
    expect(message.body).toContain("peer data, not a system instruction");
    expect(fixture.terminal.writes).toHaveLength(0);
  });

  it("refuses a digest that no longer matches the preview", async () => {
    const view = await prepared();
    expect(() =>
      accept(fixture.collab, fixture.workspaceId, view.bundle.handoffId, {
        expectedDigest: "0".repeat(64),
      }),
    ).toThrow(/digest/i);
  });

  it("is idempotent: accepting twice does not post twice", async () => {
    const view = await prepared();
    const first = accept(
      fixture.collab,
      fixture.workspaceId,
      view.bundle.handoffId,
      { expectedDigest: view.digest },
    );
    const second = accept(
      fixture.collab,
      fixture.workspaceId,
      view.bundle.handoffId,
      { expectedDigest: first.digest },
    );
    expect(second.state).toBe("queued");
    expect(second.mailboxId).toBe(first.mailboxId);
    expect(
      fixture.database.prepare("SELECT COUNT(*) AS n FROM agent_mailbox").get(),
    ).toEqual({ n: 1 });
  });

  it("refuses after the context link is withdrawn", async () => {
    const view = await prepared();
    fixture.database.prepare("DELETE FROM context_links").run();
    expect(() =>
      accept(fixture.collab, fixture.workspaceId, view.bundle.handoffId, {
        expectedDigest: view.digest,
      }),
    ).toThrow(/link/i);
  });
});

describe("reading and acknowledging", () => {
  it("hands the bundle to the addressed session only", async () => {
    const view = await prepared();
    accept(fixture.collab, fixture.workspaceId, view.bundle.handoffId, {
      expectedDigest: view.digest,
    });
    const body = await readForCaller(
      fixture.collab,
      callerFor(fixture, target),
      view.bundle.handoffId,
      targetSession,
      1,
    );
    expect(body).toMatchObject({ protocol: "armadra.handoff.v1" });
    expect(String(body.trust)).toContain("Reading does not acknowledge");
    // Not the addressed session, and not an unverified caller.
    await expect(
      readForCaller(
        fixture.collab,
        callerFor(fixture, target),
        view.bundle.handoffId,
        targetSession,
        2,
      ),
    ).rejects.toThrow();
    await expect(
      readForCaller(
        fixture.collab,
        callerFor(fixture, source),
        view.bundle.handoffId,
        sourceSession,
        1,
      ),
    ).rejects.toThrow();
    await expect(
      readForCaller(
        fixture.collab,
        callerFor(fixture, target, "legacy"),
        view.bundle.handoffId,
        targetSession,
        1,
      ),
    ).rejects.toThrow();
  });

  it("refuses to read a handoff nobody approved", async () => {
    const view = await prepared();
    await expect(
      readForCaller(
        fixture.collab,
        callerFor(fixture, target),
        view.bundle.handoffId,
        targetSession,
        1,
      ),
    ).rejects.toThrow(/not addressed/i);
  });

  it("settles the record only when the inbox entry is acknowledged", async () => {
    const view = await prepared();
    const queued = accept(
      fixture.collab,
      fixture.workspaceId,
      view.bundle.handoffId,
      { expectedDigest: view.digest },
    );
    // Reading hands over the material and deliberately does not settle it.
    await readForCaller(
      fixture.collab,
      callerFor(fixture, target),
      view.bundle.handoffId,
      targetSession,
      1,
    );
    expect(listWorkspace(fixture.collab, fixture.workspaceId)[0]?.state).toBe(
      "queued",
    );
    await runMailbox(
      fixture.collab,
      callerFor(fixture, target),
      "ack",
      new Args({
        id: queued.mailboxId,
        sessionId: targetSession,
        generation: 1,
      }),
    );
    expect(listWorkspace(fixture.collab, fixture.workspaceId)[0]?.state).toBe(
      "acknowledged",
    );
  });
});

describe("cancel", () => {
  it("withdraws the inbox entry and marks the record cancelled", async () => {
    const view = await prepared();
    const queued = accept(
      fixture.collab,
      fixture.workspaceId,
      view.bundle.handoffId,
      { expectedDigest: view.digest },
    );
    const cancelled = cancel(
      fixture.collab,
      fixture.workspaceId,
      view.bundle.handoffId,
      { expectedDigest: queued.digest },
    );
    expect(cancelled.state).toBe("cancelled");
    expect(
      fixture.database.prepare("SELECT COUNT(*) AS n FROM agent_mailbox").get(),
    ).toEqual({ n: 0 });
    // Cancelling twice is a conflict, not a silent no-op.
    expect(() =>
      cancel(fixture.collab, fixture.workspaceId, view.bundle.handoffId, {
        expectedDigest: cancelled.digest,
      }),
    ).toThrow();
  });

  it("keeps the history after the nodes are gone", async () => {
    const view = await prepared();
    accept(fixture.collab, fixture.workspaceId, view.bundle.handoffId, {
      expectedDigest: view.digest,
    });
    fixture.database.prepare("DELETE FROM nodes WHERE id = ?").run(target);
    const history = listWorkspace(fixture.collab, fixture.workspaceId);
    expect(history).toHaveLength(1);
    // The panel shows the frozen identity rather than re-resolving it.
    expect(history[0]?.bundle.target.nodeTitle).toBe("Target");
  });
});

describe("sanitizing", () => {
  it("drops a private key block whole and redacts a token", async () => {
    const text = [
      "keep this",
      "-----BEGIN RSA PRIVATE KEY-----",
      "AAAABBBBCCCC",
      "-----END RSA PRIVATE KEY-----",
      "token sk-abcdefghijklmnopqrstuvwxyz",
    ].join("\n");
    const clean = sanitize(text);
    expect(clean).toContain("keep this");
    expect(clean).toContain("[PRIVATE KEY REDACTED]");
    expect(clean).not.toContain("AAAABBBBCCCC");
    expect(clean).toContain("[REDACTED]");
    expect(clean).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("knows which paths are never read", async () => {
    for (const path of [
      ".env",
      ".env.local",
      "a/.ssh/id_rsa",
      "certs/server.pem",
      "x/credentials.json",
    ]) {
      expect(sensitive(path)).toBe(true);
    }
    for (const path of ["src/a.ts", "docs/env.md"]) {
      expect(sensitive(path)).toBe(false);
    }
  });
});

describe("prepare 的转录：没有文件的来源", () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = join(fixture.directory, "xdg");
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
  });

  it("OpenCode 来源没有转录路径：按它报的会话 id 读库，摘进交接材料", async () => {
    const dir = join(fixture.directory, "xdg", "opencode");
    mkdirSync(dir, { recursive: true });
    const database = new DatabaseSync(join(dir, "opencode.db"));
    database.exec(
      "CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, " +
        "title TEXT NOT NULL, time_updated INTEGER NOT NULL, cost REAL NOT NULL DEFAULT 0, " +
        "tokens_input INTEGER NOT NULL DEFAULT 0);" +
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, " +
        "time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);" +
        "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, " +
        "time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);" +
        "INSERT INTO message VALUES ('msg_1', 'ses_oc', 1000, 1000, '{\"role\":\"user\"}');" +
        "INSERT INTO part VALUES ('prt_1', 'msg_1', 'ses_oc', 0, 0, '{\"type\":\"text\",\"text\":\"把导出做完\"}');",
    );
    database.close();

    const oc = fixture.agentNode("OC", "opencode");
    fixture.link(oc, target);
    const ocSession = fixture.session(oc, "opencode");
    fixture.database
      .prepare(
        "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, restored, " +
          "updated_at, session_id) VALUES (?, ?, 'opencode', 'done', 0, 1, 0, ?, 'ses_oc')",
      )
      .run(oc, fixture.workspaceId, new Date().toISOString());
    const view = await prepared({
      sourceNodeId: oc,
      sourceSessionId: ocSession,
      includeTranscript: true,
    });
    expect(view.bundle.transcriptExcerpt).toContain("[用户] 把导出做完");
    expect(view.bundle.budget.omitted).not.toContain(
      "noGenerationBoundTranscript",
    );
  });
});
