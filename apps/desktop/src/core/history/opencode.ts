import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type Candidate,
  type Parsed,
  MAX_FILES_PER_PROVIDER,
  title as clampTitle,
} from "../conversations/scan";
import { createLog, logLevel } from "../platform";
import { isEmptyTokens, type TokenTotals } from "../usage/cost-buckets";
import { asRecord, duplicate, number } from "./cost-lines";
import { isFile } from "./files";
import { homeDir } from "./home";
import type {
  AbsorbContext,
  Block,
  CostSample,
  EntryRange,
  HistoryAdapter,
  Located,
  SessionHint,
  TranscriptEntry,
} from "./types";

/**
 * OpenCode — 一个 SQLite 库：`${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db`。
 *
 * 和别家不一样，这里没有一个会话一个文件：`session` 表一行一个会话，`message`
 * 一行一条消息（`data` 是 JSON，assistant 那条带 `modelID` 与 `tokens`），
 * `part` 一行一个分块（文本、工具调用、思考、步骤边界……）。所以：
 *
 *   * 候选的 `path` 与定位结果的 `key` 都是不透明键 `opencode:<sessionId>`，
 *     没有 `path`（{@link Located}）。
 *   * 读取游标不是字节，而是 `(message.time_created, 同一毫秒里的序号)` 编成的
 *     一个整数（{@link encodeCursor}）：`startOffset` 恒为 0，每条记录的
 *     `endOffset` 就是那条消息的游标。
 *   * 成本是快照式（`kind: "snapshot"`）：每趟把某个时间之后的 assistant 消息
 *     一次交齐。
 *
 * 库的读法（设计 `cli-collaboration.md` §2.2）：每次用到时只读打开、`finally`
 * 里关掉，不长期持有连接——OpenCode 自己正开着它写。版本靠
 * `PRAGMA table_info(session)` 里有没有 `tokens_input` 和 `cost` 两列判断
 * （`user_version` 一直是 0，不能用）；列不齐、打不开（比如目录不可写、建不出
 * `-shm`）都按「这台机器上没有 OpenCode 的记录」处理并给一次 warning，绝不抛到
 * 启动或扫描路径上。旧版的 `storage/` 目录不读。
 */

/** 不透明键的前缀：`opencode:<sessionId>`。 */
export const KEY_PREFIX = "opencode:";

/** 要读的这几列都在，才认这个库。 */
const REQUIRED_SESSION_COLUMNS = ["tokens_input", "cost"] as const;

/**
 * 一条 assistant 消息开了头却一直没写完（OpenCode 被杀掉了）时，过这么久就不再
 * 等它：按它现在记着的用量算，别让它挡住后面所有消息的成本。
 */
const STALE_UNFINISHED_MS = 60 * 60_000;

/** `<XDG_DATA_HOME 或 ~/.local/share>/opencode/opencode.db`。 */
export function roots(env: NodeJS.ProcessEnv = process.env): string[] {
  const xdg = env.XDG_DATA_HOME;
  // XDG 规范：相对路径的 `XDG_DATA_HOME` 无效，当没设。
  if (xdg !== undefined && xdg !== "" && isAbsolute(xdg)) {
    return [join(xdg, "opencode", "opencode.db")];
  }
  const home = homeDir(env);
  return home === undefined
    ? []
    : [join(home, ".local", "share", "opencode", "opencode.db")];
}

/** 当前进程环境下的那个库；没有家目录时是 `undefined`。 */
function databasePath(): string | undefined {
  return roots()[0];
}

/* ---------------------------------- 打开 ---------------------------------- */

/** 这个库现在能不能读，以及不能读的原因。`not-found` 与设计 §2.2 的状态同名。 */
export type ProbeResult =
  | { readonly state: "ok" }
  | {
      readonly state: "not-found";
      readonly reason: "missing" | "incompatible" | "unreadable";
      readonly detail?: string;
    };

let log: { warn(message: string, fields?: Record<string, unknown>): void } =
  createLog(logLevel(process.env.ARMADRA_LOG));
