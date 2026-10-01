import { dirname, extname, join, resolve } from "node:path";
import {
  type Candidate,
  type Parsed,
  basename,
  collect,
  readLines,
  title,
} from "../conversations/scan";
import {
  isEmptyTokens,
  record as recordTokens,
  type TokenTotals,
} from "../usage/cost-buckets";
import { asRecord, duplicate, number } from "./cost-lines";
import { findUnder, readRange, reportedFile } from "./files";
import { configRoot } from "./home";
import type {
  AgentCostSource,
  Block,
  EntryRange,
  HistoryAdapter,
  Located,
  SessionHint,
  TranscriptEntry,
} from "./types";

/**
 * Pi 与 OMP 的会话记录 —— `<agentDir>/sessions/<编码 cwd>/<ISO 时间>_<uuid>.jsonl`。
 *
 * 两家是同一份代码：OMP 是 Pi 的分支，文件形状相同，只是配置目录的规矩不同
 * （`hook/install/shared.ts::configHomeWith`，返回的已经是 `agent` 那一层）。
 * 于是这里按 `agentId` 造两个适配器。
 *
 * 文件里有一条 `type: "session"` 记录带着会话 id 与 cwd。Pi 把它写在第一行；
 * OMP 在它前面还有一行定长的标题记录，所以按头部若干行找，而不是只看第一行。
 * 之后是 `model_change`、`thinking_level_change` 之类的事件和 `type: "message"`
 * 的消息；只有消息算记录。消息的 `role` 有 `user` / `assistant` / `system`，
 * 工具结果是单独一条 `role: "toolResult"` 的消息，而不是某条消息里的块。
 *
 * 目录名是编码过的 cwd，编码规矩没承诺过，这里从不解码它：cwd 只从记录里读。
 */

/** 会话记录在头几行，第一条用户消息也在前十行之内。 */
const HEAD_BYTES = 256 * 1024;
const HEAD_LINES = 64;

const UUID =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** 认不出名字的工具调用就叫这个，与 `entries.ts` 同一个说法。 */
const UNNAMED_TOOL = "未命名工具";

type PiAgent = "pi" | "omp";

const LABELS: Record<PiAgent, string> = { pi: "Pi", omp: "OMP" };

/** `<agentDir>/sessions`；没有家目录也没有覆盖时一个都没有。 */
function rootsOf(
  agentId: PiAgent,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const home = configRoot(agentId, env);
  return home === undefined ? [] : [join(home, "sessions")];
}

/** `<sessions>/<编码 cwd>/<file>.jsonl`，不往更深处找。 */
export function candidates(root: string): Candidate[] {
  const base = resolve(root);
  return collect(
    root,
    (path) =>
      extname(path) === ".jsonl" && resolve(dirname(dirname(path))) === base,
  );
}

/** `2026-10-02T01-02-03-456Z_<uuid>` → 那个 uuid；形状不对是 `undefined`。 */
export function sessionIdFromStem(stem: string): string | undefined {
  const separator = stem.lastIndexOf("_");
  const tail = separator === -1 ? stem : stem.slice(separator + 1);
  return UUID.test(tail) && tail.length === 36 ? tail : undefined;
}

export function parse(path: string): Parsed | undefined {
  const stem = (basename(path) ?? "").replace(/\.jsonl$/, "");
  if (stem === "") return undefined;
  return parseLines(stem, readLines(path, HEAD_BYTES, HEAD_LINES));
}

/** 从 {@link parse} 拆出来，测试可以直接喂行。 */
export function parseLines(stem: string, lines: readonly string[]): Parsed {
  let sessionId = "";
  let cwd = "";
  let found = "";
  for (const line of lines) {
    const record = jsonRecord(line);
    if (record === undefined) continue;
    if (record.type === "session") {
      if (sessionId === "" && typeof record.id === "string") {
        sessionId = record.id;
      }
      if (cwd === "" && typeof record.cwd === "string") cwd = record.cwd;
    } else if (found === "" && record.type === "message") {
      const message = asRecord(record.message);
      if (message?.role === "user") {
        const text = userText(message.content).trim();
        if (text !== "") found = title(text);
      }
    }
    if (sessionId !== "" && cwd !== "" && found !== "") break;
  }
  return {
    sessionId: sessionId === "" ? (sessionIdFromStem(stem) ?? stem) : sessionId,
    title: found,
    cwd,
  };
}

