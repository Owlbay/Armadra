import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderEntries } from "../collab/transcript";
import { digestEntries } from "../collab/transcript-summary";
import type { FileState } from "../usage/cost-buckets";
import {
  BUILT_IN_PRICES,
  ScanState,
  bucketKey,
  localDate,
  summarize,
} from "../usage/cost";
import { costSource } from "../usage/cost-sources";
import {
  candidates,
  copilotAdapter,
  parse,
  parseLines,
  workspaceCwd,
} from "./copilot";
import { historyAdapter, locateHistory, readHistoryEntries } from "./registry";

/**
 * H3：Copilot 的本地历史适配器。夹具是自编的事件流，形状照 CLI 的
 * `events.jsonl`：`{type, data, id, timestamp, parentId}`。
 */

const SID = "5f0c3a2e-1111-4222-8333-944455556666";

function event(
  type: string,
  data: Record<string, unknown>,
  timestamp: string,
): string {
  return JSON.stringify({
    type,
    data,
    id: `e-${type}`,
    timestamp,
    parentId: null,
  });
}

/** 八行：开场、Hook、用户、思考、助手（带工具调用）、两条累计用量、收尾。 */
function sessionLines(day: string): string[] {
  return [
    event(
      "session.start",
      {
        sessionId: SID,
        selectedModel: "some-model",
        startTime: `${day}T09:00:00Z`,
      },
      `${day}T09:00:00.000Z`,
    ),
    event(
      "hook.start",
      { hookType: "sessionStart", input: {} },
      `${day}T09:00:01.000Z`,
    ),
    event(
      "user.message",
      { content: "  修一下登录页的样式  ", transformedContent: "ignored" },
      `${day}T09:00:02.000Z`,
    ),
    event("thinking", { content: "自言自语" }, `${day}T09:00:03.000Z`),
    event(
      "assistant.message",
      {
        content: "先看看文件。",
        reasoningText: "不该出现",
        toolRequests: [
          {
            toolCallId: "call-1",
            name: "view",
            arguments: { path: "src/login.css" },
            type: "function",
          },
        ],
      },
      `${day}T09:00:04.000Z`,
    ),
    event(
      "session.usage_checkpoint",
      { totalPremiumRequests: 2, totalNanoAiu: 10 },
      `${day}T09:00:05.000Z`,
    ),
    event(
      "session.usage_checkpoint",
      { totalPremiumRequests: 5, totalNanoAiu: 30 },
      `${day}T10:00:00.000Z`,
    ),
    event(
      "hook.end",
      { hookType: "sessionEnd", success: true },
      `${day}T10:00:01.000Z`,
    ),
  ];
}

let directory: string;
let previous: string | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "armadra-copilot-"));
  previous = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = directory;
});

afterEach(() => {
  if (previous === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = previous;
  rmSync(directory, { recursive: true, force: true });
});

function writeSession(
  id: string,
  lines: readonly string[],
  workspace?: string,
): string {
  const folder = join(directory, "session-state", id);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "events.jsonl");
  writeFileSync(path, `${lines.join("\n")}\n`);
  if (workspace !== undefined) {
    writeFileSync(join(folder, "workspace.yaml"), workspace);
  }
  return path;
}

describe("Copilot 会话索引", () => {
  it("根目录认 COPILOT_HOME，缺省在家目录下", () => {
    expect(copilotAdapter.roots({ HOME: "/home/me" })).toEqual([
      join("/home/me", ".copilot", "session-state"),
    ]);
    expect(
      copilotAdapter.roots({ HOME: "/home/me", COPILOT_HOME: "/x" }),
    ).toEqual([join("/x", "session-state")]);
    expect(historyAdapter("copilot")).toBe(copilotAdapter);
  });

  it("只收深度 1 的 events.jsonl；id 取 session.start，标题取首条用户消息，cwd 读 workspace.yaml", () => {
    const path = writeSession(
      "dir-name",
      sessionLines("2026-09-20"),
      `id: dir-name\ncwd: "/work/app"\nname: x\n`,
    );
    // 更深处的 jsonl（检查点等）不是会话。
    const deep = join(directory, "session-state", "dir-name", "checkpoints");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "events.jsonl"), "{}\n");

    const root = copilotAdapter.roots()[0] as string;
    expect(candidates(root).map((candidate) => candidate.path)).toEqual([path]);
    expect(parse(path)).toEqual({
      sessionId: SID,
      title: "修一下登录页的样式",
      cwd: "/work/app",
    });
  });

  it("workspace.yaml 缺失时 cwd 为空；没有 session.start 时 id 取目录名", () => {
    const path = writeSession("only-dir", sessionLines("2026-09-20").slice(1));
    expect(parse(path)).toEqual({
      sessionId: "only-dir",
      title: "修一下登录页的样式",
      cwd: "",
    });
    expect(parseLines("d", [])).toEqual({ sessionId: "d", title: "", cwd: "" });
  });

  it("cwd 一行认单引号、双引号与裸值", () => {
    const file = join(directory, "workspace.yaml");
    writeFileSync(file, "id: a\ncwd: /plain/path\n");
    expect(workspaceCwd(file)).toBe("/plain/path");
    writeFileSync(file, "cwd: 'it''s'\n");
    expect(workspaceCwd(file)).toBe("it's");
    writeFileSync(file, "name: cwd: no\n");
    expect(workspaceCwd(file)).toBe("");
  });
});

