import { extname, join } from "node:path";
import {
  type Candidate,
  type Parsed,
  basename,
  collect,
  readLines,
  title,
} from "../conversations/scan";
import {
  isEmptyTokens,
  record as recordTokens,
  type TokenTotals,
} from "../usage/cost-buckets";
import { asRecord, number } from "./cost-lines";
import { findUnder, readLocatedEntries, reportedFile } from "./files";
import { configRoot } from "./home";
import type {
  AgentCostSource,
  HistoryAdapter,
  Located,
  SessionHint,
} from "./types";

/**
 * Codex rollouts — `${CODEX_HOME:-~/.codex}/sessions/ ** /rollout-*.jsonl`.
 *
 * Ported from the pre-merge implementation. Files are filed under
 * `sessions/YYYY/MM/DD/` and named `rollout-<timestamp>-<uuid>.jsonl`. The
 * first record is a `session_meta` carrying the id and the cwd; the turns that
 * follow are `response_item` envelopes around OpenAI-shaped messages.
 *
 * The wrinkle is that codex replays a lot of machinery *as the user*: the
 * permissions block, `AGENTS.md`, the plugin catalogue. Those come first and
 * they are large — the median real first message starts tens of kilobytes into
 * the file, all within the first ten lines. Hence the generous byte budget and
 * the tight line budget.
 *
 * 会话索引的候选与解析、成本来源、按会话 id 找 rollout 都在这一个适配器里
 * （`codexAdapter`）。
 */

const HEAD_BYTES = 512 * 1024;
const HEAD_LINES = 24;

/**
 * Openings that mean "codex is talking to itself". A human message that
 * happens to start with `<` does not survive being mistaken for one often
 * enough to matter — the next user turn is used instead.
 */
const SYNTHETIC_PREFIXES = [
  "<user_instructions>",
  "<environment_context>",
  "<recommended_plugins>",
  "<permissions instructions>",
  "<INSTRUCTIONS>",
  "# AGENTS.md instructions",
] as const;

/** `<configHome>/sessions`；没有家目录也没有覆盖时一个都没有。 */
export function roots(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = configRoot("codex", env);
  return home === undefined ? [] : [join(home, "sessions")];
}

export function candidates(root: string): Candidate[] {
  return collect(
    root,
    (path) =>
      extname(path) === ".jsonl" &&
      (basename(path) ?? "").startsWith("rollout-"),
  );
}

export function parse(path: string): Parsed | undefined {
  const stem = (basename(path) ?? "").replace(/\.jsonl$/, "");
  if (stem === "") return undefined;
  return parseLines(stem, readLines(path, HEAD_BYTES, HEAD_LINES));
}

export function parseLines(stem: string, lines: readonly string[]): Parsed {
  let sessionId = sessionIdFromStem(stem) ?? "";
  let cwd = "";
  let found = "";
  for (const line of lines) {
    if (line === "") continue;
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed === null || typeof parsed !== "object") continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const kind = typeof record.type === "string" ? record.type : "";
    const payload =
      record.payload !== null && typeof record.payload === "object"
        ? (record.payload as Record<string, unknown>)
        : {};
    if (kind === "session_meta") {
      if (sessionId === "" && typeof payload.id === "string") {
        sessionId = payload.id;
      }
      if (cwd === "" && typeof payload.cwd === "string") cwd = payload.cwd;
    } else if (kind === "turn_context") {
      // `turn_context` repeats the cwd; useful when the meta record was
      // written by a version that did not carry one.
      if (cwd === "" && typeof payload.cwd === "string") cwd = payload.cwd;
    }
    if (found === "") {
      const text = userText(kind, payload);
      const candidate = text === undefined ? undefined : usable(text);
      if (candidate !== undefined) found = title(candidate);
    }
    if (cwd !== "" && found !== "" && sessionId !== "") break;
  }
  return { sessionId: sessionId === "" ? stem : sessionId, title: found, cwd };
}

/**
 * The user's words in this record, if it holds any.
 *
 * Two shapes: the persisted conversation item (`response_item` wrapping a
 * `message` with `role: "user"`) and the UI event stream (`event_msg` /
 * `user_message`), which newer builds also write.
 */
function userText(
  kind: string,
  payload: Record<string, unknown>,
): string | undefined {
  if (kind === "response_item") {
    if (payload.type !== "message" || payload.role !== "user") return undefined;
    const content = payload.content;
    if (!Array.isArray(content)) return undefined;
    return content
      .map((block) =>
        block !== null && typeof block === "object"
          ? (block as Record<string, unknown>).text
          : undefined,
      )
      .filter((text): text is string => typeof text === "string")
      .join(" ");
  }
  if (kind === "event_msg") {
    if (payload.type !== "user_message") return undefined;
    return typeof payload.message === "string" ? payload.message : undefined;
  }
  return undefined;
}

