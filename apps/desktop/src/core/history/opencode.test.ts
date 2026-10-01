import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrationsDir } from "../agent/fixture";
import { renderEntries } from "../collab/transcript";
import { digestEntries } from "../collab/transcript-summary";
import { listConversations, refresh } from "../conversations";
import { openDatabase } from "../db/open";
import {
  candidates,
  collectFrom,
  locate,
  opencodeAdapter,
  parse,
  probe,
  readEntries,
  roots,
  setWarningLog,
} from "./opencode";
import { locateHistory, readHistoryEntries } from "./registry";
import type { AbsorbContext } from "./types";

/**
 * H2：OpenCode 的只读 SQLite 适配器。库是测试自己建的最小 schema——只有适配器
 * 读到的那几列，加上探测要的 `tokens_input` 与 `cost`。
 */

let directory: string;
let dbPath: string;
let previousXdg: string | undefined;
let warnings: unknown[];
let previousLog: ReturnType<typeof setWarningLog>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "armadra-opencode-"));
  mkdirSync(join(directory, "opencode"), { recursive: true });
  dbPath = join(directory, "opencode", "opencode.db");
  previousXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = directory;
  warnings = [];
  previousLog = setWarningLog({
    warn: (message, fields) => warnings.push({ message, fields }),
  });
});

afterEach(() => {
  setWarningLog(previousLog);
  if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdg;
  rmSync(directory, { recursive: true, force: true });
});

function createDatabase(options: { withCost?: boolean } = {}): DatabaseSync {
  const database = new DatabaseSync(dbPath);
  database.exec("PRAGMA journal_mode = WAL");
  const usage =
    options.withCost === false
      ? ""
      : ", cost REAL NOT NULL DEFAULT 0, tokens_input INTEGER NOT NULL DEFAULT 0";
  database.exec(
    "CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, " +
      `title TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL${usage});` +
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, " +
      "time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);" +
      "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, " +
      "time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
  );
  return database;
}

function addSession(
  database: DatabaseSync,
  row: {
    id: string;
    title: string;
    directory: string;
    updated: number;
    parent?: string;
  },
): void {
  database
    .prepare(
      "INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      row.id,
      row.parent ?? null,
      row.directory,
      row.title,
      row.updated - 1000,
      row.updated,
    );
}

let counter = 0;
function addMessage(
  database: DatabaseSync,
  sessionId: string,
  at: number,
  data: Record<string, unknown>,
  parts: Record<string, unknown>[] = [],
): string {
  counter += 1;
  const id = `msg_${String(counter).padStart(4, "0")}`;
  database
    .prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    )
    .run(id, sessionId, at, at, JSON.stringify(data));
  parts.forEach((part, index) => {
    database
      .prepare(
        "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(`prt_${id}_${index}`, id, sessionId, at, at, JSON.stringify(part));
  });
  return id;
}

function assistant(
  model: string,
  tokens: {
    input: number;
    output: number;
    reasoning?: number;
    read?: number;
    write?: number;
  },
  completed = true,
): Record<string, unknown> {
  return {
    role: "assistant",
    modelID: model,
    providerID: "test",
    cost: 0.01,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning ?? 0,
      cache: { read: tokens.read ?? 0, write: tokens.write ?? 0 },
    },
    time: completed ? { created: 1, completed: 2 } : { created: 1 },
  };
}

/** 一个有三类分块的会话：用户文本、助手文本加一次跑完的工具调用。 */
function seedConversation(database: DatabaseSync): void {
  addSession(database, {
    id: "ses_root",
    title: "修好登录页",
    directory: "/work/app",
    updated: 5_000,
  });
  addMessage(database, "ses_root", 1_000, { role: "user" }, [
    { type: "text", text: "登录页白屏" },
    { type: "text", text: "<file>…</file>", synthetic: true },
  ]);
  addMessage(
    database,
    "ses_root",
    2_000,
    assistant("m-1", { input: 10, output: 5 }),
    [
      { type: "step-start" },
      { type: "reasoning", text: "想一想" },
      { type: "text", text: "我先看看入口" },
      {
        type: "tool",
        callID: "call_1",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "/work/app/src/login.tsx" },
          output: "export function Login() {}",
        },
      },
      { type: "step-finish" },
    ],
  );
}

