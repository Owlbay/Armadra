import { readFileSync } from "node:fs";
import { basename as pathBasename, dirname, join, resolve } from "node:path";
import {
  type Candidate,
  type Parsed,
  collect,
  readLines,
  title,
} from "../conversations/scan";
import { recordRequests } from "../usage/cost-buckets";
import { asRecord, number } from "./cost-lines";
import { isFile, readRange } from "./files";
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
 * GitHub Copilot CLI 的会话 —— `${COPILOT_HOME:-~/.copilot}/session-state/<id>/events.jsonl`。
 *
 * 一个会话一个目录，目录名就是会话 id。`events.jsonl` 每行一个事件
 * `{type, data, id, timestamp, parentId}`；同目录的 `workspace.yaml` 记着 cwd。
 * 目录里还有检查点、文件快照等，一概不读。
 *
 * 记录映射（设计 `cli-collaboration.md` §2.2）：`user.message` → user，
 * `assistant.message` → assistant（`toolRequests` → 工具调用）；`hook.*`、
 * `thinking`、`tool.execution_*`、`session.*` 等事件跳过。
 *
 * 用量不按 token 计：`session.usage_checkpoint.data.totalPremiumRequests` 是
 * **会话累计**的 premium request 数，见下面的成本来源。
 */

/** 首条用户消息前面可能有很长的系统消息与 Hook 事件。 */
const HEAD_BYTES = 512 * 1024;
const HEAD_LINES = 200;

/** `workspace.yaml` 只要一行，读个头就够。 */
const WORKSPACE_BYTES = 16 * 1024;

const EVENTS_FILE = "events.jsonl";

/** 认不出名字的工具调用，与 `entries.ts` 同一个叫法。 */
const UNNAMED_TOOL = "未命名工具";

/** `<configHome>/session-state`；没有家目录也没有覆盖时一个都没有。 */
export function roots(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = configRoot("copilot", env);
  return home === undefined ? [] : [join(home, "session-state")];
}

/** `<session-state>/<id>/events.jsonl`，不往更深处认。 */
export function candidates(root: string): Candidate[] {
  const base = resolve(root);
  return collect(
    root,
    (path) =>
      pathBasename(path) === EVENTS_FILE &&
      resolve(dirname(dirname(path))) === base,
  );
}

export function parse(path: string): Parsed | undefined {
  const directory = pathBasename(dirname(path));
  if (directory === "") return undefined;
  const parsed = parseLines(directory, readLines(path, HEAD_BYTES, HEAD_LINES));
  return {
    ...parsed,
    cwd: workspaceCwd(join(dirname(path), "workspace.yaml")),
  };
}

/**
 * 会话 id 与标题。cwd 不在事件里，由 {@link parse} 从 `workspace.yaml` 补。
 * 拆出来好让测试直接喂行。
 */
export function parseLines(
  directory: string,
  lines: readonly string[],
): Parsed {
  let sessionId = "";
  let found = "";
  for (const line of lines) {
    if (line === "") continue;
    let event: Record<string, unknown> | undefined;
    try {
      event = asRecord(JSON.parse(line) as unknown);
    } catch {
      continue;
    }
    if (event === undefined) continue;
    const data = asRecord(event.data);
    if (
      sessionId === "" &&
      event.type === "session.start" &&
      typeof data?.sessionId === "string"
    ) {
      sessionId = data.sessionId;
    }
    if (found === "" && event.type === "user.message") {
      const text = typeof data?.content === "string" ? data.content.trim() : "";
      if (text !== "") found = title(text);
    }
    if (sessionId !== "" && found !== "") break;
  }
  return {
    sessionId: sessionId === "" ? directory : sessionId,
    title: found,
    cwd: "",
  };
}

/**
 * `workspace.yaml` 里 `cwd:` 那一行的值；文件不在或没有这一行是空串。
 *
 * 不引 YAML 库：只认顶层的 `cwd: <值>`，值可以带单引号或双引号。
 */
