import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { baseAgent } from "./registry";
import { agentIdOf, loadNode, loadSession } from "../collab/nodes";
import type { CollabContext } from "../collab/service";
import { conflict, badRequest, notFound, rfc3339 } from "../workspaces/support";
import { getAgentStatus } from "./status";
import { checkElicitationAnswer, elicitationOf } from "../acp/elicitation";
import type { AcpElicitationResult } from "../acp/types";

/**
 * Permission answers — the round trip closed by an answer file, and the CAS
 * that makes it singular.
 *
 * Carried over from the pre-merge implementation, with the cross-device rule
 * the former Go Host added on top.
 *
 * **The order is the design.** A CLI that asks for permission stops: it is
 * blocked on a read of a file this process will write. Everything here exists
 * so the answer can be given from somewhere other than this machine — a phone,
 * a second laptop — and given exactly once. So the decision is recorded
 * *first*, under a revision CAS, and only then is the machine told:
 *
 *   * Recording first is what makes "answered exactly once" true. Two devices
 *     that both read a pending approval both try to write revision 1, and the
 *     second is refused before any file is touched. Asking the machine first
 *     would let both writes land and leave the record describing whichever
 *     returned last.
 *   * A failure after the record is honest rather than lost. Somebody did
 *     answer; what failed is that the machine did not hear, and that is a
 *     state a person can act on.
 *
 * Every attempt — the winner and the loser — is written to
 * `agent_approval_audit`. Keeping only the winner would throw away the whole
 * value of the mutual exclusion: which device asked, in which order, and what
 * the loser was told.
 */

/** Pending files older than this are the remains of a client that went away. */
export const ORPHAN_MINUTES = 10;
/** `ARMADRA_PERM_WAIT_SECS` for a CLI that supports hook replies. */
export const PERM_WAIT_SECONDS = 45;

export const DECISIONS = ["allow", "deny"] as const;

/**
 * How a decision reached the CLI: an answer file the hook client was polling
 * for, keys typed into the PTY, the pending `session/request_permission` of an
 * ACP session (ACP 会话视图设计 §5.5), or nothing.
 */
export type ApprovalRoute = "file" | "keys" | "acp" | "none";

/**
 * The ACP half of the answer: the core's ACP domain registers it
 * (`core/acp/index.ts`) and it answers the pending request with this option.
 * `false` when no live session holds that request any more.
 */
export type AcpApprovalAnswerer = (
  approval: AgentApproval,
  optionId: string,
) => boolean;

let acpAnswerer: AcpApprovalAnswerer | undefined;

export function setAcpApprovalAnswerer(
  answerer: AcpApprovalAnswerer | undefined,
): void {
  acpAnswerer = answerer;
}

/**
 * The elicitation half (contract §26.1): the ACP domain registers it and it
 * hands the checked answer to the pending `elicitation/create`. `false` when no
 * live session holds that request any more.
 */
export type AcpElicitationAnswerer = (
  approval: AgentApproval,
  result: AcpElicitationResult,
) => boolean;

let elicitationAnswerer: AcpElicitationAnswerer | undefined;

export function setAcpElicitationAnswerer(
  answerer: AcpElicitationAnswerer | undefined,
): void {
  elicitationAnswerer = answerer;
}

/** One option of an ACP permission request, as stored in `request_json`. */
export interface AcpApprovalOption {
  readonly optionId: string;
  readonly kind: string;
}

/** The options of an ACP approval; `undefined` for any other approval. */
export function acpOptionsOf(
  request: unknown,
): readonly AcpApprovalOption[] | undefined {
  if (typeof request !== "object" || request === null) return undefined;
  const raw = request as { protocol?: unknown; options?: unknown };
  if (raw.protocol !== "acp" || !Array.isArray(raw.options)) return undefined;
  return raw.options.filter(
    (option): option is AcpApprovalOption =>
      typeof option === "object" &&
      option !== null &&
      typeof (option as AcpApprovalOption).optionId === "string" &&
      typeof (option as AcpApprovalOption).kind === "string",
  );
}

