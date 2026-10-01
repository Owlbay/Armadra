import type { Block, TranscriptEntry } from "./types";

/**
 * JSON → 归一化记录（`TranscriptEntry`：role + blocks）。
 *
 * 从 `collab/transcript.ts::renderEntry` 与 `collab/transcript-summary.ts::readEntry`
 * 抽出来的那一半：两边原先各自认一遍 Claude、Codex 与 OpenAI 三种形状，规则几乎
 * 一样。现在认形状只在这里，渲染（`renderEntries`）与摘要（`digestEntries`）只吃
 * 记录。
 *
 * 宽容到底：每个 CLI 的转录形状都没承诺过，认不出来的行直接跳过。
 *
 *   * Claude：`{type: "user" | "assistant", message: {content}}`。
 *   * Codex：一切包在 `{type, payload}` 里，剥一层；`payload` 是 OpenAI 形状的
 *     `{type: "message", role, content}`。
 *   * OpenAI / 整份文档：`{role, content}`，或者 `{messages: [...]}` 这类数组。
 *
 * 两边原先不一致的边角照旧不一致，在记录上做记号（`loose`、`foreign`），由各自
 * 的消费方决定读不读。
 */

const ROLES = ["user", "assistant", "system"] as const;

type Role = TranscriptEntry["role"];

/** 认不出名字的工具调用就叫这个，渲染原样显示。 */
const UNNAMED_TOOL = "未命名工具";

/** 整份 JSON 文档里装消息数组的那几个键，按顺序试。 */
const DOCUMENT_KEYS = ["messages", "history", "chat", "turns", "items"];

/**
 * 一段转录文本 → 记录。JSONL、JSON 数组与 `{messages: []}` 都收。
 *
 * 整份文档的记录偏移一律是文本尾：整份 JSON 没有「读到一半」这回事。JSONL 的
 * 偏移是那一行（含换行）结束的字节。
 */
export function entriesFromJson(text: string): TranscriptEntry[] {
  return documentEntries(text) ?? lineEntries(text);
}

/**
 * 文本是一份装着消息数组的 JSON 文档时，它的记录；不是就 `undefined`。
 *
 * 数组找到了但一条都认不出来时是空数组而不是 `undefined`：要不要再按行试一遍
 * 是调用方的规矩（渲染会，摘要不会）。
 */
export function documentEntries(text: string): TranscriptEntry[] | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const items = documentItems(value);
  if (items === undefined) return undefined;
  const total = Buffer.byteLength(text, "utf8");
  const entries: TranscriptEntry[] = [];
  for (const item of items) {
    const entry = entryFromJson(item, total);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

/** 按行解析：每行一个 JSON 值，坏行跳过。 */
export function lineEntries(text: string): TranscriptEntry[] {
  const total = Buffer.byteLength(text, "utf8");
  const entries: TranscriptEntry[] = [];
  let offset = 0;
  for (const raw of text.split("\n")) {
    // `+1` 是被 `split` 吃掉的那个换行；最后一段多算一个字节不影响判据（游标
    // 只会因此少读零字节），但少算会让同一条被读第二次。
    offset += Buffer.byteLength(raw, "utf8") + 1;
    const line = raw.trim();
    if (line === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = entryFromJson(value, Math.min(offset, total));
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

function documentItems(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of DOCUMENT_KEYS) {
    const items = record[key];
    if (Array.isArray(items)) return items;
  }
  return undefined;
}

/** 一条 JSON 记录 → 一条归一化记录，或者什么都没有。 */
export function entryFromJson(
  value: unknown,
  endOffset: number,
  at?: string,
): TranscriptEntry | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const stamp =
    at ?? (typeof record.timestamp === "string" ? record.timestamp : undefined);
  // Codex wraps everything in `{type, payload}`; unwrap once.
  const payload = record.payload;
  if (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload)
  ) {
    return entryFromJson(payload, endOffset, stamp);
  }
  const kind = record.type;
  const role =
    typeof kind === "string" && (ROLES as readonly string[]).includes(kind)
      ? kind
      : typeof record.role === "string"
        ? record.role
        : undefined;
  if (role === undefined) return undefined;

  const message = record.message;
  const content =
    message !== null && typeof message === "object" && !Array.isArray(message)
      ? ((message as Record<string, unknown>).content ??
        record.content ??
        record.text)
      : (record.content ?? record.text);
  if (content === undefined || content === null) return undefined;

  const known = (ROLES as readonly string[]).includes(role);
  return {
    role: known ? (role as Role) : "system",
    blocks: blocksOf(content),
    endOffset,
    ...(stamp === undefined ? {} : { at: stamp }),
    ...(known ? {} : { foreign: true as const }),
  };
}

/**
 * `content` → 块。它在有些 CLI 里是字符串，在另一些里是块数组，偶尔是单个块。
 *
 * 数组里的裸字符串与嵌套数组里的一切记成 `loose`：拆分之前摘要读它们，渲染
 * 不读。
 */
export function blocksOf(content: unknown, loose = false): Block[] {
  if (typeof content === "string") return [text(content, loose)];
  if (Array.isArray(content)) {
    const out: Block[] = [];
    for (const item of content) {
      if (typeof item === "string") out.push(text(item, true));
      else if (Array.isArray(item)) out.push(...blocksOf(item, true));
      else if (item !== null && typeof item === "object") {
        out.push(...blockOf(item as Record<string, unknown>, loose));
      }
    }
    return out;
  }
  if (content !== null && typeof content === "object") {
    return blockOf(content as Record<string, unknown>, loose);
  }
  return [];
}

function text(value: string, loose: boolean): Block {
  return loose
    ? { type: "text", text: value, loose: true }
    : { type: "text", text: value };
}

function blockOf(record: Record<string, unknown>, loose: boolean): Block[] {
  const marker = loose ? { loose: true as const } : {};
  const kind = typeof record.type === "string" ? record.type : "text";
  switch (kind) {
    case "text":
    case "output_text":
    case "input_text":
      return typeof record.text === "string" ? [text(record.text, loose)] : [];
    case "tool_use":
    case "function_call": {
      const id = record.id ?? record.tool_use_id ?? record.call_id;
      const input = record.input ?? record.arguments;
      return [
        {
          type: "tool_use",
          name: typeof record.name === "string" ? record.name : UNNAMED_TOOL,
          ...(typeof id === "string" && id !== "" ? { id } : {}),
          ...(input === undefined ? {} : { input }),
          ...marker,
        },
      ];
    }
    case "tool_result":
    case "function_call_output": {
      const id = record.tool_use_id ?? record.call_id ?? record.id;
      return [
        {
          type: "tool_result",
          ...(typeof id === "string" ? { id } : {}),
          ...(record.content === undefined ? {} : { content: record.content }),
          ...marker,
        },
      ];
    }
    // Thinking blocks are the model talking to itself; not somebody else's
    // context.
    default:
      return [];
  }
}