describe("Copilot 记录", () => {
  it("按会话 id 定位，经注册表读出三类记录，Hook 与思考跳过", () => {
    const path = writeSession(SID, sessionLines("2026-09-20"));
    const located = locateHistory({ agentId: "copilot", sessionId: SID });
    expect(located).toEqual({
      key: path,
      path,
      origin: `Copilot 会话记录 ${path}`,
    });
    expect(locateHistory({ agentId: "copilot", sessionId: "../x" })).toBe(
      undefined,
    );
    expect(locateHistory({ agentId: "copilot", sessionId: "nope" })).toBe(
      undefined,
    );

    const range = readHistoryEntries(
      "copilot",
      located as NonNullable<typeof located>,
      0,
      1 << 20,
    );
    expect(range.entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(range.entries[1]?.blocks).toEqual([
      { type: "text", text: "先看看文件。" },
      {
        type: "tool_use",
        name: "view",
        id: "call-1",
        input: { path: "src/login.css" },
      },
    ]);
    expect(range.entries[0]?.at).toBe("2026-09-20T09:00:02.000Z");

    const lines = renderEntries(range.entries).map((record) => record.line);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("修一下登录页的样式");
    expect(lines[1]).toContain("先看看文件。");
    expect(lines.join("\n")).not.toContain("自言自语");
    expect(lines.join("\n")).not.toContain("不该出现");

    const digest = digestEntries(range.entries);
    expect(digest.entries).toBe(2);
    expect(digest.toolCalls).toBe(1);
    expect(digest.lastUser).toContain("修一下登录页的样式");
    expect(digest.lastAssistant).toContain("先看看文件。");

    // 偏移落在行界上时增量读只拿到后面的。
    const userEnd = range.startOffset + (range.entries[0]?.endOffset ?? 0);
    const since = readHistoryEntries(
      "copilot",
      located as NonNullable<typeof located>,
      userEnd,
      1 << 20,
    );
    expect(since.entries.map((entry) => entry.role)).toEqual(["assistant"]);
  });
});

describe("Copilot 成本", () => {
  const NOW = Date.parse("2026-09-20T12:00:00Z");

  function fileState(): FileState {
    return {
      agent: "copilot",
      len: 0,
      mtimeMs: 0,
      offset: 0,
      modifiedMs: 0,
      model: undefined,
      buckets: new Map(),
      hourBuckets: new Map(),
    };
  }

  it("累计值取末值，按增量记到各自的时间点，不逐行求和", () => {
    const source = costSource("copilot");
    expect(source?.unit).toBe("premiumRequests");
    expect(source?.needles.map(String)).toEqual(['"session.usage_checkpoint"']);
    const state = fileState();
    const context = { nowMs: NOW, seen: new Set<number>() };
    const stamps = [
      ["2026-09-18T10:00:00Z", 3],
      ["2026-09-19T10:00:00Z", 3],
      ["2026-09-20T09:00:00Z", 7],
      ["2026-09-20T11:00:00Z", 10],
    ] as const;
    for (const [timestamp, total] of stamps) {
      source?.absorb(
        state,
        {
          type: "session.usage_checkpoint",
          timestamp,
          data: { totalPremiumRequests: total },
        },
        context,
      );
    }
    expect(state.requests).toBe(10);
    expect(state.buckets.size).toBe(0);
    const day = (stamp: string) =>
      bucketKey(localDate(stamp, NOW), "copilot", "unknown");
    expect(state.requestBuckets?.get(day("2026-09-18T10:00:00Z"))).toBe(3);
    // 没有增长的那天什么都不记。
    expect(state.requestBuckets?.has(day("2026-09-19T10:00:00Z"))).toBe(false);
    expect(state.requestBuckets?.get(day("2026-09-20T11:00:00Z"))).toBe(7);
    const total = [...(state.requestBuckets?.values() ?? [])].reduce(
      (sum, value) => sum + value,
      0,
    );
    expect(total).toBe(10);
  });

  it("扫描出来的 Copilot 行是请求数，不进 token 合计", async () => {
    // 昨天（UTC）：落在 30 天窗口里，任何时区下都不会在未来。
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    writeSession(SID, sessionLines(day));
    const scan = await new ScanState().scan(
      copilotAdapter.roots().map((root) => ["copilot", root] as const),
    );
    expect(scan.buckets.size).toBe(0);
    const summary = summarize(scan, BUILT_IN_PRICES, Date.now());
    expect(summary.status).toBe("ok");
    const row = summary.ranges["30d"].byAgent.find(
      (one) => one.agent === "copilot",
    );
    expect(row).toMatchObject({
      unit: "premiumRequests",
      requests: 5,
      costUsd: 0,
      complete: true,
      source: "local",
    });
    expect(summary.ranges["30d"].totals.tokens.input).toBe(0);
    expect(summary.ranges["30d"].byModel).toEqual([]);
    expect(summary.unpricedModels).toEqual([]);
    expect(summary.ranges["30d"].sessions).toBe(1);
  });
});
