import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  locate,
  renderEntries,
  renderEntry,
  renderRecords,
} from "../collab/transcript";
import { digestEntries, digestTranscript } from "../collab/transcript-summary";
import { PROVIDERS, defaultRoots } from "../conversations";
import { COST_SOURCES } from "../usage/cost-sources";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { copilotAdapter } from "./copilot";
import { entriesFromJson } from "./entries";
import { readFileEntries } from "./files";
import expected from "./history.expected.json";
import { BRIEF, ENTRY_FIXTURES, TEXT_FIXTURES } from "./history.fixtures";
import { configRoot } from "./home";
import { opencodeAdapter } from "./opencode";
import { ompAdapter, piAdapter } from "./pi";
import {
  HISTORY_ADAPTERS,
  historyAdapter,
  locateHistory,
  readHistoryEntries,
} from "./registry";

/**
 * H0 的验收：Claude 与 Codex 搬进适配器以后，派生出来的表、定位与渲染 / 摘要
 * 都和拆分之前逐字一致。渲染与摘要的期望值（`history.expected.json`）是用拆分
 * 之前的 `renderRecords` / `renderEntry` / `digestTranscript` 对
 * `history.fixtures.ts` 跑出来固化的。
 */

type Expected = Record<
  string,
  { records: unknown[]; brief: unknown[]; digest: unknown }
>;
const EXPECTED = expected as unknown as Expected & { entries: unknown[] };

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "armadra-history-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("注册表", () => {
  it("派生出来的会话索引 provider 和成本来源与拆分之前相同（加上 OpenCode、Pi、OMP、Copilot）", () => {
    expect(PROVIDERS).toEqual([
      "claude",
      "codex",
      "opencode",
      "pi",
      "omp",
      "copilot",
    ]);
    expect(HISTORY_ADAPTERS.map((adapter) => adapter.agentId)).toEqual([
      "claude",
      "codex",
      "opencode",
      "pi",
      "omp",
      "copilot",
    ]);
    // 快照式来源不进逐行成本表。
    expect(Object.keys(COST_SOURCES)).toEqual([
      "claude",
      "codex",
      "pi",
      "omp",
      "copilot",
    ]);
    expect(historyAdapter("claude")).toBe(claudeAdapter);
    expect(historyAdapter("codex")).toBe(codexAdapter);
    expect(historyAdapter("opencode")).toBe(opencodeAdapter);
    expect(historyAdapter("copilot")).toBe(copilotAdapter);
    for (const agentId of ["custom:x"]) {
      expect(historyAdapter(agentId)).toBeUndefined();
    }
  });

  it("根目录按 configHomeWith 的规矩解析，覆盖优先", () => {
    const env = { HOME: "/home/me" };
    expect(claudeAdapter.roots(env)).toEqual([
      join("/home/me", ".claude", "projects"),
    ]);
    expect(codexAdapter.roots(env)).toEqual([
      join("/home/me", ".codex", "sessions"),
    ]);
    expect(
      claudeAdapter.roots({ ...env, CLAUDE_CONFIG_DIR: "/elsewhere" }),
    ).toEqual([join("/elsewhere", "projects")]);
    // An empty override is no override, as in every CLI.
    expect(codexAdapter.roots({ ...env, CODEX_HOME: "" })).toEqual([
      join("/home/me", ".codex", "sessions"),
    ]);
    expect(configRoot("custom:x", env)).toBeUndefined();
  });

  it("会话索引的缺省根目录来自各家适配器", () => {
    expect(defaultRoots()).toEqual([
      ...claudeAdapter.roots().map((root) => ["claude", root]),
      ...codexAdapter.roots().map((root) => ["codex", root]),
      ...opencodeAdapter.roots().map((root) => ["opencode", root]),
      ...piAdapter.roots().map((root) => ["pi", root]),
      ...ompAdapter.roots().map((root) => ["omp", root]),
      ...copilotAdapter.roots().map((root) => ["copilot", root]),
    ]);
  });
});

