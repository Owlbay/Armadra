import {
  blocksOf,
  documentEntries,
  entryFromJson,
  lineEntries,
} from "../history/entries";
import { locateHistory } from "../history/registry";
import type { Block, TranscriptEntry } from "../history/types";

// 读文件的共用件搬进了 `history/files.ts`，这里照旧转出，调用方不用改。
export { findUnder, readRange, readTail, type Range } from "../history/files";

/**
 * Locating and rendering another agent's transcript.
 *
 * Ported from the pre-merge implementation. Every CLI writes its
 * history somewhere different and none of them promise the shape, so this
 * module is deliberately forgiving: it reads the tail of a file, renders the
 * lines it recognises, and skips the ones it does not. A transcript we can
 * only half read is far more useful to the agent asking than an error, and one
 * we cannot find at all is reported in a sentence rather than as a failure.
 */

/** Only the tail of a transcript is read; a long session is megabytes of JSON. */
export const MAX_TAIL_BYTES = 5 * 1024 * 1024;
/** `transcript` renders everything it found, up to this many bytes of prose. */
export const MAX_RENDERED_BYTES = 200 * 1024;
/** A tool's input is quoted, not dumped. */
const MAX_TOOL_DETAIL = 120;
/** One rendered message line is trimmed to this before it reaches the agent. */
const MAX_LINE = 2_000;

/** Where a transcript came from, so the reply can say so. */
export interface Located {
  readonly path: string;
  /** Human sentence naming the provider and file. */
  readonly origin: string;
}

/**
 * 渲染的两档（设计 `agent-delivery.md` §13 第 2 条）。
 *
 * 缺省这一档就是这个模块一直以来的行为，所以 `render(text)` 一个字都不用改。
 * `transcript` 那条路传的是收紧过的一档：每条消息截到 2 KB，`tool_result` 只
 * 留工具名、字节数与首行——工具结果是一份转录里最长、对读者最没用的一段，一
 * 次 `Read` 的回显就能顶掉整份预算。
 */
export interface RenderOptions {
  /** 一条消息截到这么多个字符。 */
  readonly maxLineChars?: number;
  /** `tool_result` 只留工具名、字节数与首行。 */
  readonly briefToolResults?: boolean;
}

interface RenderContext {
  readonly maxLineChars: number;
  readonly briefToolResults: boolean;
  /**
   * `tool_use_id` → 工具名，跨条目累积。
   *
   * `tool_result` 自己不带工具名，只带它回应的那次调用的 id；要说出「这是哪个
   * 工具的结果」就得记得前面那条 `tool_use`。一份转录是按时间顺序读的，所以这
   * 张表只需要往前看。
   */
  readonly toolNames: Map<string, string>;
}

function contextOf(options: RenderOptions | undefined): RenderContext {
  return {
    maxLineChars: options?.maxLineChars ?? MAX_LINE,
    briefToolResults: options?.briefToolResults ?? false,
    toolNames: new Map(),
  };
}

/**
 * 一条渲染好的记录，外加它在源文本里结束于第几个字节。
 *
 * 那个偏移是增量游标的全部实现（§13 第 3 条）：交出去 N 条之后，下次从第 N 条
 * 之后那个字节接着读。它算的是**源文本**的字节，不是渲染出来的散文的字节。
 */
export interface TranscriptRecord {
  readonly line: string;
  readonly endOffset: number;
}

/**
 * Renders JSONL (or a JSON array / object of messages) into one line per
 * message. Unknown lines are skipped rather than reported.
 */
export function render(text: string, options?: RenderOptions): string[] {
  return renderRecords(text, options).map((record) => record.line);
}

/** {@link render}，但每条还带着它在源文本里的结束偏移。 */
export function renderRecords(
  text: string,
  options?: RenderOptions,
): TranscriptRecord[] {
  const context = contextOf(options);
  // 整份 JSON 文档先试；它一条都渲染不出来时再按行试一遍。
  const document = documentEntries(text);
  if (document !== undefined) {
    const rendered = renderWith(document, context);
    if (rendered.length > 0) return rendered;
  }
  return renderWith(lineEntries(text), context);
}

/**
 * 归一化记录 → 一条一行的散文，认不出内容的记录跳过。偏移原样带出，调用方的
 * 增量游标不必知道记录是从哪种形状来的。
 */
export function renderEntries(
  entries: readonly TranscriptEntry[],
  options?: RenderOptions,
): TranscriptRecord[] {
  return renderWith(entries, contextOf(options));
}

function renderWith(
  entries: readonly TranscriptEntry[],
  context: RenderContext,
): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  for (const entry of entries) {
    const line = renderOne(entry, context);
    if (line !== undefined) records.push({ line, endOffset: entry.endOffset });
  }
  return records;
}