const context = (nowMs = 10_000_000): AbsorbContext => ({
  nowMs,
  seen: new Set<number>(),
});

describe("库的探测与打开", () => {
  it("根目录在 XDG_DATA_HOME 或 ~/.local/share 下，不走配置目录规则", () => {
    expect(roots({ HOME: "/home/me" })).toEqual([
      join("/home/me", ".local", "share", "opencode", "opencode.db"),
    ]);
    expect(roots({ HOME: "/home/me", XDG_DATA_HOME: "/data" })).toEqual([
      join("/data", "opencode", "opencode.db"),
    ]);
    // 相对路径的 XDG_DATA_HOME 按规范无效。
    expect(roots({ HOME: "/home/me", XDG_DATA_HOME: "rel" })).toEqual([
      join("/home/me", ".local", "share", "opencode", "opencode.db"),
    ]);
    expect(roots({ HOME: "", USERPROFILE: "" }).length).toBeLessThanOrEqual(1);
  });

  it("库不存在时什么都没有，也不吵", () => {
    expect(probe(dbPath)).toEqual({ state: "not-found", reason: "missing" });
    expect(candidates(dbPath)).toEqual([]);
    expect(collectFrom(dbPath, 0, context())).toEqual([]);
    expect(
      readEntries({ key: "opencode:ses_root", origin: "" }, 0, 1 << 20),
    ).toEqual({ entries: [], startOffset: 0, endOffset: 0 });
    expect(warnings).toEqual([]);
  });

  it("缺 tokens_input / cost 列时整家跳过并给一次 warning", () => {
    const database = createDatabase({ withCost: false });
    seedConversation(database);
    database.close();
    expect(probe(dbPath)).toMatchObject({
      state: "not-found",
      reason: "incompatible",
    });
    expect(candidates(dbPath)).toEqual([]);
    expect(collectFrom(dbPath, 0, context())).toEqual([]);
    expect(
      readEntries({ key: "opencode:ses_root", origin: "" }, 0, 1 << 20).entries,
    ).toEqual([]);
    // 同一个库同一个原因只说一次。
    expect(warnings).toHaveLength(1);
  });

  it("只读句柄用完就关：之后另一个连接可以写，适配器读到新行", () => {
    const writer = createDatabase();
    seedConversation(writer);
    writer.close();
    expect(candidates(dbPath)).toHaveLength(1);
    expect(collectFrom(dbPath, 0, context())).toHaveLength(1);
    readEntries({ key: "opencode:ses_root", origin: "" }, 0, 1 << 20);

    // 独占写锁：要是适配器还握着一个读事务或句柄，这里会 SQLITE_BUSY。
    const again = new DatabaseSync(dbPath, { timeout: 0 });
    again.exec("BEGIN EXCLUSIVE");
    addSession(again, {
      id: "ses_new",
      title: "新会话",
      directory: "/work/app",
      updated: 9_000,
    });
    again.exec("COMMIT");
    again.close();
    expect(candidates(dbPath).map((c) => c.path)).toEqual([
      "opencode:ses_new",
      "opencode:ses_root",
    ]);
  });
});

