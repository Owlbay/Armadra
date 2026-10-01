import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "../collab/transcript";
import { captureArgs, entriesAsJsonl, readTranscriptTail } from "./capture";

/**
 * 交接经本地历史注册表找转录：报来的路径之外，没有文件的来源（OpenCode 的库）
 * 也采集得到，交出去的仍是一段渲染得回来的文本。
 */

let directory: string;
let previous: string | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "armadra-handoff-capture-"));
  previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = directory;
});

afterEach(() => {
  if (previous === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previous;
  rmSync(directory, { recursive: true, force: true });
});

function seedOpenCode(root: string): void {
  mkdirSync(join(root, "opencode"), { recursive: true });
  const database = new DatabaseSync(join(root, "opencode", "opencode.db"));
  database.exec(
    "CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, " +
      "title TEXT NOT NULL, time_updated INTEGER NOT NULL, cost REAL NOT NULL DEFAULT 0, " +
      "tokens_input INTEGER NOT NULL DEFAULT 0);" +
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, " +
      "time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);" +
      "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, " +
      "time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
  );
  const message = database.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, 'ses_h', ?, ?, ?)",
  );
  const part = database.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, 'ses_h', 0, 0, ?)",
  );
  message.run("msg_1", 1_000, 1_000, JSON.stringify({ role: "user" }));
  part.run(
    "prt_1",
    "msg_1",
    JSON.stringify({ type: "text", text: "接着做导出" }),
  );
  message.run("msg_2", 2_000, 2_000, JSON.stringify({ role: "assistant" }));
  part.run(
    "prt_2",
    "msg_2",
    JSON.stringify({
      type: "tool",
      callID: "c1",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "/w/export.ts" },
        output: "ok",
      },
    }),
  );
  database.close();
}

describe("readTranscriptTail", () => {
  it("OpenCode：按会话 id 读库，文本渲染得回来", () => {
    seedOpenCode(directory);
    const tail = readTranscriptTail({
      provider: "opencode",
      sessionId: "ses_h",
    });
    expect(tail.state).toBe("read");
    if (tail.state !== "read") return;
    expect(render(tail.text)).toEqual([
      "[用户] 接着做导出",
      "[工具 read /w/export.ts] [结果 ok]",
    ]);
  });

  it("没有线索、会话不存在都是 missing", () => {
    seedOpenCode(directory);
    expect(readTranscriptTail({ provider: "opencode" })).toEqual({
      state: "missing",
    });
    expect(
      readTranscriptTail({ provider: "opencode", sessionId: "ses_none" }),
    ).toEqual({ state: "missing" });
  });

  it("归一化记录写回的 JSONL 与原来的块一致", () => {
    const text = entriesAsJsonl([
      {
        role: "assistant",
        blocks: [
          { type: "text", text: "a" },
          { type: "tool_use", name: "bash", id: "c", input: { command: "ls" } },
          { type: "tool_result", id: "c", content: "x" },
        ],
        endOffset: 0,
        at: "2026-10-02T00:00:00.000Z",
      },
    ]);
    expect(render(text)).toEqual(["[助手] a [工具 bash ls] [结果 x]"]);
  });
});

describe("captureArgs", () => {
  it("Worker 收到的转录线索逐项核对：路径之外还有会话 id、cwd 与启动时间", () => {
    expect(
      captureArgs({
        transcript: {
          provider: "opencode",
          sessionId: "ses_h",
          cwd: "/w",
          startedAtMs: 5,
          path: 3,
        },
      }).transcript,
    ).toEqual({
      provider: "opencode",
      sessionId: "ses_h",
      cwd: "/w",
      startedAtMs: 5,
    });
    expect(
      captureArgs({ transcript: { path: "/x" } }).transcript,
    ).toBeUndefined();
  });
});
