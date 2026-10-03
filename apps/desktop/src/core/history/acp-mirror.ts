import { closeSync, openSync, readSync, statSync } from "node:fs";

import type { Block, EntryRange, TranscriptEntry } from "./types";

/**
 * ACP 会话的镜像转录：读的那一半（ACP 会话视图设计 §5.7，D7）。
 *
 * core 以 ACP 驱动一个节点时，自己把会话写成
 * `<数据目录>/acp/<nodeId>/<sessionId>.acp.jsonl`（写在 `core/acp/mirror.ts`）。
 * CLI 自己的转录对不上 ACP 会话 id 时（Copilot，或者还没落盘的新会话），节点的
 * `transcriptPath` 指向它，于是连线读取、摘要、交接这些吃 `TranscriptEntry` 的
 * 读取方不必知道会话是哪种驱动起的——`history/registry.ts::readHistoryEntries`
 * 在适配器之前先认这个后缀。
 *
 * 一行一条记录：`{ role, blocks, at }`，`blocks` 与 `TranscriptEntry` 同形。
 * 助手的回复是逐块写下的（页面重载要读得到正在流的那一段），读的时候把相邻的
 * 纯文本助手行并成一条——一次回复在读取方眼里仍是一条记录。
 */

export const ACP_MIRROR_SUFFIX = ".acp.jsonl";

/** 这个路径是不是一份 ACP 镜像。 */
export function isAcpMirror(path: string | undefined): boolean {
  return path !== undefined && path.endsWith(ACP_MIRROR_SUFFIX);
}

/** 一行镜像记录（写入与读取同一个形状）。 */
export interface MirrorRecord {
  readonly role: "user" | "assistant";
  readonly blocks: readonly Block[];
  readonly at?: string;
}

const ROLES = new Set(["user", "assistant"]);

function blockOf(value: unknown): Block | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  switch (raw.type) {
    case "text":
      return typeof raw.text === "string"
        ? { type: "text", text: raw.text }
        : undefined;
    case "tool_use":
      return typeof raw.name === "string"
        ? {
            type: "tool_use",
            name: raw.name,
            ...(typeof raw.id === "string" ? { id: raw.id } : {}),
            ...(raw.input === undefined ? {} : { input: raw.input }),
          }
        : undefined;
    case "tool_result":
      return {
        type: "tool_result",
        ...(typeof raw.id === "string" ? { id: raw.id } : {}),
        ...(raw.content === undefined ? {} : { content: raw.content }),
      };
    default:
      return undefined;
  }
}

/** 一行文本 → 一条记录；认不出来的行跳过（半行、别人写进来的东西）。 */
export function parseMirrorLine(
  line: string,
  endOffset: number,
): TranscriptEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.role !== "string" || !ROLES.has(raw.role)) return undefined;
  if (!Array.isArray(raw.blocks)) return undefined;
  const blocks = raw.blocks
    .map(blockOf)
    .filter((block): block is Block => block !== undefined);
  if (blocks.length === 0) return undefined;
  return {
    role: raw.role as "user" | "assistant",
    blocks,
    endOffset,
    ...(typeof raw.at === "string" ? { at: raw.at } : {}),
  };
}

function textOnly(entry: TranscriptEntry): boolean {
  return entry.blocks.every((block) => block.type === "text");
}

/**
 * 相邻的纯文本助手记录并成一条：逐块写下的一次回复读回来是一段话。偏移取后
 * 一条的，增量读取从合并之后接着读。
 */
export function coalesce(
  entries: readonly TranscriptEntry[],
): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const entry of entries) {
    const last = out.at(-1);
    if (
      last !== undefined &&
      last.role === "assistant" &&
      entry.role === "assistant" &&
      textOnly(last) &&
      textOnly(entry)
    ) {
      const text =
        last.blocks.map((block) => (block as { text: string }).text).join("") +
        entry.blocks.map((block) => (block as { text: string }).text).join("");
      out[out.length - 1] = {
        role: "assistant",
        blocks: [{ type: "text", text }],
        endOffset: entry.endOffset,
        ...(last.at === undefined ? {} : { at: last.at }),
      };
      continue;
    }
    out.push(entry);
  }
  return out;
}

/** 文件的字节数；不存在答 0。 */
export function mirrorSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * 从 `fromOffset` 起读最多 `maxBytes` 字节的完整行。`fromOffset` 落在行中间
 * （调用方给的不是记录边界）时跳过那半行。文件不在答空。
 */
export function readMirrorEntries(
  path: string,
  fromOffset: number,
  maxBytes: number,
): EntryRange {
  const size = mirrorSize(path);
  const start = fromOffset < 0 || fromOffset > size ? 0 : fromOffset;
  if (size === 0 || start >= size) {
    return { entries: [], startOffset: start, endOffset: size };
  }
  const length = Math.min(size - start, Math.max(0, maxBytes));
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  let read = 0;
  try {
    while (read < length) {
      const got = readSync(fd, buffer, read, length - read, start + read);
      if (got === 0) break;
      read += got;
    }
  } finally {
    closeSync(fd);
  }
  let cursor = 0;
  // 不在行首：前一个字节不是换行就跳过半行。
  if (start > 0) {
    const previous = Buffer.alloc(1);
    const probe = openSync(path, "r");
    try {
      readSync(probe, previous, 0, 1, start - 1);
    } finally {
      closeSync(probe);
    }
    if (previous[0] !== 0x0a) {
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) {
        return { entries: [], startOffset: start, endOffset: start };
      }
      cursor = newline + 1;
    }
  }
  const startOffset = start + cursor;
  const entries: TranscriptEntry[] = [];
  let consumed = cursor;
  while (cursor < read) {
    const newline = buffer.indexOf(0x0a, cursor);
    // 最后半行（还在写、或被 maxBytes 截断）留给下一次。
    if (newline === -1 || newline >= read) break;
    const line = buffer.subarray(cursor, newline).toString("utf8");
    const entry = parseMirrorLine(line, start + newline + 1);
    if (entry !== undefined) entries.push(entry);
    cursor = newline + 1;
    consumed = cursor;
  }
  return {
    entries: coalesce(entries),
    startOffset,
    endOffset: start + consumed,
  };
}