/** 用户消息里的文字：字符串原样，块数组只取 `text` 块。 */
function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string"
        ? record.text
        : undefined;
    })
    .filter((text): text is string => text !== undefined)
    .join(" ");
}

function jsonRecord(line: string): Record<string, unknown> | undefined {
  if (line === "") return undefined;
  try {
    return asRecord(JSON.parse(line) as unknown);
  } catch {
    return undefined;
  }
}

/** 头部那条 `type: "session"` 记录里的 cwd；没有是 `undefined`。 */
function sessionCwd(path: string): string | undefined {
  for (const line of readLines(path, HEAD_BYTES, HEAD_LINES)) {
    const record = jsonRecord(line);
    if (record?.type === "session") {
      return typeof record.cwd === "string" ? record.cwd : undefined;
    }
  }
  return undefined;
}

/* ---------------------------------- 定位 ---------------------------------- */

/**
 * 扩展会报 `transcriptPath`，那一条由注册表先认；这里是它没报（或者文件已经
 * 不在）时的兜底：先按会话 id 找文件名以 `_<id>.jsonl` 结尾的那个，再按 cwd
 * 加启动时间找——同一个 cwd 下、启动之后改过的文件里最新的一个。
 */
function locateIn(
  agentId: PiAgent,
  hint: SessionHint,
  roots: readonly string[],
): Located | undefined {
  const label = `${LABELS[agentId]} 会话记录`;
  const sessionId = hint.sessionId;
  if (sessionId !== undefined && sessionId !== "") {
    const suffix = `_${sessionId}.jsonl`;
    for (const root of roots) {
      const found = findUnder(root, (name) => name.endsWith(suffix));
      if (found !== undefined) {
        return { key: found, path: found, origin: `${label} ${found}` };
      }
    }
  }
  const cwd = hint.cwd;
  const startedAtMs = hint.startedAtMs;
  if (cwd === undefined || cwd === "" || startedAtMs === undefined) {
    return undefined;
  }
  let best: { modified: number; path: string } | undefined;
  for (const root of roots) {
    for (const candidate of candidates(root)) {
      const modified = Date.parse(candidate.updatedAt);
      if (!(modified >= startedAtMs)) continue;
      if (best !== undefined && modified <= best.modified) continue;
      if (sessionCwd(candidate.path) !== cwd) continue;
      best = { modified, path: candidate.path };
    }
  }
  return best === undefined
    ? undefined
    : { key: best.path, path: best.path, origin: `${label} ${best.path}` };
}

/* ---------------------------------- 记录 ---------------------------------- */

/**
 * 从 `fromOffset` 读到尾，规矩与 `files.ts::readFileEntries` 相同（超出上限保留
 * 尾部、不从半行开始、偏移相对于 `startOffset`），只是每行按 Pi 的形状认。
 */
export function readPiEntries(
  located: Located,
  fromOffset: number,
  maxBytes: number,
): EntryRange {
  if (located.path === undefined) {
    return { entries: [], startOffset: 0, endOffset: 0 };
  }
  const range = readRange(located.path, fromOffset, maxBytes);
  let text = range.text;
  let startOffset = range.startOffset;
  const requested =
    fromOffset > range.endOffset || fromOffset < 0 ? 0 : fromOffset;
  if (startOffset > requested && text !== "") {
    const newline = text.indexOf("\n");
    const skipped = newline === -1 ? text : text.slice(0, newline + 1);
    startOffset += Buffer.byteLength(skipped, "utf8");
    text = newline === -1 ? "" : text.slice(newline + 1);
  }
  return {
    entries: piEntries(text),
    startOffset,
    endOffset: range.endOffset,
  };
}