describe("会话索引", () => {
  it("一个根会话一个候选：键、更新时间、标题与 cwd；子会话不进索引", () => {
    const database = createDatabase();
    seedConversation(database);
    addSession(database, {
      id: "ses_child",
      title: "子 Agent",
      directory: "/work/app",
      updated: 6_000,
      parent: "ses_root",
    });
    database.close();

    const found = candidates(dbPath);
    expect(found).toEqual([
      {
        path: "opencode:ses_root",
        updatedAt: new Date(5_000).toISOString(),
        bytes: 0,
      },
    ]);
    expect(parse(found[0]!)).toEqual({
      sessionId: "ses_root",
      title: "修好登录页",
      cwd: "/work/app",
    });
    expect(
      parse({ path: "/not/opencode", updatedAt: "", bytes: 0 }),
    ).toBeUndefined();
  });

  it("会话索引能列出 OpenCode 会话，第二趟不会因为根是文件而清掉它们", () => {
    const database = createDatabase();
    seedConversation(database);
    database.close();
    const opened = openDatabase({
      file: join(directory, "canvas.db"),
      migrationsDir: migrationsDir(),
    });
    try {
      const index = opened.database;
      const first = refresh(index, [["opencode", dbPath]]);
      expect(first).toMatchObject({ scanned: 1, indexed: 1, removed: 0 });
      const second = refresh(index, [["opencode", dbPath]]);
      expect(second).toMatchObject({ scanned: 1, indexed: 0, removed: 0 });
      expect(listConversations(index, undefined, 10)).toEqual([
        expect.objectContaining({
          provider: "opencode",
          sessionId: "ses_root",
          title: "修好登录页",
          cwd: "/work/app",
        }),
      ]);
      // 库没了：这一家的行全部清掉。
      rmSync(dbPath);
      expect(refresh(index, [["opencode", dbPath]])).toMatchObject({
        removed: 1,
        total: 0,
      });
    } finally {
      opened.close();
    }
  });
});

describe("定位与记录", () => {
  it("按 sessionId 定位成不透明键，没有 path", () => {
    expect(locate({ agentId: "opencode", sessionId: "ses_root" })).toEqual({
      key: "opencode:ses_root",
      origin: "OpenCode 会话 ses_root",
    });
    expect(locate({ agentId: "opencode" })).toBeUndefined();
    expect(
      locateHistory({ agentId: "opencode", sessionId: "ses_root" }),
    ).toEqual({ key: "opencode:ses_root", origin: "OpenCode 会话 ses_root" });
  });

  it("text、tool_use、tool_result 三类记录；其余分块与 synthetic 文本跳过", () => {
    const database = createDatabase();
    seedConversation(database);
    database.close();
    const range = readEntries(
      { key: "opencode:ses_root", origin: "" },
      0,
      1 << 20,
    );
    expect(range.startOffset).toBe(0);
    expect(range.endOffset).toBe(2_000);
    expect(range.entries).toEqual([
      {
        role: "user",
        blocks: [{ type: "text", text: "登录页白屏" }],
        endOffset: 1_000,
        at: new Date(1_000).toISOString(),
      },
      {
        role: "assistant",
        blocks: [
          { type: "text", text: "我先看看入口" },
          {
            type: "tool_use",
            name: "read",
            id: "call_1",
            input: {
              filePath: "/work/app/src/login.tsx",
              file_path: "/work/app/src/login.tsx",
            },
          },
          {
            type: "tool_result",
            id: "call_1",
            content: "export function Login() {}",
          },
        ],
        endOffset: 2_000,
        at: new Date(2_000).toISOString(),
      },
    ]);
  });

  it("游标是 time_created：从上次的 endOffset 续读只给新的消息", () => {
    const database = createDatabase();
    seedConversation(database);
    const located = { key: "opencode:ses_root", origin: "" };
    const first = readEntries(located, 0, 1 << 20);
    const cursor = first.startOffset + first.entries.at(-1)!.endOffset;

    expect(readEntries(located, cursor, 1 << 20)).toEqual({
      entries: [],
      startOffset: 0,
      endOffset: cursor,
    });

    addMessage(database, "ses_root", 3_000, { role: "user" }, [
      { type: "text", text: "还是白屏" },
    ]);
    database.close();
    const next = readEntries(located, cursor, 1 << 20);
    expect(next.entries.map((entry) => entry.endOffset)).toEqual([3_000]);
    expect(next.endOffset).toBe(3_000);
  });

  it("超出 maxBytes 时保留最新的消息，最新一条再大也给", () => {
    const database = createDatabase();
    seedConversation(database);
    addMessage(database, "ses_root", 3_000, { role: "user" }, [
      { type: "text", text: "x".repeat(500) },
    ]);
    database.close();
    const located = { key: "opencode:ses_root", origin: "" };
    expect(
      readEntries(located, 0, 100).entries.map((entry) => entry.endOffset),
    ).toEqual([3_000]);
  });

  it("经注册表读出来的记录可以渲染、可以摘要", () => {
    const database = createDatabase();
    seedConversation(database);
    database.close();
    const located = locateHistory({
      agentId: "opencode",
      sessionId: "ses_root",
    });
    expect(located).toBeDefined();
    const range = readHistoryEntries("opencode", located!, 0, 1 << 20);
    expect(renderEntries(range.entries).map((record) => record.line)).toEqual([
      "[用户] 登录页白屏",
      "[助手] 我先看看入口 [工具 read /work/app/src/login.tsx] [结果 export function Login() {}]",
    ]);
    expect(digestEntries(range.entries)).toMatchObject({
      lastUser: expect.stringContaining("登录页白屏"),
      lastAssistant: expect.stringContaining("我先看看入口"),
      files: ["/work/app/src/login.tsx"],
      toolCalls: 1,
      entries: 2,
    });
  });
});

