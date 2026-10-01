import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderEntries } from "../collab/transcript";
import { digestEntries } from "../collab/transcript-summary";
import type { AgentId } from "../agent/registry";
import type { FileState } from "../usage/cost-buckets";
import type { AbsorbContext } from "./types";
import { ompAdapter, parseLines, piAdapter, piEntries } from "./pi";
import { historyAdapter, locateHistory, readHistoryEntries } from "./registry";

/** 夹具全是编的；形状照本机 Pi / OMP 的会话文件。 */
const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const CWD = "/work/demo";

const LINES = [
  {
    type: "session",
    version: 3,
    id: SESSION_ID,
    timestamp: "2026-10-01T08:00:00.000Z",
    cwd: CWD,
  },
  {
    type: "model_change",
    id: "a0000001",
    parentId: null,
    timestamp: "2026-10-01T08:00:00.100Z",
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
  },
  {
    type: "thinking_level_change",
    id: "a0000002",
    parentId: "a0000001",
    timestamp: "2026-10-01T08:00:00.200Z",
    thinkingLevel: "high",
  },
  {
    type: "message",
    id: "a0000003",
    parentId: "a0000002",
    timestamp: "2026-10-01T08:00:01.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "  把   README 的标题改成 Demo  " }],
      timestamp: 1_790_000_001_000,
    },
  },
  {
    type: "message",
    id: "a0000004",
    parentId: "a0000003",
    timestamp: "2026-10-01T08:00:02.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "内心独白", thinkingSignature: "x" },
        { type: "text", text: "先看一下文件。" },
        {
          type: "toolCall",
          id: "call_1",
          name: "read",
          arguments: { path: "/work/demo/README.md" },
        },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: {
        input: 100,
        output: 20,
        cacheRead: 300,
        cacheWrite: 40,
        totalTokens: 460,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      responseId: "resp_1",
      timestamp: 1_790_000_002_000,
    },
  },
  {
    type: "message",
    id: "a0000005",
    parentId: "a0000004",
    timestamp: "2026-10-01T08:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "# Old title\nbody" }],
      isError: false,
      timestamp: 1_790_000_003_000,
    },
  },
  {
    type: "message",
    id: "a0000006",
    parentId: "a0000005",
    timestamp: "2026-10-01T08:00:04.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "改好了。" }],
      model: "claude-sonnet-4-5",
      usage: {
        input: 5,
        output: 7,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 3,
        totalTokens: 12,
        cost: { total: 0 },
      },
      responseId: "resp_2",
      timestamp: 1_790_000_004_000,
    },
  },
];

const TEXT = `${LINES.map((line) => JSON.stringify(line)).join("\n")}\n`;

let directory: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_DIR",
  "OMP_PROFILE",
  "PI_PROFILE",
];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "armadra-pi-"));
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.PI_CODING_AGENT_DIR = directory;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(directory, { recursive: true, force: true });
});