const warned = new Set<string>();

/** 测试用：换掉 warning 的去处。返回之前那个。 */
export function setWarningLog(next: typeof log): typeof log {
  const previous = log;
  log = next;
  warned.clear();
  return previous;
}

/** 同一个库同一个原因只说一次：会话索引每分钟扫一趟，不该每分钟刷一行。 */
function warnOnce(path: string, reason: string, detail?: string): void {
  const key = `${path}\u0000${reason}`;
  if (warned.has(key)) return;
  warned.add(key);
  log.warn("OpenCode 的会话库读不了，这一家跳过", {
    path,
    reason,
    ...(detail === undefined ? {} : { detail }),
  });
}

/**
 * 只读打开、探测、交给 `use`，最后一定关掉。
 *
 * 库不存在、打不开、列不齐都返回 `undefined`（后两种给一次 warning）。`use`
 * 自己抛的错照常抛出——那是读的时候出的事，由调用方决定怎么说。
 */
function withDatabase<T>(
  path: string,
  use: (database: DatabaseSync) => T,
): T | undefined {
  const opened = openChecked(path);
  if (opened.database === undefined) return undefined;
  try {
    return use(opened.database);
  } finally {
    opened.database.close();
  }
}

function openChecked(path: string): {
  database?: DatabaseSync;
  probe: ProbeResult;
} {
  if (!isFile(path)) {
    return { probe: { state: "not-found", reason: "missing" } };
  }
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    // WAL 库只读打开以后，第一条语句才会去碰 `-shm`；目录不可写时在这里失败。
    const columns = database.prepare("PRAGMA table_info(session)").all() as {
      name: string;
    }[];
    const names = new Set(columns.map((column) => String(column.name)));
    const absent = REQUIRED_SESSION_COLUMNS.filter((name) => !names.has(name));
    if (absent.length > 0) {
      database.close();
      const detail = `session 表缺少列：${absent.join(", ")}`;
      warnOnce(path, "incompatible", detail);
      return { probe: { state: "not-found", reason: "incompatible", detail } };
    }
    return { database, probe: { state: "ok" } };
  } catch (error) {
    try {
      database?.close();
    } catch {
      // 已经坏了的句柄，关不关都一样。
    }
    const detail = error instanceof Error ? error.message : String(error);
    warnOnce(path, "unreadable", detail);
    return { probe: { state: "not-found", reason: "unreadable", detail } };
  }
}

/** 这个库能不能读（打开探测完立刻关掉）。给可用性检查与测试用。 */
export function probe(path: string): ProbeResult {
  const opened = openChecked(path);
  opened.database?.close();
  return opened.probe;
}

/* -------------------------------- 会话索引 -------------------------------- */

interface SessionRow {
  readonly id: string;
  readonly title: string;
  readonly directory: string;
  readonly time_updated: number;
}

/**
 * 上一趟 {@link candidates} 读出来的标题与 cwd，按候选的 `path` 存。索引紧接着
 * 就会对每个变了的候选调 `parse`，那一行刚才已经读过，没有必要再开一次库。
 */
let parsedCache = new Map<string, Parsed & { readonly updatedAt: string }>();

/**
 * OpenCode 还没来得及起标题时写的占位（`New session - <ISO 时间>`，子会话是
 * `Child session - …`）。它说不出会话是关于什么的，于是换成首条用户消息。
 */
const PLACEHOLDER_TITLE = /^(New|Child) session - \d{4}-\d{2}-\d{2}T/;

/**
 * 库里的会话，一个会话一个候选，最近更新的在前。子会话（`parent_id` 非空，
 * 子 Agent 开的）不进索引：没有人会去恢复它。
 */