/**
 * The option an ACP answer selects. An explicit `optionId` must be one of the
 * agent's and agree with the decision (`allow_*` for allow, `reject_*` for
 * deny); without one, the first option of the decision's kind — the header's
 * allow / deny buttons. `undefined`: nothing fits.
 */
export function acpOptionFor(
  options: readonly AcpApprovalOption[],
  decision: string,
  optionId: string | undefined,
): AcpApprovalOption | undefined {
  const prefix = decision === "allow" ? "allow_" : "reject_";
  if (optionId !== undefined) {
    const chosen = options.find((option) => option.optionId === optionId);
    return chosen?.kind.startsWith(prefix) === true ? chosen : undefined;
  }
  return options.find((option) => option.kind.startsWith(prefix));
}

export interface AgentApproval {
  readonly id: string;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly request: unknown;
  readonly answer: string | null;
  readonly answeredBy: string | null;
  readonly createdAt: string;
  readonly answeredAt: string | null;
  /** The CAS column. 0 means nothing has answered it yet. */
  readonly revision: number;
}

interface ApprovalRow {
  readonly id: string;
  readonly node_id: string;
  readonly workspace_id: string;
  readonly request_json: string;
  readonly answer: string | null;
  readonly answered_by: string | null;
  readonly created_at: string;
  readonly answered_at: string | null;
  readonly revision: number;
}

const SELECT =
  "SELECT id, node_id, workspace_id, request_json, answer, answered_by, " +
  "created_at, answered_at, revision FROM agent_approvals ";

function approvalOf(row: ApprovalRow): AgentApproval {
  let request: unknown = null;
  try {
    request = JSON.parse(row.request_json);
  } catch {
    request = null;
  }
  return {
    id: row.id,
    nodeId: row.node_id,
    workspaceId: row.workspace_id,
    request,
    answer: row.answer,
    answeredBy: row.answered_by,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
    revision: Number(row.revision),
  };
}

export function getApproval(
  context: CollabContext,
  pendingId: string,
): AgentApproval {
  const row = context.database
    .prepare(`${SELECT}WHERE id = ?`)
    .get(pendingId) as ApprovalRow | undefined;
  if (row === undefined) throw notFound("Approval request was not found");
  return approvalOf(row);
}

