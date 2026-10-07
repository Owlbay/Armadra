import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { renderEntries } from "../collab/transcript";
import {
  ACP_MIRROR_SUFFIX,
  type MirrorBlock,
  type MirrorDiff,
  type MirrorEntry,
  type MirrorLocation,
  type MirrorRecord,
  mirrorSize,
  readMirrorEntries,
} from "../history/acp-mirror";
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
 * 消息里的图片与资源链接也记（契约 §49）：`image`（base64 超过 512 KiB 只记
 * `dropped`）、`resource_link`；内嵌的 `resource` 有正文记成文字，没有记成资源
 * 链接。工具调用带的文件差异随它的结果整份记下（`diffs`），不随正文截断。
 * 这几种只有会话视图读（`read` 的 `rich`），连线读取与摘要看不到。
 *
 * 思考块、计划、用量、模式变化不进镜像：它们不是对话，只给页面（`acp.update`）；
 * 活进程的那一份在 `…/log` 的 `snapshot` 里（`session.ts`）。
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

/** 一张图片在镜像里最多占这么多 base64 字符；再大只记 `dropped`。 */
export const IMAGE_LIMIT = 512 * 1024;

function textOf(content: unknown): string {
  if (typeof content !== "object" || content === null) return "";
  const block = content as { type?: unknown; text?: unknown };
  return block.type === "text" && typeof block.text === "string"
    ? block.text
    : "";
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** URI 的最后一段，当资源没有名字时的名字。 */
function nameOf(uri: string): string {
  const tail = uri.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const name = tail.slice(tail.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(name) || uri;
  } catch {
    return name || uri;
  }
}

/** 一个 ACP 内容块 → 镜像里的块；认不出或空的答 `undefined`。 */
export function mirrorBlockOf(content: unknown): MirrorBlock | undefined {
  if (typeof content !== "object" || content === null) return undefined;
  const block = content as Record<string, unknown>;
  switch (block.type) {
    case "text": {
      const text = textOf(block);
      return text === "" ? undefined : { type: "text", text };
    }
    case "image": {
      const mimeType = stringOf(block.mimeType) ?? "image/png";
      const data = typeof block.data === "string" ? block.data : "";
      if (data === "" || data.length > IMAGE_LIMIT) {
        return { type: "image", mimeType, dropped: true };
      }
      return { type: "image", mimeType, data };
    }
    case "resource_link": {
      const uri = stringOf(block.uri);
      if (uri === undefined) return undefined;
      const mimeType = stringOf(block.mimeType);
      const title = stringOf(block.title);
      return {
        type: "resource_link",
        uri,
        name: stringOf(block.name) ?? nameOf(uri),
        ...(mimeType === undefined ? {} : { mimeType }),
        ...(title === undefined ? {} : { title }),
      };
    }
    case "resource": {
      const resource = block.resource as Record<string, unknown> | undefined;
      if (typeof resource !== "object" || resource === null) return undefined;
      const text = stringOf(resource.text);
      if (text !== undefined) return { type: "text", text };
      const uri = stringOf(resource.uri);
      if (uri === undefined) return undefined;
      const mimeType = stringOf(resource.mimeType);
      return {
        type: "resource_link",
        uri,
        name: nameOf(uri),
        ...(mimeType === undefined ? {} : { mimeType }),
      };
    }
    default:
      return undefined;
  }
}

/** `tool_call.locations[]`：路径与可选行号，最多记 20 个。 */
function locationsOf(value: unknown): MirrorLocation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const locations: MirrorLocation[] = [];
  for (const item of value.slice(0, 20)) {
    const entry = item as { path?: unknown; line?: unknown } | null;
    if (typeof entry?.path !== "string" || entry.path === "") continue;
    locations.push({
      path: entry.path,
      ...(typeof entry.line === "number" && Number.isInteger(entry.line)
        ? { line: entry.line }
        : {}),
    });
  }
  return locations.length > 0 ? locations : undefined;
}

/** `tool_call(_update).content[]` 里的文件差异。 */
function diffsOf(content: unknown): MirrorDiff[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const diffs: MirrorDiff[] = [];
  for (const item of content) {
    const entry = item as Record<string, unknown> | null;
    if (
      entry === null ||
      typeof entry !== "object" ||
      entry.type !== "diff" ||
      typeof entry.path !== "string" ||
      typeof entry.newText !== "string"
    ) {
      continue;
    }
    diffs.push({
      path: entry.path,
      ...(typeof entry.oldText === "string" ? { oldText: entry.oldText } : {}),
      newText: entry.newText,
    });
  }
  return diffs;
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
  /** 还没落结果的工具调用最近一次给的差异（`content` 每次整份替换）。 */
  private readonly diffs = new Map<string, MirrorDiff[]>();

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
    let blocks: MirrorBlock[] | undefined;
    let role: "user" | "assistant" = "assistant";
    if (
      (update.sessionUpdate === "tool_call" ||
        update.sessionUpdate === "tool_call_update") &&
      typeof body.toolCallId === "string" &&
      body.toolCallId !== "" &&
      !this.settled.has(body.toolCallId)
    ) {
      const diffs = diffsOf(body.content);
      if (diffs !== undefined) this.diffs.set(body.toolCallId, diffs);
    }
    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        if (!replay) return false;
        const block = mirrorBlockOf(body.content);
        if (block === undefined) return false;
        role = "user";
        blocks = [block];
        break;
      }
      case "agent_message_chunk": {
        const block = mirrorBlockOf(body.content);
        if (block === undefined) return false;
        blocks = [block];
        break;
      }
      case "tool_call": {
        const id = typeof body.toolCallId === "string" ? body.toolCallId : "";
        const name =
          (typeof body.title === "string" && body.title) ||
          (typeof body.kind === "string" && body.kind) ||
          "tool";
        const kind = typeof body.kind === "string" ? body.kind : undefined;
        const locations = locationsOf(body.locations);
        blocks = [
          {
            type: "tool_use",
            name,
            ...(id === "" ? {} : { id }),
            ...(body.rawInput === undefined ? {} : { input: body.rawInput }),
            ...(kind === undefined ? {} : { kind }),
            ...(locations === undefined ? {} : { locations }),
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
        const diffs = id === "" ? diffsOf(body.content) : this.diffs.get(id);
        if (id !== "") {
          this.settled.add(id);
          this.diffs.delete(id);
        }
        role = "user";
        blocks = [
          {
            type: "tool_result",
            ...(id === "" ? {} : { id }),
            content: resultOf(body),
            ...(body.status === "failed" ? { status: "failed" as const } : {}),
            ...(diffs === undefined || diffs.length === 0 ? {} : { diffs }),
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

  /**
   * 从 `after` 起的记录（`GET /api/acp/sessions/{id}/log`）：连图片、资源链接
   * 与差异一起读（契约 §49）。
   */
  read(after = 0): { entries: MirrorEntry[]; endOffset: number } {
    const range = readMirrorEntries(this.path, after, 32 * 1024 * 1024, {
      rich: true,
    });
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