export function candidates(root: string): Candidate[] {
  const found: Candidate[] = [];
  const parsed = new Map<string, Parsed & { readonly updatedAt: string }>();
  try {
    withDatabase(root, (database) => {
      const rows = database
        .prepare(
          "SELECT id, title, directory, time_updated FROM session " +
            "WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT ?",
        )
        .all(MAX_FILES_PER_PROVIDER) as unknown as SessionRow[];
      for (const row of rows) {
        const id = String(row.id ?? "");
        if (id === "") continue;
        const path = `${KEY_PREFIX}${id}`;
        const updatedAt = isoAt(row.time_updated);
        found.push({
          path,
          updatedAt,
          // 没有一个文件可以量；会话索引不读这个数。
          bytes: 0,
        });
        parsed.set(path, {
          sessionId: id,
          title: String(row.title ?? ""),
          cwd: String(row.directory ?? ""),
          updatedAt,
        });
      }
    });
  } catch (error) {
    // 语句本身失败（库在扫描途中被换掉之类）同样是「这一趟没有」。
    warnOnce(root, "unreadable", describe(error));
    return [];
  }
  parsedCache = parsed;
  return found;
}

/**
 * 一个候选 → 会话 id、标题与 cwd。
 *
 * 标题直接用 `session.title`；还是占位标题时退回首条用户消息。上一趟列表读过
 * 这一行、而且候选的更新时间对得上时不再开库（会话索引紧接着列表调它）；对不上
 * （比如节点改名建议传的是空的更新时间）就现读，标题可能刚被 OpenCode 起好。
 */
export function parse(candidate: Candidate): Parsed | undefined {
  const id = sessionIdOf(candidate.path);
  if (id === undefined) return undefined;
  const cached = parsedCache.get(candidate.path);
  if (
    cached !== undefined &&
    cached.updatedAt === candidate.updatedAt &&
    !PLACEHOLDER_TITLE.test(cached.title)
  ) {
    return { sessionId: id, title: clampTitle(cached.title), cwd: cached.cwd };
  }
  const path = databasePath();
  if (path === undefined) return undefined;
  try {
    return withDatabase(path, (database) => {
      const row = database
        .prepare("SELECT id, title, directory FROM session WHERE id = ?")
        .get(id) as unknown as Omit<SessionRow, "time_updated"> | undefined;
      if (row === undefined) return undefined;
      const stored = String(row.title ?? "");
      const title = PLACEHOLDER_TITLE.test(stored)
        ? (firstUserText(database, id) ?? "")
        : stored;
      return {
        sessionId: id,
        title: clampTitle(title),
        cwd: String(row.directory ?? ""),
      };
    });
  } catch {
    return undefined;
  }
}

/** 首条用户消息里第一段不是 OpenCode 自己塞进来的文本；最多看前 50 个分块。 */
function firstUserText(
  database: DatabaseSync,
  sessionId: string,
): string | undefined {
  const rows = database
    .prepare(
      "SELECT m.data AS message, p.data AS part FROM message m " +
        "JOIN part p ON p.message_id = m.id WHERE m.session_id = ? " +
        "ORDER BY m.time_created, m.id, p.id LIMIT 50",
    )
    .all(sessionId) as { message: string; part: string }[];
  for (const row of rows) {
    if (asRecord(parseJson(String(row.message)))?.role !== "user") continue;
    const part = asRecord(parseJson(String(row.part)));
    if (part?.type !== "text" || part.synthetic === true) continue;
    if (part.ignored === true) continue;
    const text = typeof part.text === "string" ? part.text.trim() : "";
    if (text !== "") return text;
  }
  return undefined;
}

/** `opencode:<id>` → `<id>`；不是这个前缀是 `undefined`。 */
export function sessionIdOf(key: string): string | undefined {
  if (!key.startsWith(KEY_PREFIX)) return undefined;
  const id = key.slice(KEY_PREFIX.length);
  return id === "" ? undefined : id;
}

/* ---------------------------------- 定位 ---------------------------------- */

/** OpenCode 的 Hook 带着 `sessionId`；它就是键，不需要去库里找。 */
export function locate(hint: SessionHint): Located | undefined {
  const id = hint.sessionId;
  if (id === undefined || id === "") return undefined;
  return { key: `${KEY_PREFIX}${id}`, origin: `OpenCode 会话 ${id}` };
}