/** 写一份会话文件到 `<agentDir>/sessions/<编码 cwd>/`。 */
function writeSession(
  name: string,
  text: string,
  folder = "--work-demo--",
): string {
  const dir = join(directory, "sessions", folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

function createFileState(agent: AgentId): FileState {
  return {
    agent,
    len: 0,
    mtimeMs: 0,
    offset: 0,
    modifiedMs: 0,
    model: undefined,
    buckets: new Map(),
    hourBuckets: new Map(),
  };
}

function context(): AbsorbContext {
  return { nowMs: Date.parse("2026-10-02T00:00:00Z"), seen: new Set() };
}

describe("根目录", () => {
  it("Pi 认 PI_CODING_AGENT_DIR，缺省 ~/.pi/agent", () => {
    const env = { HOME: "/home/me" };
    expect(piAdapter.roots(env)).toEqual([
      join("/home/me", ".pi", "agent", "sessions"),
    ]);
    expect(piAdapter.roots({ ...env, PI_CODING_AGENT_DIR: "/x" })).toEqual([
      join("/x", "sessions"),
    ]);
  });

  it("OMP 认 profile 与根名，且与 Pi 共用 PI_CODING_AGENT_DIR", () => {
    const env = { HOME: "/home/me" };
    expect(ompAdapter.roots(env)).toEqual([
      join("/home/me", ".omp", "agent", "sessions"),
    ]);
    expect(ompAdapter.roots({ ...env, PI_CODING_AGENT_DIR: "/x" })).toEqual([
      join("/x", "sessions"),
    ]);
    expect(ompAdapter.roots({ ...env, PI_CONFIG_DIR: ".alt" })).toEqual([
      join("/home/me", ".alt", "agent", "sessions"),
    ]);
    expect(
      ompAdapter.roots({
        ...env,
        OMP_PROFILE: "work",
        PI_CODING_AGENT_DIR: "/x",
      }),
    ).toEqual([
      join("/home/me", ".omp", "profiles", "work", "agent", "sessions"),
    ]);
    expect(ompAdapter.roots({ ...env, PI_PROFILE: "p2" })).toEqual([
      join("/home/me", ".omp", "profiles", "p2", "agent", "sessions"),
    ]);
  });

  it("注册表里有两家", () => {
    expect(historyAdapter("pi")).toBe(piAdapter);
    expect(historyAdapter("omp")).toBe(ompAdapter);
  });
});

describe("会话索引", () => {
  it("会话 id 与 cwd 取 session 记录，标题取第一条用户消息", () => {
    const path = writeSession(
      `2026-10-01T08-00-00-000Z_${SESSION_ID}.jsonl`,
      TEXT,
    );
    const listed = piAdapter.list(join(directory, "sessions"));
    expect(listed.map((candidate) => candidate.path)).toEqual([path]);
    expect(piAdapter.parse(listed[0]!)).toEqual({
      sessionId: SESSION_ID,
      title: "把 README 的标题改成 Demo",
      cwd: CWD,
    });
  });

  it("OMP 的 session 记录在标题行之后也认得", () => {
    const head = JSON.stringify({
      type: "title",
      v: 1,
      title: "x",
      updatedAt: 0,
      pad: "    ",
    });
    expect(parseLines("stem", [head, ...TEXT.split("\n")])).toMatchObject({
      sessionId: SESSION_ID,
      cwd: CWD,
    });
  });

  it("没有 session 记录时会话 id 取文件名尾部的 uuid", () => {
    expect(parseLines(`2026-10-01T08-00-00-000Z_${SESSION_ID}`, [])).toEqual({
      sessionId: SESSION_ID,
      title: "",
      cwd: "",
    });
  });

  it("更深一层的文件不进索引", () => {
    writeSession("deep.jsonl", TEXT, join("--work-demo--", "sub"));
    expect(piAdapter.list(join(directory, "sessions"))).toEqual([]);
  });
});

describe("定位", () => {
  it("按会话 id 匹配文件名", () => {
    const path = writeSession(
      `2026-10-01T08-00-00-000Z_${SESSION_ID}.jsonl`,
      TEXT,
    );
    writeSession(
      "2026-10-01T09-00-00-000Z_99999999-2222-4333-8444-555555555555.jsonl",
      TEXT,
    );
    expect(piAdapter.locate({ agentId: "pi", sessionId: SESSION_ID })).toEqual({
      key: path,
      path,
      origin: `Pi 会话记录 ${path}`,
    });
  });

  it("按 cwd 加启动时间兜底，取之后改过的文件里最新的一个", () => {
    const started = Date.parse("2026-10-01T08:00:00Z");
    const seconds = (ms: number) => ms / 1000;
    const old = writeSession(
      "2026-09-30T00-00-00-000Z_aaaaaaaa-2222-4333-8444-555555555555.jsonl",
      TEXT,
    );
    utimesSync(old, seconds(started - 60_000), seconds(started - 60_000));
    const newer = writeSession(
      "2026-10-01T08-00-00-000Z_bbbbbbbb-2222-4333-8444-555555555555.jsonl",
      TEXT,
    );
    utimesSync(newer, seconds(started + 120_000), seconds(started + 120_000));
    const earlier = writeSession(
      "2026-10-01T08-00-01-000Z_cccccccc-2222-4333-8444-555555555555.jsonl",
      TEXT,
    );
    utimesSync(earlier, seconds(started + 60_000), seconds(started + 60_000));
    const other = writeSession(
      "2026-10-01T08-00-02-000Z_dddddddd-2222-4333-8444-555555555555.jsonl",
      TEXT.replace(CWD, "/work/other"),
      "--work-other--",
    );
    utimesSync(other, seconds(started + 300_000), seconds(started + 300_000));

    expect(
      piAdapter.locate({ agentId: "pi", cwd: CWD, startedAtMs: started })?.path,
    ).toBe(newer);
    expect(
      piAdapter.locate({
        agentId: "pi",
        cwd: CWD,
        startedAtMs: started + 600_000,
      }),
    ).toBeUndefined();
    expect(piAdapter.locate({ agentId: "pi", cwd: CWD })).toBeUndefined();
  });

  it("CLI 报来的路径先认", () => {
    const path = writeSession("reported.jsonl", TEXT);
    expect(
      locateHistory({ agentId: "omp", transcriptPath: path, sessionId: "nope" })
        ?.path,
    ).toBe(path);
  });
});

describe("记录", () => {
  it("用户、助手与工具三类记录", () => {
    const entries = piEntries(TEXT);
    expect(entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(entries[0]).toMatchObject({
      blocks: [{ type: "text", text: "  把   README 的标题改成 Demo  " }],
      at: "2026-10-01T08:00:01.000Z",
    });
    expect(entries[1]!.blocks).toEqual([
      { type: "text", text: "先看一下文件。" },
      {
        type: "tool_use",
        name: "read",
        id: "call_1",
        input: { path: "/work/demo/README.md" },
      },
    ]);
    expect(entries[2]!.blocks).toEqual([
      {
        type: "tool_result",
        id: "call_1",
        content: [{ type: "text", text: "# Old title\nbody" }],
      },
    ]);
    expect(entries.at(-1)!.endOffset).toBe(Buffer.byteLength(TEXT));
  });

  it("经注册表读出来，渲染与摘要都不为空", () => {
    const path = writeSession(
      `2026-10-01T08-00-00-000Z_${SESSION_ID}.jsonl`,
      TEXT,
    );
    const located = locateHistory({ agentId: "pi", sessionId: SESSION_ID });
    expect(located?.path).toBe(path);
    const range = readHistoryEntries("pi", located!, 0, 1 << 20);
    expect(range.startOffset).toBe(0);
    expect(range.endOffset).toBe(Buffer.byteLength(TEXT));
    expect(renderEntries(range.entries).map((record) => record.line)).toEqual([
      "[用户] 把 README 的标题改成 Demo",
      "[助手] 先看一下文件。 [工具 read /work/demo/README.md]",
      "[结果 # Old title body]",
      "[助手] 改好了。",
    ]);
    const digest = digestEntries(range.entries);
    expect(digest).toMatchObject({
      lastUser: "把 README 的标题改成 Demo",
      lastAssistant: "改好了。",
      files: ["/work/demo/README.md"],
      toolCalls: 1,
      entries: 4,
    });

    // 增量：从上次的尾巴读，什么都没有。
    const again = readHistoryEntries("pi", located!, range.endOffset, 1 << 20);
    expect(again.entries).toEqual([]);
  });

  it("窗口截在半行里时丢掉那半行", () => {
    const path = writeSession("cut.jsonl", TEXT);
    const last = JSON.stringify(LINES.at(-1));
    const range = piAdapter.readEntries(
      { key: path, path, origin: "" },
      0,
      Buffer.byteLength(last) + 10,
    );
    expect(range.entries.map((entry) => entry.role)).toEqual(["assistant"]);
    expect(range.startOffset + range.entries[0]!.endOffset).toBe(
      Buffer.byteLength(TEXT),
    );
  });
});

describe("成本", () => {
  it("四个用量桶，按 responseId 去重", () => {
    const cost = piAdapter.cost;
    expect(cost?.kind).toBe("jsonl");
    if (cost?.kind !== "jsonl") return;
    const source = cost.source;
    expect(source.needles.map((needle) => needle.toString())).toEqual([
      '"usage"',
    ]);
    const state = createFileState("pi");
    const ctx = context();
    for (const line of [...LINES, LINES[4]]) source.absorb(state, line, ctx);
    const totals = [...state.buckets.values()].reduce(
      (sum, tokens) => ({
        input: sum.input + tokens.input,
        output: sum.output + tokens.output,
        cacheRead: sum.cacheRead + tokens.cacheRead,
        cacheCreation: sum.cacheCreation + tokens.cacheCreation,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    );
    expect(totals).toEqual({
      input: 105,
      output: 27,
      cacheRead: 300,
      cacheCreation: 40,
    });
    expect(
      [...state.buckets.keys()].every((key) =>
        key.includes("claude-sonnet-4-5"),
      ),
    ).toBe(true);
  });

  it("没有 responseId 的行按行 id 加时间去重", () => {
    const cost = ompAdapter.cost;
    if (cost?.kind !== "jsonl") throw new Error("expected jsonl");
    const line = {
      type: "message",
      id: "b0000001",
      timestamp: "2026-10-01T08:00:00.000Z",
      message: {
        role: "assistant",
        model: "m",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    };
    const state = createFileState("omp");
    const ctx = context();
    cost.source.absorb(state, line, ctx);
    cost.source.absorb(state, line, ctx);
    cost.source.absorb(
      state,
      { ...line, timestamp: "2026-10-01T09:00:00.000Z" },
      ctx,
    );
    const input = [...state.buckets.values()].reduce(
      (sum, tokens) => sum + tokens.input,
      0,
    );
    expect(input).toBe(2);
  });
});
