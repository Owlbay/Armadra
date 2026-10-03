import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { renderEntries } from "../collab/transcript";
import {
  ACP_MIRROR_SUFFIX,
  type MirrorRecord,
  mirrorSize,
  readMirrorEntries,
} from "../history/acp-mirror";
import type { Block, TranscriptEntry } from "../history/types";
import type { AcpSessionUpdate } from "./types";

/**
 * ACP 会话的镜像：写的那一半（ACP 会话视图设计 §5.7，D7）。
 *
 * `<数据目录>/acp/<nodeId>/<sessionId>.acp.jsonl`，目录 0700、文件 0600，与
 * `pending/` 同级。每条 `session/update` 落成 `TranscriptEntry` 形状的一行（读
 * 的那一半在 `history/acp-mirror.ts`）：
 *
 *   * 我方发出的 prompt → user 文本；
 *   * `agent_message_chunk` → assistant 文本，一块一行（页面重载要读得到正在
 *     流的那一段；读的时候相邻的并成一条）；
 *   * `tool_call` → assistant 的 `tool_use`；`tool_call_update` 到了终态
 *     （completed / failed）→ user 的 `tool_result`，每个调用只记一次；
 *   * `user_message_chunk` 只在回放进一份空镜像时记：活的回合里那是适配器对我
 *     们自己那条 prompt 的回显，已经记过了。
 *
 * 思考块、计划、用量、模式变化不进镜像：它们不是对话，只给页面（`acp.update`）。
 *
 * **先写镜像再发事件**：页面先订阅再读 `…/log`，读回来之前到的分块被它丢掉
 * ——前提是那些分块此时已经在镜像里了（会话层守这个次序）。
 */

/** 一条工具结果在镜像里最多占这么多字符：整份文件的 diff 不该撑大转录。 */
const RESULT_LIMIT = 8_000;

/** 文件名里的会话 id：只留安全字符，截长。 */
function fileComponent(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return cleaned === "" || cleaned === "." || cleaned === ".."
    ? "session"
    : cleaned;
}

export function mirrorDirectory(dataDir: string, nodeId: string): string {
  return join(dataDir, "acp", fileComponent(nodeId));
}

export function mirrorPath(
  dataDir: string,
  nodeId: string,
  sessionId: string,
): string {
  return join(
    mirrorDirectory(dataDir, nodeId),
    `${fileComponent(sessionId)}${ACP_MIRROR_SUFFIX}`,
  );
}

function textOf(content: unknown): string {
  if (typeof content !== "object" || content === null) return "";
  const block = content as { type?: unknown; text?: unknown };
  return block.type === "text" && typeof block.text === "string"
    ? block.text
    : "";
}

/** 工具结果的正文：内容块里的文字，没有就 `rawOutput`，再没有就状态。 */
function resultOf(update: Record<string, unknown>): unknown {
  const content = Array.isArray(update.content) ? update.content : [];
  const texts = content
    .map((item: unknown) => {
      const entry = item as { type?: unknown; content?: unknown };
      return entry?.type === "content" ? textOf(entry.content) : "";
    })
    .filter((text) => text !== "");
  let value: unknown =
    texts.length > 0
      ? texts.join("\n")
      : update.rawOutput !== undefined
        ? update.rawOutput
        : { status: update.status };
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized !== undefined && serialized.length > RESULT_LIMIT) {
    value = `${serialized.slice(0, RESULT_LIMIT)}…`;
  }
  return value;
}

export class AcpMirror {
  /** 已经记过终态结果的工具调用。 */
  private readonly settled = new Set<string>();

  constructor(readonly path: string) {}

  /** 镜像还是空的（文件不在或零字节）。 */
  get empty(): boolean {
    return mirrorSize(this.path) === 0;
  }

  get size(): number {
    return mirrorSize(this.path);
  }

  append(record: MirrorRecord): void {
    const directory = dirname(this.path);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    const fresh = !existsSync(this.path);
    appendFileSync(
      this.path,
      `${JSON.stringify({ ...record, at: record.at ?? new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
    if (fresh) {
      try {
        chmodSync(this.path, 0o600);
      } catch {
        // Windows 上没有 POSIX 权限；数据目录本身已经是用户私有的。
      }
    }
  }

  /** 我方发出的一条 prompt。 */
  prompt(text: string): void {
    if (text === "") return;
    this.append({ role: "user", blocks: [{ type: "text", text }] });
  }

  /**
   * 一条 `session/update`。`replay`：`session/load` 回放的历史——只有镜像
   * 还空着（例如从终端驱动切过来）时才记，否则镜像里已经有了。答这一条记没
   * 记。
   */
  update(update: AcpSessionUpdate, replay = false): boolean {
    const body = update as unknown as Record<string, unknown>;
    let blocks: Block[] | undefined;
    let role: "user" | "assistant" = "assistant";
    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        if (!replay) return false;
        const text = textOf(body.content);
        if (text === "") return false;
        role = "user";
        blocks = [{ type: "text", text }];
        break;
      }
      case "agent_message_chunk": {
        const text = textOf(body.content);
        if (text === "") return false;
        blocks = [{ type: "text", text }];
        break;
      }
      case "tool_call": {
        const id = typeof body.toolCallId === "string" ? body.toolCallId : "";
        const name =
          (typeof body.title === "string" && body.title) ||
          (typeof body.kind === "string" && body.kind) ||
          "tool";
        blocks = [
          {
            type: "tool_use",
            name,
            ...(id === "" ? {} : { id }),
            ...(body.rawInput === undefined ? {} : { input: body.rawInput }),
          },
        ];
        break;
      }
      case "tool_call_update": {
        const id = typeof body.toolCallId === "string" ? body.toolCallId : "";
        if (body.status !== "completed" && body.status !== "failed") {
          return false;
        }
        if (id !== "" && this.settled.has(id)) return false;
        if (id !== "") this.settled.add(id);
        role = "user";
        blocks = [
          {
            type: "tool_result",
            ...(id === "" ? {} : { id }),
            content: resultOf(body),
          },
        ];
        break;
      }
      default:
        return false;
    }
    this.append({ role, blocks });
    return true;
  }

  /** 从 `after` 起的记录（`GET /api/acp/sessions/{id}/log`）。 */
  read(after = 0): { entries: TranscriptEntry[]; endOffset: number } {
    const range = readMirrorEntries(this.path, after, 32 * 1024 * 1024);
    return { entries: [...range.entries], endOffset: range.endOffset };
  }

  /**
   * 「终端画面」的 ACP 版（`context terminal`、自动命名）：镜像尾部渲染成散文，
   * 取最后 `lines` 行。
   */
  capture(lines: number): string {
    const size = this.size;
    const window = 256 * 1024;
    const range = readMirrorEntries(
      this.path,
      Math.max(0, size - window),
      window,
    );
    const rendered = renderEntries(range.entries)
      .map((record) => record.line)
      .join("\n")
      .split("\n");
    return lines <= 0
      ? rendered.join("\n")
      : rendered.slice(Math.max(0, rendered.length - lines)).join("\n");
  }
}