/* ---------------------------------- 记录 ---------------------------------- */

interface JoinedRow {
  readonly id: string;
  readonly at: number;
  readonly rank: number;
  readonly message: string;
  readonly part: string | null;
}

/**
 * 同一毫秒里能区分的消息条数。游标是 `time_created × 1000 + 序号`：毫秒时间戳
 * 乘上一千仍远在 2^53 以内（到 2255 年），而一个会话在同一毫秒写下一千条消息不
 * 会发生——真到了，多出来的那些共用最后一个序号。
 */
const PER_MS = 1000;

/** `(time_created, 同一毫秒里按 id 排的序号)` → 读取游标。 */
export function encodeCursor(timeMs: number, rank: number): number {
  return timeMs * PER_MS + Math.min(Math.max(0, rank), PER_MS - 1);
}

/** {@link encodeCursor} 的逆；0（从头读）是「早于一切」。 */
export function decodeCursor(offset: number): {
  readonly timeMs: number;
  readonly rank: number;
} {
  if (!Number.isFinite(offset) || offset <= 0) return { timeMs: 0, rank: -1 };
  const whole = Math.trunc(offset);
  return { timeMs: Math.floor(whole / PER_MS), rank: whole % PER_MS };
}

/** 给读者看的游标：那条消息的时间，同一毫秒里不是第一条时再带上序号。 */
export function describeCursor(offset: number): string {
  const { timeMs, rank } = decodeCursor(offset);
  if (timeMs === 0) return "从头（OpenCode 消息游标）";
  const nth = rank > 0 ? ` 第 ${rank + 1} 条` : "";
  return `OpenCode 消息时间 ${isoAt(timeMs)}${nth}`;
}

/**
 * 读 `fromOffset`（{@link encodeCursor} 编的游标）之后的消息。同一毫秒的多条
 * 按 id 排序号，游标停在哪一条，下次就从它的下一条接着读：不漏也不重复。
 *
 * 一条消息一条记录，它的分块按 `part.id` 的顺序变成块：`text` → 文本，`tool`
 * → 工具调用，跑完了的再跟一个工具结果（取 `state.output`，失败取
 * `state.error`）；思考、步骤边界、补丁等跳过。OpenCode 自己塞进来的文本
 * （`synthetic` / `ignored`，比如附带的文件内容）不是谁说的话，也跳过。
 *
 * `maxBytes` 按分块 JSON 的字节数算，超出时保留最新的那些消息；最新的一条哪怕
 * 一条就超了也给，否则一个以大段工具输出结尾的会话什么都读不出来。库不存在、
 * 不认得时是空的；读的时候出错照常抛出。
 */
export function readEntries(
  located: Located,
  fromOffset: number,
  maxBytes: number,
): EntryRange {
  const from =
    Number.isFinite(fromOffset) && fromOffset > 0 ? Math.trunc(fromOffset) : 0;
  const empty: EntryRange = { entries: [], startOffset: 0, endOffset: from };
  const id = sessionIdOf(located.key);
  const path = databasePath();
  if (id === undefined || path === undefined) return empty;
  return (
    withDatabase(path, (database) => readFrom(database, id, from, maxBytes)) ??
    empty
  );
}

