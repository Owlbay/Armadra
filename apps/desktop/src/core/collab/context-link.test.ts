import { mkdirSync, writeFileSync } from "node:fs";
import { createBoard } from "../canvas/boards";
import { createWorkspace } from "../workspaces/table";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { putContextLinks } from "../canvas/context-links";
import { rfc3339 } from "../workspaces/support";
import { createComment, setCommentResolved } from "../realtime/comments-store";
import {
  MAX_COMMENT_APPENDIX_BYTES,
  readableAs,
  runContextLink,
} from "./context-link";
import { Args, Refusal } from "./refusals";

/** Ported from the pre-merge implementation. */

let fixture: AgentFixture;
let me: string;

async function read(
  nodeId: string,
  verb: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  return runContextLink(
    fixture.collab,
    callerFor(fixture, nodeId),
    verb,
    new Args(args),
  );
}

async function refusalOf(
  nodeId: string,
  verb: string,
  args: Record<string, unknown> = {},
): Promise<Refusal> {
  try {
    await read(nodeId, verb, args);
  } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

function statusRow(nodeId: string, transcriptPath: string): void {
  fixture.database
    .prepare(
      "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, restored, updated_at, transcript_path) " +
        "VALUES (?, ?, 'claude', 'idle', 0, 1, 0, ?, ?)",
    )
    .run(nodeId, fixture.workspaceId, rfc3339(), transcriptPath);
}

beforeEach(() => {
  fixture = agentFixture();
  me = fixture.agentNode("Caller");
});

afterEach(() => {
  fixture.close();
});

describe("list", () => {
  it("says how to draw a link when there is none", async () => {
    const body = await read(me, "list");
    expect(body).toContain("还没有连接任何其他节点");
  });

  it("names every link, its kind and what it can be read as", async () => {
    const note = fixture.stickyNode("Note", "hello");
    fixture.link(me, note);
    const body = await read(me, "list");
    expect(body).toContain("已连接 1 个节点");
    expect(body).toContain("Note");
    expect(body).toContain(readableAs("sticky"));
    expect(body).toContain("armadra-hook context summary");
  });

  /**
   * `list` 是 Agent 唯一一处「我连着谁、各自叫什么」的答案（设计 §2.3）。没有
   * 它，一个被告知「把结果交给 reviewer」的模型只能猜哪个 id 是 reviewer。
   */
  it("carries each peer's name, and leaves the line alone when it has none", async () => {
    const peer = fixture.agentNode("Codex", "codex");
    fixture.link(me, peer);
    // 没起名的那些行一个字都不多：名字是给协作用的，一块只有一个 Agent 的
    // 画布不需要它。
    expect(await read(me, "list")).not.toContain("名字=");
    fixture.name(peer, "reviewer");
    expect(await read(me, "list")).toContain("名字=reviewer");
  });

  it("labels a whiteboard reference and reports its export state", async () => {
    putContextLinks(fixture.database, fixture.workspaceId, me, [
      {
        id: "018f0000-0000-7000-8000-000000000001",
        title: "Sketch",
        kind: "shape",
        content: { status: "pending" },
      },
    ]);
    const body = await read(me, "list");
    expect(body).toContain("类型=白板内容");
    expect(body).toContain("图片准备中");
  });
});

describe("reading a linked node", () => {
  it("refuses an unknown verb by name", async () => {
    const refused = await refusalOf(me, "explode");
    expect(refused.status).toBe(400);
    expect(refused.message).toContain("explode");
  });

  it("reads a sticky's body whatever verb is asked for", async () => {
    const note = fixture.stickyNode("Note", "the plan");
    fixture.link(me, note);
    for (const verb of ["summary", "transcript", "terminal"]) {
      expect(await read(me, verb, { node: "Note" })).toContain("the plan");
    }
    expect(await read(me, "summary", { node: "Note" })).toContain(
      "便签「Note」",
    );
  });

  it("says a sticky is empty rather than answering with nothing", async () => {
    const note = fixture.stickyNode("Note", "   ");
    fixture.link(me, note);
    expect(await read(me, "summary", { node: "Note" })).toContain("还是空的");
  });

  it("reads an editor node's file, resolved inside the workspace", async () => {
    writeFileSync(join(fixture.directory, "a.txt"), "file body\n");
    const editor = editorNode("Editor", "a.txt");
    fixture.link(me, editor);
    expect(await read(me, "summary", { node: "Editor" })).toContain(
      "file body",
    );
  });

  it("never lets a doctored path escape the workspace", async () => {
    const editor = editorNode("Escape", "../../etc/passwd");
    fixture.link(me, editor);
    const refused = await refusalOf(me, "summary", { node: "Escape" });
    expect(refused.status).toBe(404);
  });

  it("refuses a binary file instead of rendering mojibake", async () => {
    writeFileSync(join(fixture.directory, "b.bin"), Buffer.from([1, 0, 2, 0]));
    const editor = editorNode("Binary", "b.bin");
    fixture.link(me, editor);
    const refused = await refusalOf(me, "summary", { node: "Binary" });
    expect(refused.status).toBe(400);
    expect(refused.message).toContain("二进制");
  });

  it("lists a files node's directory", async () => {
    mkdirSync(join(fixture.directory, "sub"), { recursive: true });
    writeFileSync(join(fixture.directory, "sub", "one.txt"), "x");
    const files = node("files", "Files", { kind: "files", path: "sub" });
    fixture.link(me, files);
    const body = await read(me, "summary", { node: "Files" });
    expect(body).toContain("one.txt");
    expect(body).toContain("共 1 项");
  });

  it("gives a browser node's address, or says it has none", async () => {
    const browser = node("browser", "Web", {
      kind: "browser",
      url: "https://example.com",
    });
    fixture.link(me, browser);
    expect(await read(me, "summary", { node: "Web" })).toContain(
      "https://example.com",
    );
  });

  it("renders a linked agent's transcript, newest last", async () => {
    const peer = fixture.agentNode("Peer");
    fixture.link(me, peer);
    const path = join(fixture.directory, "transcript.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "user", message: { content: "do the thing" } }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "done" }] },
        }),
        "not json",
      ].join("\n"),
    );
    statusRow(peer, path);
    const body = await read(me, "transcript", { node: "Peer" });
    expect(body).toContain("[用户] do the thing");
    expect(body).toContain("[助手] done");
    expect(body).toContain("最近的 2 条");
    // 头部要说出这一次大概值多少 token（§13 第 2 条）。
    expect(body).toMatch(/本次约 \d+ KB ≈ \d+ token/);
    // `summary` 不再是「同一个读者带条数上限」，它是一份摘要：没有原文行。
    const summary = await read(me, "summary", { node: "Peer" });
    expect(summary).toContain("最后一条人类提示：do the thing");
    expect(summary).toContain("最后一条助手回复：done");
    expect(summary).not.toContain("[用户]");
  });

  it("says where the transcript would be rather than answering empty", async () => {
    const peer = fixture.agentNode("Peer");
    fixture.link(me, peer);
    const refused = await refusalOf(me, "transcript", { node: "Peer" });
    expect(refused.status).toBe(404);
    expect(refused.message).toContain("terminal");
  });

  it("reads a peer's terminal screen", async () => {
    const peer = fixture.agentNode("Peer");
    fixture.link(me, peer);
    fixture.session(peer, "claude");
    fixture.terminal.capture = "$ ls\nREADME.md\n";
    const body = await read(me, "terminal", { node: "Peer", n: 5 });
    expect(body).toContain("README.md");
    expect(body).toContain("终端最近 5 行");
  });

  it("refuses a link that points out of the workspace", async () => {
    // The link document is per node, not per workspace; one that outlived a
    // board move must not become a cross-workspace read.
    const peer = fixture.agentNode("Peer");
    fixture.link(me, peer);
    mkdirSync(join(fixture.directory, "elsewhere"), { recursive: true });
    const elsewhere = createWorkspace(fixture.database, {
      name: "elsewhere",
      rootPath: join(fixture.directory, "elsewhere"),
    });
    const board = createBoard(fixture.database, elsewhere.id, "Other");
    fixture.database
      .prepare("UPDATE nodes SET board_id = ? WHERE id = ?")
      .run(board.id, peer);
    const refused = await refusalOf(me, "summary", { node: "Peer" });
    expect(refused.status).toBe(403);
    expect(refused.message).toContain("不在当前工作空间");
  });

  it("refuses when a custom agent has context links switched off", async () => {
    const custom = fixture.agentNode("Custom", "custom:narrow");
    fixture.customAgents.push({
      id: "custom:narrow",
      label: "Narrow",
      color: "#ffffff",
      launchCmd: "wrapper",
      args: [],
      env: {},
      baseAgent: "claude",
      disabledCapabilities: ["contextLink"],
    });
    const refused = await refusalOf(custom, "list");
    expect(refused.status).toBe(403);
  });
});