/** One transcript entry → one prose line, or nothing. */
export function renderEntry(
  value: unknown,
  options?: RenderOptions,
): string | undefined {
  const entry = entryFromJson(value, 0);
  return entry === undefined ? undefined : renderOne(entry, contextOf(options));
}

function renderOne(
  entry: TranscriptEntry,
  context: RenderContext,
): string | undefined {
  const body = renderBlocks(entry.blocks, context).trim();
  if (body === "") return undefined;
  const label =
    entry.role === "user"
      ? "[用户]"
      : entry.role === "assistant"
        ? "[助手]"
        : "[系统]";
  // A tool line already carries its own label.
  if (body.startsWith("[工具") || body.startsWith("[结果")) {
    return clamp(body, context.maxLineChars);
  }
  return clamp(`${label} ${body}`, context.maxLineChars);
}

/** 块之间用一个空格连起来；`loose` 的块渲染不读，见 `history/types.ts`。 */
function renderBlocks(
  blocks: readonly Block[],
  context: RenderContext,
): string {
  return blocks
    .map((block) =>
      block.loose === true ? undefined : renderBlock(block, context),
    )
    .filter((part): part is string => part !== undefined)
    .join(" ");
}

function renderBlock(block: Block, context: RenderContext): string | undefined {
  switch (block.type) {
    case "text": {
      const collapsed = collapse(block.text);
      return collapsed === "" ? undefined : collapsed;
    }
    case "tool_use": {
      if (block.id !== undefined) context.toolNames.set(block.id, block.name);
      const detail =
        block.input === undefined ? "" : summarizeInput(block.input);
      return detail === ""
        ? `[工具 ${block.name}]`
        : `[工具 ${block.name} ${detail}]`;
    }
    case "tool_result": {
      const detail =
        block.content === undefined
          ? ""
          : typeof block.content === "string"
            ? block.content
            : renderBlocks(blocksOf(block.content), context);
      if (!context.briefToolResults) {
        return `[结果 ${shorten(collapse(detail), MAX_TOOL_DETAIL)}]`;
      }
      const name =
        (block.id === undefined
          ? undefined
          : context.toolNames.get(block.id)) ?? "工具";
      const bytes = Buffer.byteLength(detail, "utf8");
      const first = collapse(detail.split("\n")[0] ?? "");
      return `[结果 ${name} ${bytes} B${first === "" ? "" : ` 首行：${shorten(first, MAX_TOOL_DETAIL)}`}]`;
    }
  }
}

/** A tool's arguments reduced to the one field a reader cares about. */
function summarizeInput(input: unknown): string {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    for (const key of [
      "file_path",
      "path",
      "command",
      "pattern",
      "query",
      "url",
      "description",
      "prompt",
    ]) {
      const value = record[key];
      if (typeof value === "string") {
        return shorten(collapse(value), MAX_TOOL_DETAIL);
      }
    }
    if (Object.keys(record).length === 0) return "";
  }
  if (typeof input === "string")
    return shorten(collapse(input), MAX_TOOL_DETAIL);
  return shorten(collapse(JSON.stringify(input) ?? ""), MAX_TOOL_DETAIL);
}

function collapse(text: string): string {
  return text.trim().split(/\s+/).filter(Boolean).join(" ");
}

function shorten(text: string, maxChars: number): string {
  const characters = [...text];
  if (characters.length <= maxChars) return text;
  return `${characters.slice(0, maxChars).join("")}…`;
}

function clamp(line: string, maxChars: number): string {
  return shorten(line, maxChars);
}

/* -------------------------------- locating -------------------------------- */

/**
 * Finds the transcript for a node.
 *
 * `transcriptPath` is what the CLI itself reported; past that it is the
 * agent's history adapter (`history/registry.ts`) — codex is found by session
 * id under its own config home. A provider with neither is `undefined`, which
 * the caller must report as "this CLI keeps nothing readable" rather than as
 * an empty conversation.
 */
export function locate(
  agentId: string,
  transcriptPath: string | undefined,
  sessionId: string | undefined,
  launch: { readonly cwd?: string; readonly startedAtMs?: number } = {},
): Located | undefined {
  // `launch` 是节点终端的 cwd 与启动时间（`collab/nodes.ts::launchOf`）：Pi / OMP
  // 没报路径时靠它兜底。
  const found = locateHistory({
    agentId,
    transcriptPath,
    sessionId,
    ...launch,
  });
  return found?.path === undefined
    ? undefined
    : { path: found.path, origin: found.origin };
}
