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

/** 工具结果附带的文件差异（契约 §49）：整份保留，不随正文截断。 */
export interface MirrorDiff {
  readonly path: string;
  readonly oldText?: string | null;
  readonly newText: string;
}

/**
 * 只有会话视图（`…/log`）读的块（契约 §49）：图片、资源链接，以及带差异的工具
 * 结果。连线读取、摘要、渲染这些吃 {@link Block} 的读取方看不到它们——一张
 * base64 图片不该进别人的上下文。
 */
export type MirrorMediaBlock =
  | {
      readonly type: "image";
      readonly mimeType: string;
      /** base64；超过上限时不记，`dropped` 为真。 */
      readonly data?: string;
      readonly dropped?: true;
    }
  | {
      readonly type: "resource_link";
      readonly uri: string;
      readonly name: string;
      readonly mimeType?: string;
      readonly title?: string;
    };

/** 工具调用涉及的文件（契约 §49）。 */
export interface MirrorLocation {
  readonly path: string;
  readonly line?: number;
}

export type MirrorBlock =
  | Block
  | MirrorMediaBlock
  | (Extract<Block, { type: "tool_use" }> & {
      readonly kind?: string;
      readonly locations?: readonly MirrorLocation[];
    })
  | (Extract<Block, { type: "tool_result" }> & {
      readonly status?: "failed";
      readonly diffs?: readonly MirrorDiff[];
    });

/** 会话视图读到的一条记录：块里可以有 {@link MirrorMediaBlock}。 */
export type MirrorEntry = Omit<TranscriptEntry, "blocks"> & {
  readonly blocks: readonly MirrorBlock[];
};

/** 一行镜像记录（写入与读取同一个形状）。 */
export interface MirrorRecord {
  readonly role: "user" | "assistant";
  readonly blocks: readonly MirrorBlock[];
  readonly at?: string;
}

/** 读镜像的选项：`rich` 时连 {@link MirrorMediaBlock} 与差异一起读。 */
export interface MirrorReadOptions {
  readonly rich?: boolean;
}

const ROLES = new Set(["user", "assistant"]);

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function diffsOf(value: unknown): MirrorDiff[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const diffs: MirrorDiff[] = [];
  for (const item of value) {
    const raw = item as Record<string, unknown> | null;
    if (
      raw === null ||
      typeof raw !== "object" ||
      typeof raw.path !== "string" ||
      typeof raw.newText !== "string"
    ) {
      continue;
    }
    diffs.push({
      path: raw.path,
      ...(typeof raw.oldText === "string" ? { oldText: raw.oldText } : {}),
      newText: raw.newText,
    });
  }
  return diffs.length > 0 ? diffs : undefined;
}

function locationsOf(value: unknown): MirrorLocation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const locations: MirrorLocation[] = [];
  for (const item of value) {
    const raw = item as { path?: unknown; line?: unknown } | null;
    if (typeof raw?.path !== "string" || raw.path === "") continue;
    locations.push({
      path: raw.path,
      ...(typeof raw.line === "number" ? { line: raw.line } : {}),
    });
  }
  return locations.length > 0 ? locations : undefined;
}

function mediaOf(raw: Record<string, unknown>): MirrorMediaBlock | undefined {
  if (raw.type === "image") {
    const mimeType = optionalString(raw.mimeType);
    if (mimeType === undefined) return undefined;
    if (typeof raw.data === "string") {
      return { type: "image", mimeType, data: raw.data };
    }
    return raw.dropped === true
      ? { type: "image", mimeType, dropped: true }
      : undefined;
  }
  if (raw.type === "resource_link") {
    const uri = optionalString(raw.uri);
    if (uri === undefined) return undefined;
    const mimeType = optionalString(raw.mimeType);
    const title = optionalString(raw.title);
    return {
      type: "resource_link",
      uri,
      name: optionalString(raw.name) ?? uri,
      ...(mimeType === undefined ? {} : { mimeType }),
      ...(title === undefined ? {} : { title }),
    };
  }
  return undefined;
}

function blockOf(value: unknown, rich = false): MirrorBlock | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (rich && (raw.type === "image" || raw.type === "resource_link")) {
    return mediaOf(raw);
  }
  switch (raw.type) {
    case "text":
      return typeof raw.text === "string"
        ? { type: "text", text: raw.text }
        : undefined;
    case "tool_use": {
      if (typeof raw.name !== "string") return undefined;
      const kind = rich ? optionalString(raw.kind) : undefined;
      const locations = rich ? locationsOf(raw.locations) : undefined;
      return {
        type: "tool_use",
        name: raw.name,
        ...(typeof raw.id === "string" ? { id: raw.id } : {}),
        ...(raw.input === undefined ? {} : { input: raw.input }),
        ...(kind === undefined ? {} : { kind }),
        ...(locations === undefined ? {} : { locations }),
      };
    }
    case "tool_result": {
      const diffs = rich ? diffsOf(raw.diffs) : undefined;
      return {
        type: "tool_result",
        ...(typeof raw.id === "string" ? { id: raw.id } : {}),
        ...(raw.content === undefined ? {} : { content: raw.content }),
        ...(rich && raw.status === "failed"
          ? { status: "failed" as const }
          : {}),
        ...(diffs === undefined ? {} : { diffs }),
      };
    }
    default:
      return undefined;
  }
}

/** 一行文本 → 一条记录；认不出来的行跳过（半行、别人写进来的东西）。 */
export function parseMirrorLine(
  line: string,
  endOffset: number,
): TranscriptEntry | undefined;
export function parseMirrorLine(
  line: string,
  endOffset: number,
  options: MirrorReadOptions,
): MirrorEntry | undefined;
export function parseMirrorLine(
  line: string,
  endOffset: number,
  options: MirrorReadOptions = {},
): MirrorEntry | undefined {
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
    .map((block) => blockOf(block, options.rich === true))
    .filter((block): block is MirrorBlock => block !== undefined);
  if (blocks.length === 0) return undefined;
  return {
    role: raw.role as "user" | "assistant",
    blocks,
    endOffset,
    ...(typeof raw.at === "string" ? { at: raw.at } : {}),
  };
}

function textOnly(entry: MirrorEntry): boolean {
  return entry.blocks.every((block) => block.type === "text");
}

/**
 * 相邻的纯文本助手记录并成一条：逐块写下的一次回复读回来是一段话。偏移取后
 * 一条的，增量读取从合并之后接着读。
 */
export function coalesce<E extends MirrorEntry>(entries: readonly E[]): E[] {
  const out: E[] = [];
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
      } as unknown as E;
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
): EntryRange;
export function readMirrorEntries(
  path: string,
  fromOffset: number,
  maxBytes: number,
  options: MirrorReadOptions,
): Omit<EntryRange, "entries"> & { readonly entries: readonly MirrorEntry[] };
export function readMirrorEntries(
  path: string,
  fromOffset: number,
  maxBytes: number,
  options: MirrorReadOptions = {},
): Omit<EntryRange, "entries"> & { readonly entries: readonly MirrorEntry[] } {
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
  const entries: MirrorEntry[] = [];
  let consumed = cursor;
  while (cursor < read) {
    const newline = buffer.indexOf(0x0a, cursor);
    // 最后半行（还在写、或被 maxBytes 截断）留给下一次。
    if (newline === -1 || newline >= read) break;
    const line = buffer.subarray(cursor, newline).toString("utf8");
    const entry = parseMirrorLine(line, start + newline + 1, options);
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