/** 按行认：每行一个 JSON，坏行和不是消息的行跳过。偏移同 `entries.ts`。 */
export function piEntries(text: string): TranscriptEntry[] {
  const total = Buffer.byteLength(text, "utf8");
  const entries: TranscriptEntry[] = [];
  let offset = 0;
  for (const raw of text.split("\n")) {
    offset += Buffer.byteLength(raw, "utf8") + 1;
    const record = jsonRecord(raw.trim());
    if (record === undefined) continue;
    const entry = piEntry(record, Math.min(offset, total));
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

/** 一行 → 一条记录。只认 `type: "message"`。 */
export function piEntry(
  record: Record<string, unknown>,
  endOffset: number,
): TranscriptEntry | undefined {
  if (record.type !== "message") return undefined;
  const message = asRecord(record.message);
  if (message === undefined) return undefined;
  const at = stamp(record.timestamp) ?? stamp(message.timestamp);
  const base = {
    endOffset,
    ...(at === undefined ? {} : { at }),
  };
  const role = message.role;
  const content = message.content;
  // 工具结果是单独一条消息；按 Claude 的规矩记在用户那一侧。
  if (role === "toolResult") {
    const id = message.toolCallId;
    return {
      role: "user",
      blocks: [
        {
          type: "tool_result",
          ...(typeof id === "string" && id !== "" ? { id } : {}),
          ...(content === undefined || content === null ? {} : { content }),
        },
      ],
      ...base,
    };
  }
  if (content === undefined || content === null) return undefined;
  const blocks = piBlocks(content);
  if (role === "user" || role === "assistant" || role === "system") {
    return { role, blocks, ...base };
  }
  // 其余的 role（扩展自定义的消息之类）按 `system` 显示，摘要不计。
  return { role: "system", blocks, ...base, foreign: true };
}

/** `content` → 块：`text` 原样，`toolCall` 记成工具调用，思考与图片跳过。 */
function piBlocks(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const blocks: Block[] = [];
  for (const item of content) {
    const block = asRecord(item);
    if (block === undefined) continue;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "toolCall") {
      const id = block.id;
      const input = block.arguments;
      blocks.push({
        type: "tool_use",
        name: typeof block.name === "string" ? block.name : UNNAMED_TOOL,
        ...(typeof id === "string" && id !== "" ? { id } : {}),
        ...(input === undefined ? {} : { input }),
      });
    }
  }
  return blocks;
}

/** 顶层的 RFC 3339 字符串，或者消息里的毫秒数，都转成 RFC 3339。 */
function stamp(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return undefined;
}

/* ---------------------------------- 成本 ---------------------------------- */

/**
 * 只有 assistant 消息带 `message.usage`；预筛判据见 `claude.ts` 同一处。
 *
 * Pi 的 `input` 不含缓存命中（缓存读写各自一个数），与 Claude 的四个桶一一对应。
 * `reasoning` 已经算在 `output` 里，不再加。去重按 `responseId`；没有它的行用
 * 行 id 加时间——行 id 只有八位十六进制，单独用会在文件之间撞上。
 */
function costSourceOf(agentId: PiAgent): AgentCostSource {
  return {
    agentId,
    roots: () => rootsOf(agentId),
    needles: [Buffer.from('"usage"')],
    absorb(state, value, context) {
      const line = asRecord(value);
      if (line?.type !== "message") return;
      const message = asRecord(line.message);
      const usage = asRecord(message?.usage);
      if (usage === undefined) return;
      const at = stamp(line.timestamp) ?? stamp(message?.timestamp);
      const identity =
        typeof message?.responseId === "string" && message.responseId !== ""
          ? message.responseId
          : typeof line.id === "string"
            ? `${line.id}@${at ?? ""}`
            : undefined;
      if (duplicate(context, identity)) return;
      const tokens: TokenTotals = {
        input: number(usage.input),
        output: number(usage.output),
        cacheRead: number(usage.cacheRead),
        cacheCreation: number(usage.cacheWrite),
      };
      if (isEmptyTokens(tokens)) return;
      const model =
        typeof message?.model === "string" && message.model !== ""
          ? message.model
          : "unknown";
      recordTokens(state, model, at, tokens, context.nowMs);
    },
  };
}

/* --------------------------------- 适配器 --------------------------------- */

function adapterOf(agentId: PiAgent): HistoryAdapter {
  return {
    agentId,
    roots: (env) => rootsOf(agentId, env),
    locate: (hint) =>
      reportedFile(hint.transcriptPath) ??
      locateIn(agentId, hint, rootsOf(agentId)),
    list: candidates,
    parse: (candidate) => parse(candidate.path),
    readEntries: readPiEntries,
    cost: { kind: "jsonl", source: costSourceOf(agentId) },
  };
}

export const piAdapter: HistoryAdapter = adapterOf("pi");
export const ompAdapter: HistoryAdapter = adapterOf("omp");