export function insertApproval(
  context: CollabContext,
  options: {
    readonly pendingId: string;
    readonly nodeId: string;
    readonly workspaceId: string;
    readonly request: unknown;
    readonly sessionId?: string;
    readonly generation?: number;
  },
): AgentApproval {
  context.database
    .prepare(
      "INSERT INTO agent_approvals (id, node_id, workspace_id, request_json, created_at, session_id, generation) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    )
    .run(
      options.pendingId,
      options.nodeId,
      options.workspaceId,
      JSON.stringify(options.request ?? null),
      rfc3339(),
      options.sessionId ?? null,
      options.generation ?? 0,
    );
  return getApproval(context, options.pendingId);
}

export interface AnswerRequest {
  /**
   * `allow` / `deny`. May be left out when {@link elicitation} is given: an
   * elicitation's decision follows from its action (`accept` → allow,
   * `decline` / `cancel` → deny).
   */
  readonly decision?: string;
  /** Who answered. The local user is `user`; a peer device is its principal. */
  readonly answeredBy?: string;
  /**
   * The revision the caller read. `undefined` means "whatever is current",
   * which is what a single-device answer means — the CAS still refuses a
   * second answer, because an answered row is not open to being answered.
   */
  readonly expectedRevision?: number;
  /** An ACP approval's chosen option (contract §14.4). */
  readonly optionId?: string;
  /**
   * The answer to an ACP `elicitation/create` (contract §26.1). The content is
   * checked against the request's own schema and goes to the agent only: it
   * is never stored, audited, logged or published.
   */
  readonly elicitation?: {
    readonly action: unknown;
    readonly content?: unknown;
  };
}

export interface AnswerResult {
  readonly approval: AgentApproval;
  readonly route: ApprovalRoute;
  /** The action an elicitation was answered with (never its content). */
  readonly elicitation?: { readonly action: string };
}

/**
 * An elicitation answer, settled before anything is recorded: the decision it
 * implies and what goes to the agent. `undefined` for any other approval.
 */
function elicitationAnswer(
  existing: AgentApproval,
  request: AnswerRequest,
):
  | {
      readonly ok: true;
      readonly decision: string;
      readonly result: AcpElicitationResult;
    }
  | { readonly ok: false; readonly message: string }
  | undefined {
  const stored = elicitationOf(existing.request);
  if (stored === undefined) {
    return request.elicitation === undefined
      ? undefined
      : {
          ok: false,
          message: "elicitation is only for ACP elicitation requests",
        };
  }
  // The header's allow / deny buttons work too: deny declines, allow accepts
  // an empty form (which only passes when nothing is required).
  const answer =
    request.elicitation ??
    (request.decision === "allow"
      ? { action: "accept" }
      : request.decision === "deny"
        ? { action: "decline" }
        : undefined);
  if (answer === undefined) {
    return { ok: false, message: "Approval decision must be allow or deny" };
  }
  const checked = checkElicitationAnswer(stored, answer);
  if (!checked.ok) return checked;
  const decision = checked.result.action === "accept" ? "allow" : "deny";
  if (request.decision !== undefined && request.decision !== decision) {
    return {
      ok: false,
      message: `decision ${request.decision} does not match action ${checked.result.action}`,
    };
  }
  return { ok: true, decision, result: checked.result };
}

/**
 * Records the user's decision and gets it back to the waiting CLI.
 *
 * Two routes out. When the hook client wrote `<data>/pending/<id>.json` and is
 * polling, an answer file is the deterministic path: the CLI receives the
 * decision through its own hook protocol. Otherwise the answer is typed into
 * the PTY the way a human would press the key, which depends on the prompt
 * still being on screen and is therefore reported as `route: "keys"`.
 */
export async function answerApproval(
  context: CollabContext,
  pendingId: string,
  request: AnswerRequest,
): Promise<AnswerResult> {
  if (!validPendingId(pendingId)) {
    throw badRequest("Approval id is invalid");
  }
  const answeredBy = request.answeredBy ?? "user";
  // An elicitation is settled first: its decision follows from its action.
  const asked = getApproval(context, pendingId);
  const elicitation = elicitationAnswer(asked, request);
  if (elicitation !== undefined && !elicitation.ok) {
    const answered = asked.answer !== null;
    audit(context, asked, {
      decision: request.decision ?? "",
      answeredBy,
      expectedRevision: request.expectedRevision ?? asked.revision,
      accepted: false,
      route: "",
      refusal: answered ? "already_answered" : "elicitation_invalid",
    });
    if (answered) throw conflict("Approval request was already answered");
    throw badRequest(elicitation.message);
  }
  const decision =
    elicitation?.ok === true ? elicitation.decision : (request.decision ?? "");
  if (!(DECISIONS as readonly string[]).includes(decision)) {
    // Audited even though nothing could have been written: a device sending a
    // decision this build does not know is worth seeing in the trail.
    const existing = getApproval(context, pendingId);
    audit(context, existing, {
      decision,
      answeredBy,
      expectedRevision: request.expectedRevision ?? existing.revision,
      accepted: false,
      route: "",
      refusal: "decision_invalid",
    });
    throw badRequest("Approval decision must be allow or deny");
  }

  const existing = getApproval(context, pendingId);
  const expected = request.expectedRevision ?? existing.revision;

  // An ACP request is answered with one of the agent's own options. Checked
  // before the CAS: a choice that cannot be delivered is not a decision.
  const acpOptions = acpOptionsOf(existing.request);
  const acpOption =
    acpOptions === undefined
      ? undefined
      : acpOptionFor(acpOptions, decision, request.optionId);
  if (
    existing.answer === null &&
    ((acpOptions !== undefined && acpOption === undefined) ||
      (acpOptions === undefined && request.optionId !== undefined))
  ) {
    audit(context, existing, {
      decision,
      answeredBy,
      expectedRevision: expected,
      accepted: false,
      route: "",
      refusal: "option_invalid",
    });
    throw badRequest(
      acpOptions === undefined
        ? "optionId is only for ACP approvals"
        : "optionId is not one of the agent's options for this decision",
    );
  }

  // A question somebody has already decided is not one to decide again.
  // Reloading would not produce a state in which answering is right, so this
  // is its own refusal rather than a revision conflict.
  if (existing.answer !== null) {
    audit(context, existing, {
      decision,
      answeredBy,
      expectedRevision: expected,
      accepted: false,
      route: "",
      refusal: "already_answered",
    });
    throw conflict("Approval request was already answered");
  }

  const next = existing.revision + 1;
  const updated = context.database
    .prepare(
      "UPDATE agent_approvals SET answer = ?, answered_by = ?, answered_at = ?, revision = ? " +
        "WHERE id = ? AND answer IS NULL AND revision = ?",
    )
    .run(decision, answeredBy, rfc3339(), next, pendingId, expected);
  if (Number(updated.changes) === 0) {
    // Somebody else got there between the read and the write. This is the
    // whole point of the column: the loser never touches a file.
    audit(context, existing, {
      decision,
      answeredBy,
      expectedRevision: expected,
      accepted: false,
      route: "",
      refusal: "revision_conflict",
    });
    throw conflict("Approval request was already answered");
  }

  const approval = getApproval(context, pendingId);

  // The decision is recorded. Telling the machine is a separate step, and its
  // failure is reported as itself: the answer stands, and what could not
  // happen is the CLI hearing it.
  let route: ApprovalRoute = "none";
  if (elicitation?.ok === true) {
    // ACP elicitation: the checked answer goes to the pending request.
    if (elicitationAnswerer?.(approval, elicitation.result) === true) {
      route = "acp";
    }
  } else if (acpOption !== undefined) {
    // ACP: the answer goes to the pending `session/request_permission`. Never
    // typed into anything — an ACP session has no prompt to type at.
    if (acpAnswerer?.(approval, acpOption.optionId) === true) route = "acp";
  } else if (writeAnswerFile(pendingDir(context), pendingId, decision)) {
    route = "file";
  } else if (await typeIntoPty(context, approval, decision)) {
    route = "keys";
  }

  audit(context, approval, {
    decision,
    answeredBy,
    expectedRevision: expected,
    applied: next,
    accepted: true,
    route,
    refusal: "",
  });

  const action =
    elicitation?.ok === true
      ? { action: elicitation.result.action }
      : undefined;
  context.publish(approval.workspaceId, {
    type: "agent.approval",
    nodeId: approval.nodeId,
    pendingId: approval.id,
    // Resolution reuses the event: `request.resolved` tells a client this is
    // the answer rather than a new question.
    request: resolvedPayload(approval, decision, route, action),
  });
  return {
    approval,
    route,
    ...(action === undefined ? {} : { elicitation: action }),
  };
}

function resolvedPayload(
  approval: AgentApproval,
  decision: string,
  route: ApprovalRoute,
  elicitation?: { readonly action: string },
): Record<string, unknown> {
  return {
    ...approval,
    resolved: true,
    decision,
    answer: decision,
    route,
    ...(elicitation === undefined ? {} : { elicitation }),
  };
}

/**
 * Closes an approval nobody answered: an ACP request withdrawn because its turn
 * was cancelled, the adapter exited, the node switched driver or hibernated
 * (ACP 会话视图设计 §5.5 第 4 条). Recorded as `cancelled` by `core`, audited
 * like any other attempt, and published as a resolution so every header drops
 * its buttons. An approval somebody already answered is left alone.
 */
export function cancelOpenApproval(
  context: Pick<CollabContext, "database" | "publish">,
  pendingId: string,
): AgentApproval | undefined {
  const row = context.database
    .prepare(`${SELECT}WHERE id = ?`)
    .get(pendingId) as ApprovalRow | undefined;
  if (row === undefined || row.answer !== null) return undefined;
  const existing = approvalOf(row);
  const next = existing.revision + 1;
  const updated = context.database
    .prepare(
      "UPDATE agent_approvals SET answer = 'cancelled', answered_by = 'core', answered_at = ?, revision = ? " +
        "WHERE id = ? AND answer IS NULL AND revision = ?",
    )
    .run(rfc3339(), next, pendingId, existing.revision);
  if (Number(updated.changes) === 0) return undefined;
  const approval = approvalOf(
    context.database
      .prepare(`${SELECT}WHERE id = ?`)
      .get(pendingId) as unknown as ApprovalRow,
  );
  audit(context, approval, {
    decision: "cancelled",
    answeredBy: "core",
    expectedRevision: existing.revision,
    applied: next,
    accepted: true,
    route: "acp",
    refusal: "",
  });
  context.publish(approval.workspaceId, {
    type: "agent.approval",
    nodeId: approval.nodeId,
    pendingId: approval.id,
    request: resolvedPayload(approval, "cancelled", "acp"),
  });
  return approval;
}

/* ---------------------------------- audit --------------------------------- */

export interface AuditEntry {
  readonly decision: string;
  readonly answeredBy: string;
  readonly expectedRevision: number;
  readonly applied?: number;
  readonly accepted: boolean;
  readonly route: string;
  readonly refusal: string;
}

function audit(
  context: Pick<CollabContext, "database">,
  approval: AgentApproval,
  entry: AuditEntry,
): void {
  context.database
    .prepare(
      "INSERT INTO agent_approval_audit (approval_id, node_id, workspace_id, decision, answered_by, " +
        "expected_revision, applied_revision, accepted, route, refusal, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      approval.id,
      approval.nodeId,
      approval.workspaceId,
      entry.decision,
      entry.answeredBy,
      entry.expectedRevision,
      entry.applied ?? null,
      entry.accepted ? 1 : 0,
      entry.route,
      entry.refusal,
      rfc3339(),
    );
}

export interface AuditRow {
  readonly approvalId: string;
  readonly decision: string;
  readonly answeredBy: string;
  readonly expectedRevision: number;
  readonly appliedRevision: number | null;
  readonly accepted: boolean;
  readonly route: string;
  readonly refusal: string;
  readonly createdAt: string;
}

/** The trail for one approval, oldest first. */
export function approvalAudit(
  context: CollabContext,
  pendingId: string,
): AuditRow[] {
  const rows = context.database
    .prepare(
      "SELECT approval_id, decision, answered_by, expected_revision, applied_revision, " +
        "accepted, route, refusal, created_at FROM agent_approval_audit " +
        "WHERE approval_id = ? ORDER BY id",
    )
    .all(pendingId) as {
    approval_id: string;
    decision: string;
    answered_by: string;
    expected_revision: number;
    applied_revision: number | null;
    accepted: number;
    route: string;
    refusal: string;
    created_at: string;
  }[];
  return rows.map((row) => ({
    approvalId: row.approval_id,
    decision: row.decision,
    answeredBy: row.answered_by,
    expectedRevision: Number(row.expected_revision),
    appliedRevision:
      row.applied_revision === null ? null : Number(row.applied_revision),
    accepted: row.accepted !== 0,
    route: row.route,
    refusal: row.refusal,
    createdAt: row.created_at,
  }));
}

/* --------------------------------- delivery -------------------------------- */

export function pendingDir(context: CollabContext): string {
  return join(context.dataDir, "pending");
}

/**
 * Writes `<pending>/<id>.answer` atomically, 0600. `false` means there was no
 * pending request file, so nobody is polling for the answer.
 */
export function writeAnswerFile(
  directory: string,
  pendingId: string,
  decision: string,
): boolean {
  if (!validPendingId(pendingId)) {
    throw badRequest("Approval id is invalid");
  }
  if (!existsSync(join(directory, `${pendingId}.json`))) return false;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `${pendingId}.answer`);
  const temporary = join(directory, `.${pendingId}.answer.tmp`);
  writeFileSync(temporary, decision, { mode: 0o600 });
  renameSync(temporary, target);
  return true;
}

