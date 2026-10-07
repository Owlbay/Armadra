import { randomBytes } from "node:crypto";
import { closeSync, createReadStream, openSync, readSync } from "node:fs";
import type { ServerResponse } from "node:http";

import type { RequestIdentity } from "../identity/gate";
import { MEDIA_PATH_PREFIX } from "../identity/transport";
import { canonicalDirectory, resolveInRoot } from "../workspaces/roots";
import { badRequest } from "../workspaces/support";
import { baseName, relativeToRoot } from "./paths";
import { mediaPreviewOf, mimeOrOctetStream } from "./mime";
import { metadata } from "./stat";

/**
 * 媒体票与按字节区间取文件（契约 §37.4）。
 *
 * `<video src>`、`<audio src>`、`<img src>` 与 `<a href download>` 带不了
 * `Authorization`，Bearer 的源（桌面壳的本机源、直连源、原生 App 经 Gateway）
 * 以前只能把整份文件取回成 `blob:`。媒体票让浏览器直接取：页面先经带凭据的
 * `files.mediaTicket` 换一张票，地址是 `/api/media/<票>`——路径里只有票，
 * 工作空间、文件路径与凭据都不在 URL 上。
 *
 * 票只在内存里，绑着签票时的请求身份、一个工作空间里的一个文件和它的用法
 * （`inline` 预览 / `attachment` 下载）；只认 GET 与 HEAD。一张票可以用多次——
 * 播放器拖动进度条是一串 `Range` 请求——闲置 {@link MEDIA_TICKET_IDLE_MS} 或
 * 签出 {@link MEDIA_TICKET_MAX_MS} 之后作废。每次取都按签票的会话再认一次：
 * 登出、撤销设备、收回权限之后手里的票立刻不灵。
 */

export const MEDIA_TICKET_IDLE_MS = 5 * 60_000;
export const MEDIA_TICKET_MAX_MS = 30 * 60_000;
const MEDIA_TICKET_LIMIT = 1024;

export type MediaDisposition = "inline" | "attachment";

export interface MediaGrant {
  readonly workspaceId: string;
  readonly path: string;
  readonly disposition: MediaDisposition;
  /** 签票那次请求的身份；桌面壳本机没有身份（本机即 owner）。 */
  readonly identity: RequestIdentity | undefined;
}

interface Entry extends MediaGrant {
  readonly issuedAtMs: number;
  lastUsedAtMs: number;
}

export class MediaTickets {
  private readonly tickets = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(grant: MediaGrant): { ticket: string; expiresAtMs: number } {
    this.sweep();
    if (this.tickets.size >= MEDIA_TICKET_LIMIT) {
      const oldest = this.tickets.keys().next().value as string;
      this.tickets.delete(oldest);
    }
    const ticket = randomBytes(32).toString("base64url");
    const at = this.now();
    this.tickets.set(ticket, { ...grant, issuedAtMs: at, lastUsedAtMs: at });
    return { ticket, expiresAtMs: at + MEDIA_TICKET_IDLE_MS };
  }

  /** 认一张票并续上闲置期；过期或不认识答 `undefined`。 */
  use(ticket: string): MediaGrant | undefined {
    const found = this.tickets.get(ticket);
    if (found === undefined) return undefined;
    const now = this.now();
    if (
      now - found.lastUsedAtMs >= MEDIA_TICKET_IDLE_MS ||
      now - found.issuedAtMs >= MEDIA_TICKET_MAX_MS
    ) {
      this.tickets.delete(ticket);
      return undefined;
    }
    found.lastUsedAtMs = now;
    return found;
  }

  size(): number {
    return this.tickets.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [ticket, entry] of this.tickets) {
      if (
        now - entry.lastUsedAtMs >= MEDIA_TICKET_IDLE_MS ||
        now - entry.issuedAtMs >= MEDIA_TICKET_MAX_MS
      ) {
        this.tickets.delete(ticket);
      }
    }
  }
}

/** `/api/media/<票>` 里的票；形状不对答空串。 */
export function mediaTicketOf(path: string): string {
  if (!path.startsWith(MEDIA_PATH_PREFIX)) return "";
  const ticket = path.slice(MEDIA_PATH_PREFIX.length);
  return /^[A-Za-z0-9_-]{16,128}$/.test(ticket) ? ticket : "";
}

/* -------------------------------- Range -------------------------------- */

export type ByteRange = { readonly start: number; readonly end: number };