export function usable(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  if (SYNTHETIC_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return undefined;
  }
  return trimmed;
}

/**
 * `rollout-2026-09-04T02-06-15-01a06873-…-2224a11ce547` → the trailing UUID.
 *
 * The timestamp in the middle also contains dashes, so the id is taken as the
 * last 36 characters and only accepted if it is shaped like a UUID; anything
 * else falls back to the `session_meta` record.
 */
export function sessionIdFromStem(stem: string): string | undefined {
  const characters = [...stem];
  if (characters.length < 36) return undefined;
  const tail = characters.slice(characters.length - 36).join("");
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    tail,
  )
    ? tail
    : undefined;
}

/* ---------------------------------- 定位 ---------------------------------- */

/**
 * Codex 的 Hook 不一定报转录路径，于是按会话 id 在 `sessions/` 下找文件名里
 * 带着它的那个 rollout，取最新的一个。
 */
export function locate(hint: SessionHint): Located | undefined {
  const reported = reportedFile(hint.transcriptPath);
  if (reported !== undefined) return reported;
  const sessionId = hint.sessionId;
  if (sessionId === undefined || sessionId === "") return undefined;
  for (const root of roots()) {
    const found = findUnder(
      root,
      (name) =>
        name.startsWith("rollout-") &&
        name.includes(sessionId) &&
        name.endsWith(".jsonl"),
    );
    if (found !== undefined) {
      return { key: found, path: found, origin: `Codex 会话记录 ${found}` };
    }
  }
  return undefined;
}

/* ---------------------------------- 成本 ---------------------------------- */

/**
 * 预筛：要么是 `token_count` 的 payload，要么是某一处 `model` 声明——后者会被
 * 记进 `state.model` 给后面的事件用，所以不能只看 `token_count`。
 *
 * 判据是 JSON 里那个键**字面的**样子。理论上 `"usage"` 是同一个键而这里会漏
 * 掉它；两家 CLI 的序列化器都不会那么写，而代价（漏算）比反过来（把整份记录全解
 * 析一遍）小得多。
 */
const costSource: AgentCostSource = {
  agentId: "codex",
  roots: () => roots(),
  needles: [Buffer.from('"model"'), Buffer.from('"token_count"')],
  absorb(state, value, context) {
    const line = asRecord(value);
    if (line === undefined) return;
    // 模型由会话元数据和每一轮的上下文宣布；先到的那个被记住，给后面的事件用。
    for (const path of [
      ["payload", "model"],
      ["payload", "info", "model"],
      ["payload", "turn_context", "model"],
      ["model"],
    ]) {
      let node: unknown = line;
      for (const key of path) node = asRecord(node)?.[key];
      if (typeof node === "string" && node !== "") {
        state.model = node;
        break;
      }
    }
    const payload = asRecord(line.payload);
    if (payload?.type !== "token_count") return;
    // `last_token_usage` 是这一轮的增量；`total_token_usage` 是累计的，用它会把这个
    // 会话的成本乘上它的轮数。
    const info = asRecord(payload.info) ?? payload;
    const last =
      asRecord(info.last_token_usage) ?? asRecord(info.lastTokenUsage);
    if (last === undefined) return;
    const cached =
      number(last.cached_input_tokens) + number(last.cachedInputTokens);
    const rawInput = number(last.input_tokens) + number(last.inputTokens);
    const tokens: TokenTotals = {
      // Codex 把缓存的 token 报在 input **里面**，和 Claude 那边分成两个桶不一样。
      // 减掉它让 input 仍然表示「按输入价计费的那部分」。
      input: Math.max(rawInput - cached, 0),
      output: number(last.output_tokens) + number(last.outputTokens),
      cacheRead: cached,
      cacheCreation: 0,
    };
    if (isEmptyTokens(tokens)) return;
    recordTokens(
      state,
      state.model ?? "unknown",
      line.timestamp,
      tokens,
      context.nowMs,
    );
  },
};

/* --------------------------------- 适配器 --------------------------------- */

export const codexAdapter: HistoryAdapter = {
  agentId: "codex",
  roots,
  locate,
  list: candidates,
  parse: (candidate) => parse(candidate.path),
  readEntries: readLocatedEntries,
  cost: { kind: "jsonl", source: costSource },
};
