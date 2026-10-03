import { z } from "zod";

import { agentProbeSchema } from "../agent-capabilities.js";
import { AGENT_CAPABILITIES, AGENT_IDS, PROMPT_MODES } from "../agents.js";
import { agentIdSchema } from "../domain/index.js";
import { agentAcpInfoSchema } from "./acp.js";

/**
 * @deprecated A `LaunchWord` (`shell.ts`) as an older core answered it: a
 * literal value, or a prefix and a variable (`LegacyLaunchWord`). Only for
 * {@link agentInfoSchema}'s deprecated `launchWords`.
 */
export const launchWordSchema = z.union([
  z.string(),
  z.object({ prefix: z.string(), env: z.string() }),
]);

/** One of `history.index` / `cost` / `transcript` (contract §12.2). */
export const HISTORY_STATES = [
  "available",
  "not-found",
  "unsupported",
  "disabled",
] as const;
export const historyStateSchema = z.enum(HISTORY_STATES);
export type HistoryState = z.infer<typeof historyStateSchema>;

export const agentHistorySchema = z.object({
  index: historyStateSchema,
  cost: historyStateSchema,
  transcript: historyStateSchema,
});
export type AgentHistory = z.infer<typeof agentHistorySchema>;

/**
 * An execution host whose Worker is older than this build expects (contract
 * §21.2): canvas launches there carry a stale injection until it is resynced.
 * Reported on the integration state (`GET /api/agents/{id}/integration`)
 * only — the hosts are the same for every agent, so the agent rows do not
 * repeat them.
 */
export const outdatedHostSchema = z.looseObject({
  hostId: z.string().min(1),
  /** The host's name in the registry, when it is still there. */
  name: z.string().optional(),
  /** The Worker version the host reported, when it reported one. */
  version: z.string().optional(),
});
export type OutdatedHost = z.infer<typeof outdatedHostSchema>;

/** `GET /api/agents` — registry entry plus local detection. */
export const agentInfoSchema = z.object({
  id: agentIdSchema,
  label: z.string(),
  color: z.string(),
  launchCmd: z.string(),
  promptMode: z.enum(PROMPT_MODES),
  capabilities: z.array(z.enum(AGENT_CAPABILITIES)).default([]),
  /** Extra argv the launch line appends; always empty for a built-in agent. */
  args: z.array(z.string()).default([]),
  /**
   * The built-in agent a `custom:` entry borrows its hooks, prompt mode and
   * permission flags from (plan §24.1). Absent on the built-ins themselves.
   */
  baseAgent: z.enum(AGENT_IDS).optional(),
  /** Absolute path the launch program resolves to, or null. */
  resolvedPath: z.string().nullable().default(null),
  /** The launch program exists on the augmented PATH. */
  installed: z.boolean(),
  /**
   * What to start instead of `resolvedPath` when that is an npm / pnpm
   * wrapper on Windows (`claude.cmd`): the program behind it and the words
   * that go in front of the CLI's own (`node.exe <cli.js>`). A batch wrapper
   * has `cmd.exe` read every argument again, which no quoting survives.
   * Absent when the path is the program itself or the wrapper was not read.
   */
  launchTarget: z
    .object({ program: z.string(), args: z.array(z.string()) })
    .optional(),
  /** Revision of the installed hook client, absent when hooks are not installed. */
  clientRevision: z.number().int().nonnegative().nullish(),
  /**
   * Revision of the installed collaboration skill, absent when the skill is not
   * installed. It is read from the file on disk rather than from a row, so a
   * user who deletes the skill by hand sees that here on the next refresh.
   */
  skillsRevision: z.number().int().nonnegative().nullish(),
  /**
   * Cached `--version` probe (`agent-capabilities.ts`). Absent means the CLI
   * has not been probed yet, which resolves gated capabilities to `unknown` —
   * never to supported.
   */
  probe: agentProbeSchema.nullish(),
  /**
   * The canvas launcher on the core's machine (docs/design/canvas-launcher.md
   * §8.1): `run/<cli>` in its data directory, `run\<cli>.exe` on Windows. A
   * canvas launch line starts it with the CLI's program, the words that go in
   * front of the CLI's own and the CLI's flags as its arguments; the launcher
   * appends the injection (hooks, skill, canvas instructions) and sets the
   * injected environment for the CLI process only, and only inside a canvas
   * node (`ARMADRA_NODE_ID` set). A `custom:` entry answers its base CLI's.
   *
   * Absent when there is no current launcher — not written yet, no data
   * directory, Windows without `armadra-launch.exe` — and from an older core:
   * the line is then bare (or, for an older core, built from the deprecated
   * fields below).
   */
  launcher: z.string().optional(),
  /**
   * @deprecated An older core's injection argv, appended to the typed line.
   * A current core answers {@link launcher} instead and no longer sends this;
   * the page reads it only as the fallback for that older core (§8.1), kept
   * one release. The argv itself is in `GET /api/agents/{id}/integration`.
   */
  launchArgs: z.array(z.string()).optional(),
  /**
   * @deprecated An older core's injection as typed words, Codex's naming
   * environment variables its node terminal carried. Same fallback as
   * {@link launchArgs}; a current core never sends it.
   */
  launchWords: z.array(launchWordSchema).optional(),
  /**
   * Whether this machine has the CLI's local history (contract §12.2): the
   * session index, local cost, and transcripts read over a link. Optional
   * because a runtime that predates the field simply does not say.
   */
  history: agentHistorySchema.optional(),
  /**
   * How this CLI speaks the Agent Client Protocol on this machine (contract
   * §14.1). Absent from a core without ACP, and for an agent without a path.
   */
  acp: agentAcpInfoSchema.optional(),
});