/**
 * The fallback: the keys a human would press.
 *
 * Every CLI in the registry is covered, not only the one with a numbered menu.
 * A provider this build has never heard of falls back to `y` / `n`, which is
 * what every prompt but Claude's asks for — answering nothing at all would
 * leave the CLI blocked on a question the user has already decided.
 */
async function typeIntoPty(
  context: CollabContext,
  approval: AgentApproval,
  decision: string,
): Promise<boolean> {
  const session = loadSession(context.database, approval.nodeId);
  if (session === undefined || context.terminals === undefined) return false;
  const node = loadNode(context.database, approval.nodeId);
  const agentId =
    node?.agentId ??
    getAgentStatus(context.database, approval.nodeId)?.agentId ??
    "claude";
  const generation = context.terminals.generation(session.sessionId);
  if (generation === undefined) return false;
  const keys = answerKeys(baseAgent(context.settings, agentId), decision);
  try {
    await context.terminals.write(session.sessionId, generation, keys);
    return true;
  } catch {
    return false;
  }
}

/**
 * The keystrokes each CLI reads as allow / deny.
 *
 * Claude's permission prompt is a numbered menu: `1` is yes and `3` is "no,
 * and tell it what to do instead". Codex, opencode, Pi, Oh My Pi and Copilot
 * all take a y/n answer, which is also the fallback for a `custom:` entry
 * whose base is unknown — a guess that does nothing is better than silence
 * only because the CLI is blocked either way, and `n` is the safe guess.
 */
