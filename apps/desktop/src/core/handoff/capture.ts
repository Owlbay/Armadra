import { readTail } from "../history/files";
import { locateHistory, readHistoryEntries } from "../history/registry";
import type { TranscriptEntry } from "../history/types";
import { gitFingerprint } from "../git/fingerprint";
import {
  type FileReference,
  type GitFingerprint,
  fingerprintFiles,
} from "./bundle";

/**
 * 交接材料里要到「文件所在的那台机器」上读的部分：文件引用的指纹、Git 指纹与
 * 转录的尾巴。
 *
 * 本机工作空间在控制端直接调；远端工作空间经 Worker 的 `handoff.capture` 在执行
 * 主机上调同一个函数——读控制端磁盘上同名的路径，交出去的就是另一堆文件的指纹。
 * 转录跟着 Agent 走：SSH 终端里的 Agent 的转录在执行主机上，本机终端的在本机。
 */

/** 转录尾巴最多读这么多字节。 */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

export interface CaptureRequest {
  readonly paths: readonly string[];
  /** 工作空间的执行授权：读索引可能跑仓库过滤器，没有就只给身份。 */
  readonly execute: boolean;
  /** 写进每条文件引用的 `executionHost`。 */
  readonly executionHost: string;
  /** 在这台机器上读转录，线索见 {@link TranscriptSource}。 */
  readonly transcript?: TranscriptSource;
}

/**
 * 去哪找来源 Agent 的转录：CLI 报来的路径与会话 id，加上节点终端的 cwd 与启动
 * 时间。路径永远先认；没有路径时经本地历史适配器按其余线索找（Codex 按会话 id、
 * Pi / OMP 按 cwd 加启动时间、OpenCode 按会话 id 读库）。
 */
export interface TranscriptSource {
  readonly provider: string;
  readonly path?: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly startedAtMs?: number;
}

export interface Captured {
  readonly files: readonly FileReference[];
  readonly git: GitFingerprint;
  /** 要了转录时才有。 */
  readonly transcript?: TranscriptTail;
}

/**
 * 转录读到了什么：`missing` 是那个路径上没有文件（与没有转录同一个结论），
 * `unreadable` 是有文件但读的时候失败或变了。
 */
export type TranscriptTail =
  | { readonly state: "read"; readonly text: string }
  | { readonly state: "missing" }
  | { readonly state: "unreadable" };

export function readTranscriptTail(source: TranscriptSource): TranscriptTail {
  const located = locateHistory({
    agentId: source.provider,
    transcriptPath: source.path,
    sessionId: source.sessionId,
    cwd: source.cwd,
    startedAtMs: source.startedAtMs,
  });
  if (located === undefined) return { state: "missing" };
  try {
    if (located.path !== undefined) {
      return {
        state: "read",
        text: readTail(located.path, TRANSCRIPT_TAIL_BYTES),
      };
    }
    // 没有文件的来源（OpenCode 的库）：经适配器读归一化记录，再写回 JSONL。
    // 交出去的仍是一段文本——远端 Worker 的回复形状与控制端的渲染都不用改。
    const range = readHistoryEntries(
      source.provider,
      located,
      0,
      TRANSCRIPT_TAIL_BYTES,
    );
    if (range.entries.length === 0) return { state: "missing" };
    return { state: "read", text: entriesAsJsonl(range.entries) };
  } catch {
    return { state: "unreadable" };
  }
}

/**
 * 归一化记录 → `entriesFromJson` 认得回来的 JSONL：`{role, content, timestamp}`，
 * 块原样放进 `content`（`tool_result` 的 id 落在 `id` 上，解析时照样认）。
 */
export function entriesAsJsonl(entries: readonly TranscriptEntry[]): string {
  return entries
    .map(
      (entry) =>
        `${JSON.stringify({
          role: entry.role,
          content: entry.blocks,
          ...(entry.at === undefined ? {} : { timestamp: entry.at }),
        })}\n`,
    )
    .join("");
}

export function capture(root: string, request: CaptureRequest): Captured {
  const files = fingerprintFiles(root, request.paths).map((file) => ({
    ...file,
    executionHost: request.executionHost,
  }));
  const git = gitFingerprint({ rootPath: root, execute: request.execute });
  return {
    files,
    git,
    ...(request.transcript === undefined
      ? {}
      : {
          transcript: readTranscriptTail(request.transcript),
        }),
  };
}

/** Worker 收到的参数，逐项核对后交给 {@link capture}。 */
export function captureArgs(args: Record<string, unknown>): CaptureRequest {
  const paths = Array.isArray(args.paths)
    ? args.paths.filter((path): path is string => typeof path === "string")
    : [];
  const transcript = args.transcript as Record<string, unknown> | undefined;
  const text = (key: string): string | undefined => {
    const value = transcript?.[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const startedAtMs = transcript?.startedAtMs;
  return {
    paths: paths.slice(0, 32),
    execute: args.execute === true,
    executionHost:
      typeof args.executionHost === "string"
        ? args.executionHost
        : "local-runtime",
    ...(text("provider") !== undefined
      ? {
          transcript: {
            provider: text("provider") as string,
            ...(text("path") === undefined
              ? {}
              : { path: text("path") as string }),
            ...(text("sessionId") === undefined
              ? {}
              : { sessionId: text("sessionId") as string }),
            ...(text("cwd") === undefined
              ? {}
              : { cwd: text("cwd") as string }),
            ...(typeof startedAtMs === "number" && Number.isFinite(startedAtMs)
              ? { startedAtMs }
              : {}),
          },
        }
      : {}),
  };
}