export const agentListSchema = z.array(agentInfoSchema);

/**
 * `GET /api/agents/{id}/models` — 节点头部「模型」菜单的候选（用户实测反馈 F7）。
 *
 * `source` 说的是这一条**从哪来**，因为三种来源不是一回事：
 *
 *   * `cli` —— CLI 自己说的（`claude --help` 的别名、Codex `config.toml` 里
 *     配好的模型）。它反映的是这台机器、这个账号的实际情况，所以排在最前；
 *   * `catalog` —— models.dev 上该 provider 的条目，按发布日期倒序；
 *   * `builtin` —— 离线兜底，只在前两者都拿不到时出现。
 *
 * 没有 `releaseDate` 的条目排在有日期的之前：别名永远指向该系列的最新模型，
 * 不可能比下面任何一条更旧，而且那是 CLI 自己文档里的写法。
 */
export const agentModelSourceSchema = z.enum(["cli", "catalog", "builtin"]);
export type AgentModelSource = z.infer<typeof agentModelSourceSchema>;

export const agentModelSchema = z.object({
  /** 原样放到启动行 `--model` 后面的值。 */
  id: z.string().min(1),
  label: z.string(),
  source: agentModelSourceSchema,
  /** `YYYY-MM-DD`，目录里有才有。 */
  releaseDate: z.string().optional(),
});
export type AgentModel = z.infer<typeof agentModelSchema>;

export const agentModelListSchema = z.array(agentModelSchema);

/**
 * How a provider's integration reaches its CLI.
 *
 * `canvas` is the only mode a current core answers
 * (docs/design/canvas-only-integration.md): hook, skill and canvas
 * instructions are handed over on the launch line of a canvas node and nowhere
 * else. The older three stay parseable so a page talking to an older core
 * still draws its rows.
 */
export const INJECTION_MODES = [
  "canvas",
  "launch",
  "file",
  "extension",
] as const;

/** One half of an install unit — the adapter, or the skill. */
export const integrationHalfSchema = z.object({
  installed: z.boolean(),
  /** Where it lives. Present even when it is not installed: the answer to
   * "why is this not on" is usually "look here". */
  path: z.string().optional(),
  /** The revision on disk; `0` when this half is not installed. */
  revision: z.number().int().nonnegative().default(0),
});

