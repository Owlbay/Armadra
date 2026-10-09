/**
 * The status half of the Claude Code mod (contract §57, docs/design/claude-mods.md §3):
 * every classic hook event the settings file used to carry, PermissionRequest
 * excepted, forwarded unchanged; and the node's name in the status line.
 *
 * PermissionRequest stays a settings hook (`settings-permission.json`): it
 * waits for a person on the canvas, longer than a mod hook's budget, and a
 * mod must never be the one that answers a permission prompt.
 *
 * `classic.PreToolUse` alone is not the stdin shape: its `e` is the tool-call
 * envelope (`{ tool, tool_use_id, ...input }`), so it is rebuilt into the
 * fields `normalize/claude.ts` reads, with the session fields the last other
 * classic event carried.
 *
 * Text for `template.ts`; see `transport.ts` for the rules it is written by.
 */
export const STATUS_DECLARATIONS = String.raw`
// Whether a person is at this session's prompt: the status line is drawn
// only there (not for claude -p, not under an SDK host).
let armadraInteractive = false;
// session_id, transcript_path, cwd and permission_mode as the last classic
// event carried them: what the PreToolUse envelope lacks.
let armadraBase: Record<string, unknown> = {};

async function armadraProfile($: EngineInterface): Promise<string> {
  return (await $.env.get("ARMADRA_MOD_PROFILE")) ?? "terminal";
}

function armadraRemember(e: unknown): void {
  if (typeof e !== "object" || e === null) return;
  const fields = e as Record<string, unknown>;
  const base: Record<string, unknown> = {};
  for (const key of ["session_id", "transcript_path", "cwd", "permission_mode"]) {
    if (typeof fields[key] === "string") base[key] = fields[key];
  }
  if (typeof base.session_id === "string") armadraBase = base;
}

function armadraPreToolUse(e: unknown): Record<string, unknown> {
  const fields = typeof e === "object" && e !== null ? { ...(e as Record<string, unknown>) } : {};
  const tool = fields.tool;
  const toolUseId = fields.tool_use_id;
  delete fields.tool;
  delete fields.tool_use_id;
  delete fields.agentId;
  return {
    ...armadraBase,
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: fields,
    ...(toolUseId === undefined ? {} : { tool_use_id: toolUseId }),
  };
}

// Under ACP (profile acp) the session's state is the ACP session's to write;
// a second writer for the same node is what the profile is there to prevent.
async function armadraForward($: EngineInterface, payload: unknown): Promise<void> {
  try {
    if ((await armadraProfile($)) === "acp") return;
    await armadraReport($, payload);
  } catch {
    // Best effort, as every report.
  }
}

// The node's name, nothing else: a name has no language. No name, no line.
async function armadraStatus($: EngineInterface): Promise<void> {
  try {
    if (!armadraInteractive) return;
    if (!armadraIsId(await $.env.get("ARMADRA_NODE_ID"))) return;
    if ((await armadraProfile($)) === "acp") return;
    const name = ((await $.env.get("ARMADRA_NODE_NAME")) ?? "").trim();
    $.ui.status(name === "" ? undefined : name);
  } catch {
    // A status line is a nicety.
  }
}

async function armadraStart($: EngineInterface, e: SessionStartInput): Promise<void> {
  try {
    if (!armadraIsId(await $.env.get("ARMADRA_NODE_ID"))) return;
    armadraInteractive = e.surface === "terminal" && e.isInteractive;
    const version = await $.session.version();
    armadraHelloBody = {
      engine: "claude",
      version: version.version,
      base: version.base ?? null,
      surface: e.surface,
      isInteractive: e.isInteractive,
      profile: await armadraProfile($),
      modRevision: ARMADRA_MOD_REVISION,
    };
    await armadraStatus($);
    await armadraHello($, undefined);
  } catch {
    // Without a hello the settings page says this session did not report.
  }
}
`;

/**
 * The registrations, one literal `on(...)` per event so `claude plugin
 * validate` reads them. Each passes its event on unchanged and at once
 * (`void`): a report never holds a tool call or a turn. SessionEnd alone
 * waits, at most 800 ms, because the process is on its way out. A hook that
 * throws anyway is answered by its `.catch`, which passes the event on.
 */
export const STATUS_REGISTRATIONS = String.raw`
  on("session.start", async ($, e, next) => {
    void armadraStart($, e);
    return next(e);
  });
  on("classic.SessionStart", async ($, e, next) => {
    armadraRemember(e);
    void armadraForward($, e);
    void armadraStatus($);
    return next(e);
  }).catch(($, e, next) => next(e));
  on("classic.UserPromptSubmit", async ($, e, next) => {
    armadraRemember(e);
    void armadraForward($, e);
    return next(e);
  }).catch(($, e, next) => next(e));
  on("classic.PreToolUse", async ($, e, next) => {
    void armadraForward($, armadraPreToolUse(e));
    return next(e);
  }).catch(($, e, next) => next(e));
  on("classic.PostToolUse", async ($, e, next) => {
    armadraRemember(e);
    void armadraForward($, e);
    return next(e);
  }).catch(($, e, next) => next(e));
  on("classic.Notification", async ($, e, next) => {
    armadraRemember(e);
    void armadraForward($, e);
    return next(e);
  }).catch(($, e, next) => next(e));
  on("classic.Stop", async ($, e, next) => {
    armadraRemember(e);
    void armadraForward($, e);
    return next(e);
  }).catch(($, e, next) => next(e));
  on("classic.StopFailure", async ($, e, next) => {
    armadraRemember(e);
    void armadraForward($, e);
    return next(e);
  }).catch(($, e, next) => next(e));
  on("classic.SubagentStart", async ($, e, next) => {
    void armadraForward($, e);
    return next(e);
  }).catch(($, e, next) => next(e));
  on("classic.SubagentStop", async ($, e, next) => {
    void armadraForward($, e);
    return next(e);
  }).catch(($, e, next) => next(e));
  on("classic.SessionEnd", async ($, e, next) => {
    await armadraWithin($, armadraForward($, e), 800);
    return next(e);
  }).catch(($, e, next) => next(e));
`;

/** The classic events the mod forwards: the settings hooks', PermissionRequest excepted. */
export const MOD_CLASSIC_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "SessionEnd",
] as const;
