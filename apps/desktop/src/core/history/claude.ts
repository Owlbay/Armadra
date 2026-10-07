import { dirname, extname, join, resolve } from "node:path";
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
import { asRecord, duplicate, number } from "./cost-lines";
import { readLocatedEntries, reportedFile } from "./files";
import { configRoot } from "./home";
import type { AgentCostSource, HistoryAdapter, Located } from "./types";

/**
 * Claude Code transcripts — `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*.jsonl`.
 *
 * Ported from the pre-merge implementation. One file per session, named
 * after the session id, inside a directory named after the flattened project
 * path. Sub-agent transcripts live one level deeper and are deliberately *not*
 * indexed: they are not sessions a human resumes.
 *
 * 会话索引的候选与解析、成本来源、转录定位都在这一个适配器里（`claudeAdapter`），
 * 原先分在 `conversations/claude.ts`、`usage/cost-sources.ts` 与
 * `collab/transcript.ts` 三处。
 */

/**
 * Sessions are short JSONL lines and the first user message is at the top, so
 * a small window finds it.
 */
const HEAD_BYTES = 64 * 1024;
const HEAD_LINES = 200;

/**
 * Text the CLI injects on the user's behalf. A slash command, a hook's stdout
 * or a caveat banner is not what the session is *about*, so these are skipped
 * and the next user message is tried instead.
 */
const SYNTHETIC_PREFIXES = [
  "<local-command-caveat>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<command-name>",
  "<command-message>",
  "<task-notification>",
] as const;

/** `<configHome>/projects`；没有家目录也没有覆盖时一个都没有。 */
export function roots(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = configRoot("claude", env);
  return home === undefined ? [] : [join(home, "projects")];
}

/** `<projects>/<project>/<session>.jsonl` and nothing deeper. */
export function candidates(root: string): Candidate[] {
  const base = resolve(root);
  return collect(
    root,
    (path) =>
      extname(path) === ".jsonl" && resolve(dirname(dirname(path))) === base,
  );
}

export function parse(path: string): Parsed | undefined {
  const stem = (basename(path) ?? "").replace(/\.jsonl$/, "");
  if (stem === "") return undefined;
  return parseLines(stem, readLines(path, HEAD_BYTES, HEAD_LINES));
}

/** Split out from {@link parse} so a test can feed it literal lines. */
export function parseLines(
  sessionId: string,
  lines: readonly string[],
): Parsed {
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
    // Every record carries the same `cwd`; the first one that has it wins.
    if (cwd === "" && typeof record.cwd === "string") cwd = record.cwd;
    if (found === "" && record.type === "user") {
      const message = record.message;
      const content =
        message !== null && typeof message === "object"
          ? (message as Record<string, unknown>).content
          : undefined;
      const text = content === undefined ? "" : userText(content);
      const candidate = usable(text);
      if (candidate !== undefined) found = title(candidate);
    }
    if (cwd !== "" && found !== "") break;
  }
  // No fallback here: an empty title is a fact the caller may need — the
  // suggest-title endpoint must not answer with a directory name — and the
  // indexer fills it in itself.
  return { sessionId, title: found, cwd };
}

/**
 * `content` is a plain string for a typed prompt and a block array once
 * attachments or tool results are involved. Only the text blocks matter: a
 * user turn that is nothing but a `tool_result` renders empty and is skipped.
 */
function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block !== null && typeof block === "object"
          ? (block as Record<string, unknown>).text
          : undefined,
      )
      .filter((text): text is string => typeof text === "string")
      .join(" ");
  }
  return "";
}

/** `undefined` when the text is CLI machinery rather than a user message. */
export function usable(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  if (SYNTHETIC_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return undefined;
  }
  return trimmed;
}

/**
 * A session whose first message could not be read still deserves a row: it is
 * resumable, and the directory name is what the user recognises it by.
 */
export function fallbackTitle(cwd: string): string {
  const name = basename(cwd);
  return name === undefined ? "" : title(name);
}

/* ---------------------------------- 成本 ---------------------------------- */

/**
 * 一行**有可能**贡献点什么吗。在字节上判，判错的方向只能是「放过一行其实没用的」：
 * `absorb` 第一件事就是要 `message.usage` 是个对象，没有 `usage` 这个键的行一个
 * token 都出不来。判据是 JSON 里那个键**字面的**样子，见 `codex.ts` 同一处。
 */
const costSource: AgentCostSource = {
  agentId: "claude",
  roots: () => roots(),
  needles: [Buffer.from('"usage"')],
  absorb(state, value, context) {
    const line = asRecord(value);
    const message = asRecord(line?.message);
    const usage = asRecord(message?.usage);
    if (usage === undefined) return;
    // `requestId` 是 CLI 自己的字段；`message.id` 是更老记录的兜底。两个都没有的
    // 行被计入——丢掉它比重复计更常见地少报。
    const identity =
      typeof line?.requestId === "string"
        ? line.requestId
        : typeof message?.id === "string"
          ? message.id
          : undefined;
    if (duplicate(context, identity)) return;
    const tokens: TokenTotals = {
      input: number(usage.input_tokens),
      output: number(usage.output_tokens),
      cacheRead: number(usage.cache_read_input_tokens),
      cacheCreation: number(usage.cache_creation_input_tokens),
    };
    if (isEmptyTokens(tokens)) return;
    const model =
      typeof message?.model === "string" && message.model !== ""
        ? message.model
        : "unknown";
    recordTokens(state, model, line?.timestamp, tokens, context.nowMs);
  },
};

/* --------------------------------- 适配器 --------------------------------- */

export const claudeAdapter: HistoryAdapter = {
  agentId: "claude",
  roots,
  // Claude 的 Hook 每次都报 `transcript_path`；没报的时候没有别的线索可找。
  locate: (hint): Located | undefined => reportedFile(hint.transcriptPath),
  list: candidates,
  parse: (candidate) => parse(candidate.path),
  readEntries: readLocatedEntries,
  cost: { kind: "jsonl", source: costSource },
};