/** {@link readEntries} 的库内一半，测试直接喂一个打开的库。 */
export function readFrom(
  database: DatabaseSync,
  sessionId: string,
  from: number,
  maxBytes: number,
): EntryRange {
  const cursor = decodeCursor(from);
  // 序号在 `time_created >= 游标时间` 这一片里按毫秒分组算：游标那一毫秒的消息
  // 全在片里，所以同一条消息两次算出的序号相同。
  const rows = database
    .prepare(
      "WITH ranked AS (SELECT id, time_created, data, " +
        "ROW_NUMBER() OVER (PARTITION BY time_created ORDER BY id) - 1 AS rank " +
        "FROM message WHERE session_id = ? AND time_created >= ?) " +
        "SELECT r.id AS id, r.time_created AS at, r.rank AS rank, " +
        "r.data AS message, p.data AS part " +
        "FROM ranked r LEFT JOIN part p ON p.message_id = r.id " +
        "WHERE r.time_created > ? OR r.rank > ? " +
        "ORDER BY r.time_created DESC, r.id DESC, p.id ASC",
    )
    .iterate(
      sessionId,
      cursor.timeMs,
      cursor.timeMs,
      cursor.rank,
    ) as IterableIterator<JoinedRow>;

  // 从新往旧读，攒够预算就停：被丢掉的总是旧的那头。
  const newestFirst: TranscriptEntry[] = [];
  let newest = from;
  let used = 0;
  let current:
    | {
        id: string;
        at: number;
        message: string;
        parts: string[];
        bytes: number;
      }
    | undefined;
  const flush = (): boolean => {
    if (current === undefined) return true;
    const done = current;
    current = undefined;
    if (newestFirst.length > 0 && used + done.bytes > maxBytes) return false;
    used += done.bytes;
    newest = Math.max(newest, done.at);
    const entry = entryOf(done.message, done.parts, done.at);
    if (entry !== undefined) newestFirst.push(entry);
    return true;
  };
  for (const row of rows) {
    const rowId = String(row.id);
    if (current === undefined || current.id !== rowId) {
      if (!flush()) break;
      current = {
        id: rowId,
        at: encodeCursor(Number(row.at), Number(row.rank)),
        message: String(row.message ?? ""),
        parts: [],
        bytes: 0,
      };
    }
    if (typeof row.part === "string") {
      current.parts.push(row.part);
      current.bytes += Buffer.byteLength(row.part, "utf8");
    }
  }
  flush();
  return {
    entries: newestFirst.reverse(),
    startOffset: 0,
    endOffset: newest,
  };
}

function entryOf(
  messageJson: string,
  partsJson: readonly string[],
  at: number,
): TranscriptEntry | undefined {
  const message = asRecord(parseJson(messageJson));
  const role = message?.role;
  if (role !== "user" && role !== "assistant") return undefined;
  const blocks: Block[] = [];
  for (const raw of partsJson) {
    const part = asRecord(parseJson(raw));
    if (part !== undefined) blocks.push(...blocksOfPart(part));
  }
  if (blocks.length === 0) return undefined;
  return {
    role,
    blocks,
    endOffset: at,
    at: isoAt(decodeCursor(at).timeMs),
  };
}

function blocksOfPart(part: Record<string, unknown>): Block[] {
  switch (part.type) {
    case "text": {
      if (part.synthetic === true || part.ignored === true) return [];
      return typeof part.text === "string" && part.text !== ""
        ? [{ type: "text", text: part.text }]
        : [];
    }
    case "tool": {
      const name = typeof part.tool === "string" ? part.tool : "未命名工具";
      const id =
        typeof part.callID === "string" && part.callID !== ""
          ? part.callID
          : undefined;
      const state = asRecord(part.state);
      const input = toolInput(state?.input);
      const blocks: Block[] = [
        {
          type: "tool_use",
          name,
          ...(id === undefined ? {} : { id }),
          ...(input === undefined ? {} : { input }),
        },
      ];
      const content =
        state?.status === "completed"
          ? state.output
          : state?.status === "error"
            ? state.error
            : undefined;
      if (content !== undefined && content !== null) {
        blocks.push({
          type: "tool_result",
          ...(id === undefined ? {} : { id }),
          content,
        });
      }
      return blocks;
    }
    default:
      return [];
  }
}

/**
 * OpenCode 的工具参数用 `filePath`；渲染与摘要认的是 `file_path` / `path`。补一个
 * `file_path` 进副本，让「碰过的文件」与工具行的那一格在 OpenCode 上也有东西。
 */