function node(type: string, title: string, data: unknown): string {
  const id = crypto.randomUUID();
  const now = rfc3339();
  fixture.database
    .prepare(
      "INSERT INTO nodes (id, board_id, type, title, color, x, y, width, height, " +
        "labels_json, note, data_json, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, '#0a84ff', 0, 0, 240, 200, '[]', '', ?, ?, ?)",
    )
    .run(id, fixture.boardId, type, title, JSON.stringify(data), now, now);
  return id;
}

function editorNode(title: string, path: string): string {
  return node("editor", title, { kind: "editor", path });
}

describe("评论作为附加资料", () => {
  function bytesRead(target: string): number {
    const row = fixture.database
      .prepare(
        "SELECT COALESCE(SUM(bytes), 0) AS total FROM context_reads WHERE reader_node_id = ? AND target_node_id = ?",
      )
      .get(me, target) as { total: number | bigint };
    return Number(row.total);
  }

  it("读节点时附上未解决的评论，提及换成纯文本，字节记进预算", async () => {
    const note = fixture.stickyNode("Note", "hello");
    fixture.link(me, note);
    const before = await read(me, "summary", { node: "Note" });
    expect(before).not.toContain("上的评论");
    const plain = bytesRead(note);

    const open = createComment(fixture.database, {
      boardId: fixture.boardId,
      anchor: { kind: "node", id: note },
      body: "请 @[张三](principal:p1) 改成 world",
      authorPrincipalId: "",
    });
    createComment(fixture.database, {
      boardId: fixture.boardId,
      anchor: { kind: "node", id: note },
      body: "收到",
      authorPrincipalId: "",
      parentId: open.id,
    });
    const done = createComment(fixture.database, {
      boardId: fixture.boardId,
      anchor: { kind: "node", id: note },
      body: "旧的讨论",
      authorPrincipalId: "",
    });
    setCommentResolved(fixture.database, fixture.boardId, done.id, true);

    const body = await read(me, "summary", { node: "Note" });
    expect(body).toContain("节点「Note」上的评论");
    expect(body).toContain("请 @张三 改成 world");
    expect(body).toContain("↳ 画布主人：收到");
    expect(body).not.toContain("principal:");
    expect(body).not.toContain("旧的讨论");
    // 第二次读取记下的字节比第一次多出整段评论。
    const second = bytesRead(note) - plain;
    expect(second).toBe(Buffer.byteLength(body, "utf8"));
    expect(second).toBeGreaterThan(Buffer.byteLength(before, "utf8"));
  });

  it("评论再多也只附一段有上限的", async () => {
    const note = fixture.stickyNode("Long", "x");
    fixture.link(me, note);
    for (let index = 0; index < 20; index += 1) {
      createComment(fixture.database, {
        boardId: fixture.boardId,
        anchor: { kind: "node", id: note },
        body: "很长的评论".repeat(200),
        authorPrincipalId: "",
      });
    }
    const body = await read(me, "summary", { node: "Long" });
    expect(body).toContain("评论过长，已截断");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(
      MAX_COMMENT_APPENDIX_BYTES + 1024,
    );
  });

  it("readableAs 说明读得到的节点附带评论", () => {
    expect(readableAs("sticky")).toContain("评论");
    expect(readableAs("group")).not.toContain("评论");
    expect(readableAs("shape")).toContain("评论");
  });

  it("白板引用附上锚在那个对象上的未解决评论，字节记进预算", async () => {
    const item = "018f0000-0000-7000-8000-0000000000aa";
    const link = "018f0000-0000-7000-8000-0000000000bb";
    putContextLinks(fixture.database, fixture.workspaceId, me, [
      {
        id: link,
        title: "Sketch",
        kind: "shape",
        content: { sourceShapeId: `wb:${item}`, shapeType: "text", text: "画" },
      },
    ]);
    const plain = await read(me, "summary", { node: "Sketch" });
    expect(plain).not.toContain("上的评论");
    expect(bytesRead(link)).toBe(0);

    const open = createComment(fixture.database, {
      boardId: fixture.boardId,
      anchor: { kind: "item", id: item },
      body: "**箭头** 改成 @[张三](principal:p1) 说的颜色",
      authorPrincipalId: "",
    });
    createComment(fixture.database, {
      boardId: fixture.boardId,
      anchor: { kind: "item", id: item },
      body: "好",
      authorPrincipalId: "",
      parentId: open.id,
    });
    const done = createComment(fixture.database, {
      boardId: fixture.boardId,
      anchor: { kind: "item", id: item },
      body: "已经谈完",
      authorPrincipalId: "",
    });
    setCommentResolved(fixture.database, fixture.boardId, done.id, true);
    // 别的对象、别的板上的评论不跟着来。
    createComment(fixture.database, {
      boardId: fixture.boardId,
      anchor: { kind: "item", id: "018f0000-0000-7000-8000-0000000000cc" },
      body: "别处的",
      authorPrincipalId: "",
    });

    const body = await read(me, "summary", { node: "Sketch" });
    expect(body.startsWith(plain)).toBe(true);
    expect(body).toContain("白板内容「Sketch」上的评论");
    expect(body).toContain("改成 @张三 说的颜色");
    expect(body).toContain("↳ 画布主人：好");
    expect(body).not.toContain("已经谈完");
    expect(body).not.toContain("别处的");
    expect(bytesRead(link)).toBe(
      Buffer.byteLength(body.slice(plain.length), "utf8"),
    );
  });

  it("Frame 引用附上锚在分组节点上的评论", async () => {
    const frame = "018f0000-0000-7000-8000-0000000000dd";
    putContextLinks(fixture.database, fixture.workspaceId, me, [
      {
        id: "018f0000-0000-7000-8000-0000000000ee",
        title: "Frame A",
        kind: "shape",
        content: { sourceShapeId: frame, shapeType: "group", text: "成员" },
      },
    ]);
    createComment(fixture.database, {
      boardId: fixture.boardId,
      anchor: { kind: "node", id: frame },
      body: "整组再排一下",
      authorPrincipalId: "",
    });
    const body = await read(me, "summary", { node: "Frame A" });
    expect(body).toContain("白板内容「Frame A」上的评论");
    expect(body).toContain("整组再排一下");
  });
});