export function workspaceCwd(path: string): string {
  let text: string;
  try {
    text = readFileSync(path).subarray(0, WORKSPACE_BYTES).toString("utf8");
  } catch {
    return "";
  }
  const match = /^cwd:[ \t]*(.*?)[ \t]*$/m.exec(text);
  return match === null ? "" : unquote(match[1] ?? "");
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

/* ---------------------------------- 定位 ---------------------------------- */

/**
 * Hook 带着会话 id，目录名就是它。上报的转录路径由注册表先认，这里只按 id 找。
 * 带路径分隔符或 `..` 的 id 不拼路径。
 */
export function locate(hint: SessionHint): Located | undefined {
  const sessionId = hint.sessionId;
  if (
    sessionId === undefined ||
    sessionId === "" ||
    sessionId === "." ||
    sessionId === ".." ||
    /[/\\]/.test(sessionId)
  ) {
    return undefined;
  }
  for (const root of roots()) {
    const path = join(root, sessionId, EVENTS_FILE);
    if (isFile(path)) {
      return { key: path, path, origin: `Copilot 会话记录 ${path}` };
    }
  }
  return undefined;
}

/* ---------------------------------- 读取 ---------------------------------- */

/** 一行事件 → 一条记录；不是两类消息的事件是 `undefined`。 */
export function entryFromEvent(
  value: unknown,
  endOffset: number,
): TranscriptEntry | undefined {
  const event = asRecord(value);
  if (event === undefined) return undefined;
  const data = asRecord(event.data);
  if (data === undefined) return undefined;
  const at = typeof event.timestamp === "string" ? event.timestamp : undefined;
  const stamp = at === undefined ? {} : { at };
  if (event.type === "user.message") {
    if (typeof data.content !== "string" || data.content === "") {
      return undefined;
    }
    return {
      role: "user",
      blocks: [{ type: "text", text: data.content }],
      endOffset,
      ...stamp,
    };
  }
  if (event.type === "assistant.message") {
    const blocks: Block[] = [];
    if (typeof data.content === "string" && data.content !== "") {
      blocks.push({ type: "text", text: data.content });
    }
    if (Array.isArray(data.toolRequests)) {
      for (const item of data.toolRequests) {
        const request = asRecord(item);
        if (request === undefined) continue;
        const id = request.toolCallId;
        blocks.push({
          type: "tool_use",
          name:
            typeof request.name === "string" && request.name !== ""
              ? request.name
              : UNNAMED_TOOL,
          ...(typeof id === "string" && id !== "" ? { id } : {}),
          ...(request.arguments === undefined
            ? {}
            : { input: request.arguments }),
        });
      }
    }
    if (blocks.length === 0) return undefined;
    return { role: "assistant", blocks, endOffset, ...stamp };
  }
  return undefined;
}

/** 按行解析事件，偏移是那一行（含换行）结束的字节，与 `entries.ts` 同一套。 */
export function eventEntries(text: string): TranscriptEntry[] {
  const total = Buffer.byteLength(text, "utf8");
  const entries: TranscriptEntry[] = [];
  let offset = 0;
  for (const raw of text.split("\n")) {
    offset += Buffer.byteLength(raw, "utf8") + 1;
    const line = raw.trim();
    if (line === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = entryFromEvent(value, Math.min(offset, total));
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

/**
 * 从 `fromOffset` 读到尾，最多 `maxBytes`。窗口截在半行里时丢掉那半行，
 * 起点跟着后移——与 `files.ts::readFileEntries` 同一条规矩，只是认的是事件形状。
 */
export function readEntries(
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
    entries: eventEntries(text),
    startOffset,
    endOffset: range.endOffset,
  };
}

/* ---------------------------------- 成本 ---------------------------------- */

/**
 * `totalPremiumRequests` 是会话到这一刻为止的累计值，所以不逐行求和：每条
 * checkpoint 只把它比上一条多出来的那部分记到自己的时间点上（`recordRequests`），
 * 文件的 `requests` 停在最后一条的值。一个会话跨了几天，每天分到的就是那天新增
 * 的请求数，近 24 小时 / 7 天 / 30 天各自求和也不会重复计。
 *
 * 不进 token 桶，模型这一段记 `unknown`：checkpoint 不说是哪个模型，按请求计的
 * 成本行也不按模型拆。
 */
const costSource: AgentCostSource = {
  agentId: "copilot",
  unit: "premiumRequests",
  roots: () => roots(),
  needles: [Buffer.from('"session.usage_checkpoint"')],
  absorb(state, value, context) {
    const line = asRecord(value);
    if (line?.type !== "session.usage_checkpoint") return;
    const data = asRecord(line.data);
    if (data === undefined || typeof data.totalPremiumRequests !== "number") {
      return;
    }
    recordRequests(
      state,
      "unknown",
      line.timestamp,
      number(data.totalPremiumRequests),
      context.nowMs,
    );
  },
};

/* --------------------------------- 适配器 --------------------------------- */

export const copilotAdapter: HistoryAdapter = {
  agentId: "copilot",
  roots,
  locate,
  list: candidates,
  parse: (candidate) => parse(candidate.path),
  readEntries,
  cost: { kind: "jsonl", source: costSource },
};