describe("定位", () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = directory;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  });

  it("CLI 报来的路径永远先认，不论是哪家", () => {
    const path = join(directory, "reported.jsonl");
    writeFileSync(path, "{}\n");
    for (const agentId of ["claude", "codex", "pi", "custom:x"]) {
      expect(locate(agentId, path, "sid")).toEqual({
        path,
        origin: `转录文件 ${path}`,
      });
    }
    expect(locateHistory({ agentId: "pi", transcriptPath: path })).toEqual({
      key: path,
      path,
      origin: `转录文件 ${path}`,
    });
  });

  it("Codex 按会话 id 在 sessions/ 下找，别家没有路径就找不到", () => {
    const sid = "01a06873-1111-2222-3333-2224a11ce547";
    const day = join(directory, "sessions", "2026", "09", "04");
    mkdirSync(day, { recursive: true });
    const rollout = join(day, `rollout-2026-09-04T02-06-15-${sid}.jsonl`);
    writeFileSync(rollout, "{}\n");
    expect(locate("codex", join(directory, "gone.jsonl"), sid)).toEqual({
      path: rollout,
      origin: `Codex 会话记录 ${rollout}`,
    });
    expect(locate("codex", undefined, "nope")).toBeUndefined();
    expect(locate("codex", undefined, "")).toBeUndefined();
    // Only codex searches by session id; the rest keep nothing findable.
    expect(locate("claude", undefined, sid)).toBeUndefined();
    expect(locate("pi", undefined, sid)).toBeUndefined();
  });
});

describe("归一化记录", () => {
  it("renderRecords 与拆分之前逐字一致（两档）", () => {
    for (const [name, text] of Object.entries(TEXT_FIXTURES)) {
      const want = EXPECTED[name];
      expect(want, name).toBeDefined();
      expect(renderRecords(text), name).toEqual(want?.records);
      expect(renderRecords(text, BRIEF), name).toEqual(want?.brief);
    }
  });

  it("entriesFromJson + renderEntries 与拆分之前逐字一致", () => {
    for (const [name, text] of Object.entries(TEXT_FIXTURES)) {
      const entries = entriesFromJson(text);
      expect(renderEntries(entries), name).toEqual(EXPECTED[name]?.records);
      expect(renderEntries(entries, BRIEF), name).toEqual(
        EXPECTED[name]?.brief,
      );
    }
  });

  it("renderEntry 对单条记录与拆分之前一致", () => {
    expect(ENTRY_FIXTURES.map((value) => renderEntry(value) ?? null)).toEqual(
      EXPECTED.entries,
    );
  });

  it("digestEntries 与拆分之前的 digestTranscript 一致", () => {
    for (const [name, text] of Object.entries(TEXT_FIXTURES)) {
      expect(digestTranscript(text), name).toEqual(EXPECTED[name]?.digest);
      expect(digestEntries(entriesFromJson(text)), name).toEqual(
        EXPECTED[name]?.digest,
      );
    }
  });

  it("记录带上时间戳；role 不是三种之一的记成 system 并做记号", () => {
    const [codexUser] = entriesFromJson(TEXT_FIXTURES.codex ?? "");
    expect(codexUser).toMatchObject({
      role: "user",
      at: "2026-09-20T09:00:01Z",
      blocks: [{ type: "text", text: "fix   the bug" }],
    });
    const [tool] = entriesFromJson(
      JSON.stringify({ role: "tool", content: "x" }),
    );
    expect(tool).toMatchObject({ role: "system", foreign: true });
  });
});

describe("按偏移读记录", () => {
  it("窗口截在半行里时丢掉那半行，偏移相对于起点", () => {
    const path = join(directory, "long.jsonl");
    const first = JSON.stringify({ type: "user", message: { content: "old" } });
    const second = JSON.stringify({
      type: "user",
      message: { content: "new" },
    });
    writeFileSync(path, `${first}\n${second}\n`);
    const total = Buffer.byteLength(`${first}\n${second}\n`);

    const tail = readFileEntries(path, 0, second.length + 5);
    expect(renderEntries(tail.entries).map((record) => record.line)).toEqual([
      "[用户] new",
    ]);
    expect(tail.startOffset).toBe(first.length + 1);
    expect(tail.startOffset + (tail.entries[0]?.endOffset ?? 0)).toBe(total);
    expect(tail.endOffset).toBe(total);

    const whole = readFileEntries(path, 0, 1024);
    expect(whole.startOffset).toBe(0);
    expect(whole.entries.map((entry) => entry.endOffset)).toEqual([
      first.length + 1,
      total,
    ]);

    // From a cursor on a line boundary nothing is dropped.
    const since = readFileEntries(path, first.length + 1, 1024);
    expect(since.startOffset).toBe(first.length + 1);
    expect(since.entries).toHaveLength(1);
  });

  it("没有适配器的 agent 按 JSONL 文件读 CLI 报来的路径", () => {
    const path = join(directory, "custom.jsonl");
    writeFileSync(path, `${JSON.stringify({ role: "user", content: "hi" })}\n`);
    const located = locateHistory({
      agentId: "custom:x",
      transcriptPath: path,
    });
    if (located === undefined) throw new Error("not located");
    const range = readHistoryEntries("custom:x", located, 0, 1024);
    expect(renderEntries(range.entries).map((record) => record.line)).toEqual([
      "[用户] hi",
    ]);
  });
});