function toolInput(input: unknown): unknown {
  const record = asRecord(input);
  if (record === undefined) return input;
  if (typeof record.filePath === "string" && record.file_path === undefined) {
    return { ...record, file_path: record.filePath };
  }
  return record;
}

/* ---------------------------------- 成本 ---------------------------------- */

interface MessageRow {
  readonly id: string;
  readonly session_id: string;
  readonly time_created: number;
  readonly data: string;
}

/**
 * `sinceMs` 当时及之后（按 `message.time_created`，**含**等于）写完了的
 * assistant 消息的用量。
 *
 * 含等于是为了同一毫秒的多条：游标停在某一毫秒时，那一毫秒里还没交出的消息
 * 下一趟仍然读得到；已经交出的那些靠 `ctx.seen` 按消息 id 去重——所以调用方
 * 必须在各趟扫描之间留着同一个 `seen`（`ScanState` 正是这样）。
 *
 * 一条 assistant 消息是先插入、跑完才把 `tokens` 写满的。遇到第一条还没写完的
 * 就停：它之后的留给下一趟，这样调用方把游标推到「交出来的最后一条的时间」不会
 * 越过它。挂了一小时还没写完的不再等（{@link STALE_UNFINISHED_MS}）。
 *
 * `reasoning` 按输出计（OpenCode 把它单列，计费按输出价）。子会话的消息照样
 * 计：钱是真花了的。
 */
export function collectFrom(
  path: string,
  sinceMs: number,
  ctx: AbsorbContext,
): CostSample[] {
  try {
    return (
      withDatabase(path, (database) => samplesFrom(database, sinceMs, ctx)) ??
      []
    );
  } catch (error) {
    warnOnce(path, "unreadable", describe(error));
    return [];
  }
}

export function samplesFrom(
  database: DatabaseSync,
  sinceMs: number,
  ctx: AbsorbContext,
): CostSample[] {
  const since = Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs : 0;
  const rows = database
    .prepare(
      "SELECT id, session_id, time_created, data FROM message " +
        "WHERE time_created >= ? ORDER BY time_created, id",
    )
    .iterate(since) as IterableIterator<MessageRow>;
  const samples: CostSample[] = [];
  for (const row of rows) {
    const data = asRecord(parseJson(String(row.data ?? "")));
    if (data?.role !== "assistant") continue;
    const created = Number(row.time_created);
    const time = asRecord(data.time);
    const finished = time?.completed !== undefined || data.error !== undefined;
    if (!finished && ctx.nowMs - created < STALE_UNFINISHED_MS) break;
    if (duplicate(ctx, `${KEY_PREFIX}${String(row.id)}`)) continue;
    const usage = asRecord(data.tokens);
    const cache = asRecord(usage?.cache);
    const tokens: TokenTotals = {
      input: number(usage?.input),
      output: number(usage?.output) + number(usage?.reasoning),
      cacheRead: number(cache?.read),
      cacheCreation: number(cache?.write),
    };
    if (isEmptyTokens(tokens)) continue;
    const model =
      typeof data.modelID === "string" && data.modelID !== ""
        ? data.modelID
        : "unknown";
    const cost = data.cost;
    samples.push({
      key: `${KEY_PREFIX}${String(row.session_id)}`,
      model,
      timestamp: created,
      tokens,
      ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0
        ? { reportedCost: cost }
        : {}),
    });
  }
  return samples;
}

/* ---------------------------------- 小件 ---------------------------------- */

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isoAt(ms: unknown): string {
  const value = Number(ms);
  return new Date(Number.isFinite(value) ? value : 0).toISOString();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* --------------------------------- 适配器 --------------------------------- */

export const opencodeAdapter: HistoryAdapter = {
  agentId: "opencode",
  roots,
  locate,
  list: candidates,
  parse,
  readEntries,
  describeCursor,
  cost: {
    kind: "snapshot",
    collect(sinceMs, ctx) {
      const path = databasePath();
      return path === undefined ? [] : collectFrom(path, sinceMs, ctx);
    },
  },
};