export function answerKeys(agentId: string, decision: string): string {
  const allow = decision === "allow";
  switch (agentId) {
    case "claude":
      return allow ? "1\r" : "3\r";
    case "codex":
    case "opencode":
    case "pi":
    case "omp":
    case "copilot":
    case "ama":
      return allow ? "y\r" : "n\r";
    default:
      return allow ? "y\r" : "n\r";
  }
}

/**
 * `<nodeId>-<epochMs>-<pid>`; anything that could escape the directory or name
 * a file we did not write is refused before it reaches the filesystem.
 */
export function validPendingId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9_.-]+$/.test(value) &&
    !value.includes("..")
  );
}

/* ---------------------------------- sweep --------------------------------- */

/**
 * Deletes pending request and answer files older than {@link ORPHAN_MINUTES}.
 *
 * A client that was killed mid-wait leaves both files behind, and they contain
 * the tool call the agent wanted to make. Returns how many files went away.
 *
 * `now` is the caller's clock, passed in rather than read here: a file's mtime
 * comes from the file system's clock, not the process's, and on Windows the
 * two can disagree by a few milliseconds in either direction. Callers in
 * production pass `Date.now()`; tests pin both sides.
 */
export function sweepOrphans(
  directory: string,
  olderThanMs: number,
  now: number,
): number {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ours = [".json", ".answer", ".tmp"].some((extension) =>
      entry.name.endsWith(extension),
    );
    if (!ours) continue;
    const path = join(directory, entry.name);
    let stale = false;
    try {
      stale = now - statSync(path).mtimeMs > olderThanMs;
    } catch {
      stale = false;
    }
    if (!stale) continue;
    try {
      rmSync(path);
      removed += 1;
    } catch {
      // Something else removed it first; that is the outcome we wanted.
    }
  }
  return removed;
}

/**
 * Whether a node has a permission question open.
 *
 * The other half of the safety gate `agent/status.isAwaitingHuman` answers:
 * the status row says the CLI is blocked, this says *what on*. Exported for
 * the terminal domain, which refuses a write into a pane that is waiting on a
 * human — a write would answer the question with whatever it happened to be.
 */
export function hasOpenApproval(
  context: CollabContext,
  nodeId: string,
): boolean {
  const row = context.database
    .prepare(
      "SELECT 1 AS found FROM agent_approvals WHERE node_id = ? AND answer IS NULL LIMIT 1",
    )
    .get(nodeId);
  return row !== undefined;
}

export { agentIdOf };