/** Something an earlier product name left behind (设计 §4). */
export const legacyIntegrationFindingSchema = z.object({
  /** `hook_entry` / `skill_dir` / `codex_unknown_key` / `status_line` / `instruction_block`. */
  kind: z.string(),
  path: z.string(),
  /** The command, key or directory name, so a person can recognise their own. */
  detail: z.string(),
});

/**
 * `GET /api/agents/{id}/integration`, and what install / uninstall answer with
 * (docs/design/agent-integration.md §5).
 *
 * Hook and skill are **one** install unit with one state: before this, a CLI
 * had two switches and three ways to be half-integrated, and no single screen
 * could say which. `revision` is what a fresh install writes — the hook
 * revision and the skill revision folded together — and `stale` is the only
 * question the page has to ask about it.
 *
 * Loose on purpose: the runtime omits what is empty and adds fields faster than
 * the settings page reads them.
 */
export const integrationStateSchema = z.looseObject({
  agentId: agentIdSchema,
  mode: z.enum(INJECTION_MODES),
  hook: integrationHalfSchema,
  skill: integrationHalfSchema,
  legacy: z.object({
    found: z.array(legacyIntegrationFindingSchema).default([]),
  }),
  revision: z.number().int().nonnegative(),
  /** What the files on disk were written by; absent when nothing is installed. */
  installedRevision: z.number().int().nonnegative().optional(),
  stale: z.boolean().default(false),
  /**
   * Argv the launcher appends to a canvas launch of this agent, literal — for
   * display and for a probe that execs the CLI itself. Empty for an
   * integration that is not written.
   */
  launchArgs: z.array(z.string()).default([]),
  /** Names of the environment variables the launcher sets for the CLI. */
  launchEnv: z.array(z.string()).default([]),
  /**
   * @deprecated Files outside the data directory this integration writes:
   * none any more (docs/design/canvas-launcher.md §8.2), always `[]` from a
   * current core. Kept one release for an older core, which listed Codex's
   * `config.toml` here for its hook trust records.
   */
  globalWrites: z.array(z.string()).default([]),
  /** `run/<cli>` on the core's machine, when it is there and current. */
  launcher: z.string().optional(),
  /** `shims/<cli>` on the core's machine, when it is there. */
  shim: z.string().optional(),
  /**
   * Why canvas launches of this agent carry less than they should: no
   * launcher on Windows (`armadra-launch.exe` missing), or a Codex too old
   * for hooks without persisted trust.
   */
  launcherWarning: z.string().optional(),
  /** What the one-time move away from the old global install did here. */
  migration: z
    .object({
      migratedAt: z.string(),
      removed: z.array(z.string()).default([]),
      backups: z.array(z.string()).default([]),
      error: z.string().optional(),
      /**
       * Codex only: the session-flag trust records (`/<session-flags>/…`) the
       * migration's second step took out of `~/.codex/config.toml`.
       */
      sessionTrust: z
        .object({
          at: z.string(),
          removed: z.array(z.string()).default([]),
          backup: z.string().optional(),
          error: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  clientBin: z.string().optional(),
  /**
   * Execution hosts whose Worker needs an upgrade and a resync (contract
   * §21.2). Present from a core with the Worker fleet; usually empty.
   */
  outdatedHosts: z.array(outdatedHostSchema).optional(),
  /** Something worked but deserves a sentence in the settings page. */
  warning: z.string().optional(),
});

/**
 * `POST /api/agents/{id}/integration/repair` — what the pass actually did.
 *
 * `kept` is the point of the report: everything this repair recognised as not
 * ours and wrote back exactly as it read it.
 */
export const integrationRepairReportSchema = z.looseObject({
  agentId: agentIdSchema,
  found: z.array(legacyIntegrationFindingSchema).default([]),
  removed: z.array(z.string()).default([]),
  kept: z.array(z.string()).default([]),
  /** The newest backup, for the sentence the settings page shows. */
  backup: z.string().optional(),
  backups: z.array(z.string()).default([]),
});

export const answerApprovalRequestSchema = z.object({
  decision: z.enum(["allow", "deny"]),
  /** An ACP approval's chosen option (contract §14.4). */
  optionId: z.string().optional(),
});

/**
 * `POST /api/approvals/{pendingId}/answer` — the approval row as recorded
 * (`core/agent/approvals.ts::AgentApproval`) plus how the decision reached the
 * CLI: `file` (the waiting hook client read it), `keys` (typed into the PTY) or
 * `none`.
 */
export const answerApprovalResponseSchema = z.looseObject({
  id: z.string(),
  nodeId: z.string(),
  answer: z.enum(["allow", "deny"]),
  answeredAt: z.string().datetime({ offset: true }),
  revision: z.number(),
  /** `acp`: answered on the pending `session/request_permission`. */
  route: z.enum(["file", "keys", "none", "acp"]),
});

/**
 * `POST /api/agent-status/{nodeId}/suggest-title` — the header's ✦ button.
 *
 * `source` says where the sentence came from so the UI can be honest when the
 * answer is only the agent's name: `transcript` (first user message),
 * `terminal` (last command in the pane) or `agent` (the label, nothing better
 * was available).
 */
export const suggestTitleResponseSchema = z.object({
  title: z.string().min(1).max(40),
  source: z.enum(["transcript", "terminal", "agent"]),
});

/**
 * `GET /api/agent-status/{nodeId}/transcript` — the node's own conversation,
 * one prose line per message.
 *
 * `truncated` is a field rather than an ellipsis in the text because a cut-off
 * conversation read as a whole one is a wrong answer, not a short one. A
 * provider that keeps nothing readable answers 501 with a reason, so an empty
 * `text` here never stands for "this CLI has no transcript".
 */
export const agentTranscriptSchema = z.object({
  nodeId: z.string().max(160),
  text: z.string(),
  truncated: z.boolean(),
});

/**
 * What a linked whiteboard shape reads as (docs/design/canvas-react-flow.md
 * §2.5). Only present when `kind === "shape"`: text items carry their text,
 * everything else is rasterised by the client and referenced by a
 * workspace-relative PNG path.
 */
export const contextLinkContentSchema = z.object({
  /** Render status is explicit: a visible link need not have a ready image. */
  status: z.enum(["pending", "ready", "error"]).optional(),
  sourceShapeId: z.string().max(160).optional(),
  shapeType: z.string().max(40).optional(),
  textTruncated: z.boolean().optional(),
  text: z.string().max(20_000).optional(),
  pngPath: z.string().max(4_000).optional(),
});

export const contextLinkSchema = z.object({
  /** Node id, or the uuid of the whiteboard item behind a `shape` link. */
  id: z.string().uuid(),
  title: z.string().max(160),
  /**
   * A node type, or `"shape"` for whiteboard content
   * (docs/design/canvas-react-flow.md §2.5).
   */
  kind: z.string().max(40),
  content: contextLinkContentSchema.optional(),
});

export type SuggestTitleResponse = z.infer<typeof suggestTitleResponseSchema>;
export type AgentTranscript = z.infer<typeof agentTranscriptSchema>;
export type AgentInfo = z.infer<typeof agentInfoSchema>;
export type InjectionMode = (typeof INJECTION_MODES)[number];
export type IntegrationHalf = z.infer<typeof integrationHalfSchema>;
export type LegacyIntegrationFinding = z.infer<
  typeof legacyIntegrationFindingSchema
>;
export type IntegrationState = z.infer<typeof integrationStateSchema>;
export type IntegrationRepairReport = z.infer<
  typeof integrationRepairReportSchema
>;
export type AnswerApprovalRequest = z.infer<typeof answerApprovalRequestSchema>;
export type ContextLink = z.infer<typeof contextLinkSchema>;
export type ContextLinkContent = z.infer<typeof contextLinkContentSchema>;