/**
 * 解析一个 `Range` 头（RFC 9110 §14）。只认单个区间：多个区间答
 * `undefined`（按整份 200 回，规范允许）；起点越过文件尾答 `"unsatisfiable"`。
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | "unsatisfiable" | undefined {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return undefined;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return undefined;
  if (first === "") {
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix) || suffix === 0) return "unsatisfiable";
    if (size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (!Number.isSafeInteger(start) || start >= size) return "unsatisfiable";
  const requested = last === "" ? size - 1 : Number(last);
  if (!Number.isSafeInteger(requested) || requested < start) return undefined;
  return { start, end: Math.min(requested, size - 1) };
}

/* ------------------------------- 响应头 -------------------------------- */

/**
 * 这个文件能不能以真实类型「内联」答：只有图片（SVG 除外，它能带脚本）与引擎
 * 自己能放的音视频。其余一律附件 + octet-stream，和 `file-download` 一样，
 * 上传的 HTML 不能在 core 的来源里执行。PDF 不内联：查看器要可执行的框架。
 */
export function inlineType(path: string): string | undefined {
  const mime = mimeOrOctetStream(path);
  if (mime === "image/svg+xml") return undefined;
  const preview = mediaPreviewOf(mime);
  return preview === "image" || preview === "video" || preview === "audio"
    ? mime
    : undefined;
}

function encodedName(path: string): string {
  return [...Buffer.from(baseName(path), "utf8")]
    .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");
}

/** 媒体与下载共用的响应头（不含长度与区间）。 */
export function byteHeaders(
  path: string,
  disposition: MediaDisposition,
): Record<string, string> {
  const inline = disposition === "inline" ? inlineType(path) : undefined;
  return {
    "content-type": inline ?? "application/octet-stream",
    "content-disposition": `${inline === undefined ? "attachment" : "inline"}; filename*=UTF-8''${encodedName(path)}`,
    "x-content-type-options": "nosniff",
    // 被人直接打开也只是一个不能跑脚本的文档。
    "content-security-policy": "default-src 'none'; sandbox",
    "referrer-policy": "no-referrer",
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  };
}

/* ------------------------------ 本机文件 ------------------------------- */

export interface LocalFile {
  readonly absolute: string;
  readonly relative: string;
  readonly size: number;
}

/** 工作区里的一个普通文件；越界、不是文件按 `bad_request`。 */
export function localFile(root: string, requested: string): LocalFile {
  const base = canonicalDirectory(root);
  const absolute = resolveInRoot(base, requested);
  const info = metadata(absolute);
  if (info === undefined || !info.isFile()) {
    throw badRequest("Requested path is not a file");
  }
  return {
    absolute,
    relative: relativeToRoot(base, absolute),
    size: info.size,
  };
}

/** 只读 `[start, end]` 那一段，不把整份文件读进内存。 */
export function readLocalRange(file: LocalFile, range: ByteRange): Buffer {
  const length = range.end - range.start + 1;
  const buffer = Buffer.alloc(length);
  const handle = openSync(file.absolute, "r");
  try {
    let filled = 0;
    while (filled < length) {
      const read = readSync(
        handle,
        buffer,
        filled,
        length - filled,
        range.start + filled,
      );
      if (read === 0) break;
      filled += read;
    }
    return filled === length ? buffer : buffer.subarray(0, filled);
  } finally {
    closeSync(handle);
  }
}

/**
 * 把一份字节源写进响应：有 `Range` 回 206，越界回 416，其余 200。HEAD 只写头。
 * `body` 给本机文件时流式读盘，给 `Buffer`（远端工作空间取回的字节）时切片。
 */
export function writeBytes(
  response: ServerResponse,
  input: {
    readonly method: string;
    readonly range: string | undefined;
    readonly headers: Record<string, string>;
    readonly size: number;
    readonly body: LocalFile | Buffer;
  },
): void {
  const { size } = input;
  const range = parseRange(input.range, size);
  if (range === "unsatisfiable") {
    response.writeHead(416, {
      ...input.headers,
      "content-range": `bytes */${size}`,
      "content-length": "0",
    });
    response.end();
    return;
  }
  const span = range ?? { start: 0, end: size - 1 };
  const length = size === 0 ? 0 : span.end - span.start + 1;
  response.writeHead(range === undefined ? 200 : 206, {
    ...input.headers,
    "content-length": String(length),
    ...(range === undefined
      ? {}
      : { "content-range": `bytes ${span.start}-${span.end}/${size}` }),
  });
  if (input.method.toUpperCase() === "HEAD" || length === 0) {
    response.end();
    return;
  }
  if (Buffer.isBuffer(input.body)) {
    response.end(input.body.subarray(span.start, span.end + 1));
    return;
  }
  const stream = createReadStream(input.body.absolute, {
    start: span.start,
    end: span.end,
  });
  stream.on("error", () => response.destroy());
  response.on("close", () => stream.destroy());
  stream.pipe(response);
}