describe("成本快照", () => {
  it("assistant 消息逐条成样本，sinceMs 之后才取；reasoning 计入输出", () => {
    const database = createDatabase();
    seedConversation(database);
    addSession(database, {
      id: "ses_child",
      title: "子 Agent",
      directory: "/work/app",
      updated: 6_000,
      parent: "ses_root",
    });
    addMessage(
      database,
      "ses_child",
      4_000,
      assistant("m-2", {
        input: 1,
        output: 2,
        reasoning: 3,
        read: 4,
        write: 5,
      }),
    );
    // 用量全是零的不出样本。
    addMessage(
      database,
      "ses_root",
      4_500,
      assistant("m-1", { input: 0, output: 0 }),
    );

    expect(collectFrom(dbPath, 0, context())).toEqual([
      {
        key: "opencode:ses_root",
        model: "m-1",
        timestamp: 2_000,
        tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
        reportedCost: 0.01,
      },
      {
        key: "opencode:ses_child",
        model: "m-2",
        timestamp: 4_000,
        tokens: { input: 1, output: 5, cacheRead: 4, cacheCreation: 5 },
        reportedCost: 0.01,
      },
    ]);
    expect(
      collectFrom(dbPath, 2_000, context()).map((sample) => sample.timestamp),
    ).toEqual([4_000]);

    addMessage(
      database,
      "ses_root",
      5_000,
      assistant("m-1", { input: 7, output: 1 }),
    );
    database.close();
    expect(
      collectFrom(dbPath, 4_000, context()).map((sample) => sample.timestamp),
    ).toEqual([5_000]);
  });

  it("没写完的 assistant 消息挡住它之后的，挂太久的不再等；一趟里不重复计", () => {
    const database = createDatabase();
    seedConversation(database);
    addMessage(
      database,
      "ses_root",
      3_000,
      assistant("m-1", { input: 1, output: 1 }, false),
    );
    addMessage(
      database,
      "ses_root",
      4_000,
      assistant("m-1", { input: 2, output: 2 }),
    );
    database.close();

    // 3_000 那条刚开始：只交出它之前的。
    expect(
      collectFrom(dbPath, 0, context(3_500)).map((sample) => sample.timestamp),
    ).toEqual([2_000]);
    // 一小时以后它还没写完，就按现在的用量算，后面的也放出来。
    expect(
      collectFrom(dbPath, 0, context(3_000 + 60 * 60_000)).map(
        (sample) => sample.timestamp,
      ),
    ).toEqual([2_000, 3_000, 4_000]);

    const shared = context();
    expect(collectFrom(dbPath, 0, shared)).toHaveLength(3);
    expect(collectFrom(dbPath, 0, shared)).toEqual([]);
  });

  it("适配器上挂的是快照式成本，读的是环境里的库", () => {
    const database = createDatabase();
    seedConversation(database);
    database.close();
    const cost = opencodeAdapter.cost;
    expect(cost?.kind).toBe("snapshot");
    if (cost?.kind !== "snapshot") return;
    expect(cost.collect(0, context())).toHaveLength(1);
  });
});
