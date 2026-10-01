import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { entriesFromJson } from "./entries";
import type { EntryRange, Located } from "./types";

/**
 * 读别人文件的那几样共用件：有界的按名查找、读尾巴、按偏移增量读。
 *
 * 从 `collab/transcript.ts` 搬过来（那里仍然转出同名函数），好让各家适配器
 * 不必反过来依赖 `collab/`。
 */

/** Ceiling on how many directory entries a session-id search will look at. */
const MAX_SCAN_ENTRIES = 20_000;
const MAX_SCAN_DEPTH = 6;

/**
 * Reads at most the last `maxBytes` of a file, starting at the first newline
 * inside the window so the first line is never a fragment.
 */
export function readTail(path: string, maxBytes: number): string {
  const handle = openSync(path, "r");
  try {
    const length = statSync(path).size;
    const start = Math.max(0, length - maxBytes);
    const size = Math.min(length - start, maxBytes);
    const buffer = Buffer.alloc(size);
    let filled = 0;
    while (filled < size) {
      const read = readSync(
        handle,
        buffer,
        filled,
        size - filled,
        start + filled,
      );
      if (read === 0) break;
      filled += read;
    }
    const text = buffer.subarray(0, filled).toString("utf8");
    if (start === 0) return text;
    const newline = text.indexOf("\n");
    return newline === -1 ? "" : text.slice(newline + 1);
  } finally {
    closeSync(handle);
  }
}

/** 一次增量读取的结果：读到的文本，以及现在的文件尾在第几个字节。 */
export interface Range {
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

/**
 * 从 `startByte` 读到文件尾，最多 `maxBytes`（增量游标那条路）。
 *
 * 偏移大于文件长度的时候从头读：转录被换掉或者被截短了，那个偏移在新内容里指
 * 的是另一段话。路径是否还是同一个由游标自己判（`context-reads.ts`），长度这
 * 一层的判据在这里。
 */
export function readRange(
  path: string,
  startByte: number,
  maxBytes: number,
): Range {
  const handle = openSync(path, "r");
  try {
    const length = statSync(path).size;
    const start = startByte > length || startByte < 0 ? 0 : startByte;
    // 超过上限时保留**尾部**：新的那些比旧的那些有用。
    const from = Math.max(start, length - maxBytes);
    const size = Math.max(0, length - from);
    if (size === 0) return { text: "", startOffset: from, endOffset: length };
    const buffer = Buffer.alloc(size);
    let filled = 0;
    while (filled < size) {
      const read = readSync(
        handle,
        buffer,
        filled,
        size - filled,
        from + filled,
      );
      if (read === 0) break;
      filled += read;
    }
    return {
      text: buffer.subarray(0, filled).toString("utf8"),
      startOffset: from,
      endOffset: length,
    };
  } finally {
    closeSync(handle);
  }
}

/**
 * 文件来源的 `readEntries`：{@link readRange} 读出文本，再归一化成记录。
 *
 * 窗口被上限截在半行里的时候，那半行连同它的换行一起丢掉，起点跟着后移——和
 * {@link readTail} 同一条规矩。偏移是相对于返回的 `startOffset` 的字节数。
 */
export function readFileEntries(
  path: string,
  fromOffset: number,
  maxBytes: number,
): EntryRange {
  const range = readRange(path, fromOffset, maxBytes);
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
    entries: entriesFromJson(text),
    startOffset,
    endOffset: range.endOffset,
  };
}

/** 文件来源适配器的 `readEntries`：没有文件路径的定位结果读不出东西。 */
export function readLocatedEntries(
  located: Located,
  fromOffset: number,
  maxBytes: number,
): EntryRange {
  if (located.path === undefined) {
    return { entries: [], startOffset: 0, endOffset: 0 };
  }
  return readFileEntries(located.path, fromOffset, maxBytes);
}

/** CLI 自己报来的转录路径，真是一个文件时就用它。 */
export function reportedFile(
  transcriptPath: string | undefined,
): Located | undefined {
  if (transcriptPath === undefined || !isFile(transcriptPath)) return undefined;
  return {
    key: transcriptPath,
    path: transcriptPath,
    origin: `转录文件 ${transcriptPath}`,
  };
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A bounded walk that answers with the newest matching file.
 *
 * Codex does not document its directory layout, so the search is by file name;
 * the bounds are what keep a surprising layout (a symlink loop, a
 * million-file cache) from turning a read into a hang.
 */
export function findUnder(
  root: string,
  matches: (name: string) => boolean,
): string | undefined {
  if (!isDirectory(root)) return undefined;
  const frontier: [string, number][] = [[root, 0]];
  let seen = 0;
  let best: { modified: number; path: string } | undefined;
  while (frontier.length > 0) {
    const [directory, depth] = frontier.pop() as [string, number];
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > MAX_SCAN_ENTRIES) return best?.path;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_SCAN_DEPTH) frontier.push([path, depth + 1]);
        continue;
      }
      if (!entry.isFile() || !matches(entry.name)) continue;
      let modified = 0;
      try {
        modified = statSync(path).mtimeMs;
      } catch {
        modified = 0;
      }
      if (best === undefined || modified > best.modified) {
        best = { modified, path };
      }
    }
  }
  return best?.path;
}
