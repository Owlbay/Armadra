import type { DatabaseSync } from "node:sqlite";
import type {
  DraftStatus,
  RunStatus,
  StepOutcome,
  StepStatus,
  WorkflowDraft,
  WorkflowStepKind,
} from "./types";

/**
 * 工作流的四张表（草案、模板、运行、步骤）。只有 SQL，不做判断：判断在
 * `service.ts` 与 `engine.ts`。状态迁移的条件写在 `WHERE` 里——事件与扫描可能
 * 同时判到同一步，只有先到的那一次算数（与 `dependencies/store.ts` 同一手法）。
 */

function parse<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/* --------------------------------- 草案 ----------------------------------- */

export interface DraftRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly boardId: string;
  readonly proposerNodeId: string | null;
  readonly draft: WorkflowDraft;
  readonly status: DraftStatus;
  readonly templateId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface DraftRecord {
  id: string;
  workspace_id: string;
  board_id: string;
  proposer_node_id: string | null;
  draft_json: string;
  status: string;
  template_id: string | null;
  created_at: number;
  updated_at: number;
}

const DRAFT_COLUMNS =
  "id, workspace_id, board_id, proposer_node_id, draft_json, status, template_id, created_at, updated_at";

function draftOf(row: DraftRecord): DraftRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    boardId: row.board_id,
    proposerNodeId: row.proposer_node_id,
    draft: parse(row.draft_json, {} as WorkflowDraft),
    status: row.status as DraftStatus,
    templateId: row.template_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function insertDraft(
  database: DatabaseSync,
  draft: Omit<DraftRow, "status" | "templateId" | "updatedAt">,
): DraftRow {
  database
    .prepare(
      `INSERT INTO workflow_drafts (${DRAFT_COLUMNS}) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
    )
    .run(
      draft.id,
      draft.workspaceId,
      draft.boardId,
      draft.proposerNodeId,
      JSON.stringify(draft.draft),
      draft.createdAt,
      draft.createdAt,
    );
  return draftById(database, draft.id) as DraftRow;
}

export function draftById(
  database: DatabaseSync,
  id: string,
): DraftRow | undefined {
  const row = database
    .prepare(`SELECT ${DRAFT_COLUMNS} FROM workflow_drafts WHERE id = ?`)
    .get(id) as DraftRecord | undefined;
  return row === undefined ? undefined : draftOf(row);
}

export function listDrafts(
  database: DatabaseSync,
  filter: {
    readonly boardId?: string | undefined;
    readonly status?: DraftStatus | undefined;
  },
): DraftRow[] {
  const where: string[] = [];
  const values: string[] = [];
  if (filter.boardId !== undefined) {
    where.push("board_id = ?");
    values.push(filter.boardId);
  }
  if (filter.status !== undefined) {
    where.push("status = ?");
    values.push(filter.status);
  }
  const rows = database
    .prepare(
      `SELECT ${DRAFT_COLUMNS} FROM workflow_drafts` +
        (where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`) +
        " ORDER BY created_at DESC LIMIT 200",
    )
    .all(...values) as unknown as DraftRecord[];
  return rows.map(draftOf);
}

/** 只有还在 `pending` 的草案能被确认或丢弃。答这一次有没有改到。 */
export function settleDraft(
  database: DatabaseSync,
  id: string,
  status: Exclude<DraftStatus, "pending">,
  templateId: string | null,
  now: number,
): boolean {
  const changes = database
    .prepare(
      "UPDATE workflow_drafts SET status = ?, template_id = ?, updated_at = ? " +
        "WHERE id = ? AND status = 'pending'",
    )
    .run(status, templateId, now, id);
  return Number(changes.changes) > 0;
}

/* --------------------------------- 模板 ----------------------------------- */

export interface TemplateRow {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly template: WorkflowDraft;
  readonly createdFromDraft: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface TemplateRecord {
  id: string;
  name: string;
  version: number;
  template_json: string;
  created_from_draft: string | null;
  created_at: number;
  updated_at: number;
}

const TEMPLATE_COLUMNS =
  "id, name, version, template_json, created_from_draft, created_at, updated_at";

function templateOf(row: TemplateRecord): TemplateRow {
  return {
    id: row.id,
    name: row.name,
    version: Number(row.version),
    template: parse(row.template_json, {} as WorkflowDraft),
    createdFromDraft: row.created_from_draft,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function insertTemplate(
  database: DatabaseSync,
  template: Omit<TemplateRow, "updatedAt" | "version">,
): TemplateRow {
  database
    .prepare(
      `INSERT INTO workflow_templates (${TEMPLATE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      template.id,
      template.name,
      template.template.version,
      JSON.stringify(template.template),
      template.createdFromDraft,
      template.createdAt,
      template.createdAt,
    );
  return templateById(database, template.id) as TemplateRow;
}

export function templateById(
  database: DatabaseSync,
  id: string,
): TemplateRow | undefined {
  const row = database
    .prepare(`SELECT ${TEMPLATE_COLUMNS} FROM workflow_templates WHERE id = ?`)
    .get(id) as TemplateRecord | undefined;
  return row === undefined ? undefined : templateOf(row);
}

export function listTemplates(database: DatabaseSync): TemplateRow[] {
  const rows = database
    .prepare(
      `SELECT ${TEMPLATE_COLUMNS} FROM workflow_templates ORDER BY updated_at DESC`,
    )
    .all() as unknown as TemplateRecord[];
  return rows.map(templateOf);
}

/**
 * 改模板：新的 `version` 必须大于库里那份（只增）。条件写在 `WHERE` 里，两个
 * 页面同时保存，只有一个算数。
 */
export function updateTemplate(
  database: DatabaseSync,
  id: string,
  name: string,
  template: WorkflowDraft,
  now: number,
): boolean {
  const changes = database
    .prepare(
      "UPDATE workflow_templates SET name = ?, version = ?, template_json = ?, updated_at = ? " +
        "WHERE id = ? AND version < ?",
    )
    .run(
      name,
      template.version,
      JSON.stringify(template),
      now,
      id,
      template.version,
    );
  return Number(changes.changes) > 0;
}

export function deleteTemplate(database: DatabaseSync, id: string): boolean {
  const changes = database
    .prepare("DELETE FROM workflow_templates WHERE id = ?")
    .run(id);
  return Number(changes.changes) > 0;
}

/* --------------------------------- 运行 ----------------------------------- */

export interface RunRow {
  readonly id: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly template: WorkflowDraft;
  readonly workspaceId: string;
  readonly boardId: string;
  readonly frameId: string | null;
  readonly anchorNodeId: string | null;
  readonly params: Record<string, string>;
  /** 角色 id → 节点 id。 */
  readonly roles: Record<string, string>;
  readonly status: RunStatus;
  readonly reason: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

interface RunRecord {
  id: string;
  template_id: string;
  template_version: number;
  template_json: string;
  workspace_id: string;
  board_id: string;
  frame_id: string | null;
  anchor_node_id: string | null;
  params_json: string;
  roles_json: string;
  status: string;
  reason: string | null;
  started_at: number;
  ended_at: number | null;
}

const RUN_COLUMNS =
  "id, template_id, template_version, template_json, workspace_id, board_id, frame_id, " +
  "anchor_node_id, params_json, roles_json, status, reason, started_at, ended_at";

function runOf(row: RunRecord): RunRow {
  return {
    id: row.id,
    templateId: row.template_id,
    templateVersion: Number(row.template_version),
    template: parse(row.template_json, {} as WorkflowDraft),
    workspaceId: row.workspace_id,
    boardId: row.board_id,
    frameId: row.frame_id,
    anchorNodeId: row.anchor_node_id,
    params: parse(row.params_json, {}),
    roles: parse(row.roles_json, {}),
    status: row.status as RunStatus,
    reason: row.reason,
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
  };
}

/** 一次运行与它的全部步骤（全是 `pending`），同一个事务。 */
export function insertRun(
  database: DatabaseSync,
  run: Omit<RunRow, "status" | "reason" | "endedAt">,
): RunRow {
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `INSERT INTO workflow_runs (${RUN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?, NULL)`,
      )
      .run(
        run.id,
        run.templateId,
        run.templateVersion,
        JSON.stringify(run.template),
        run.workspaceId,
        run.boardId,
        run.frameId,
        run.anchorNodeId,
        JSON.stringify(run.params),
        JSON.stringify(run.roles),
        run.startedAt,
      );
    const insert = database.prepare(
      "INSERT INTO workflow_run_steps (run_id, step_id, kind, status, node_id) VALUES (?, ?, ?, 'pending', ?)",
    );
    for (const step of run.template.steps) {
      insert.run(
        run.id,
        step.id,
        step.kind,
        step.kind === "gate" ? null : (run.roles[step.role] ?? null),
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return runById(database, run.id) as RunRow;
}

export function runById(
  database: DatabaseSync,
  id: string,
): RunRow | undefined {
  const row = database
    .prepare(`SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE id = ?`)
    .get(id) as RunRecord | undefined;
  return row === undefined ? undefined : runOf(row);
}

export function listRuns(
  database: DatabaseSync,
  filter: {
    readonly templateId?: string | undefined;
    readonly boardId?: string | undefined;
    readonly limit?: number | undefined;
  },
): RunRow[] {
  const where: string[] = [];
  const values: (string | number)[] = [];
  if (filter.templateId !== undefined) {
    where.push("template_id = ?");
    values.push(filter.templateId);
  }
  if (filter.boardId !== undefined) {
    where.push("board_id = ?");
    values.push(filter.boardId);
  }
  values.push(Math.min(Math.max(filter.limit ?? 50, 1), 200));
  const rows = database
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM workflow_runs` +
        (where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`) +
        " ORDER BY started_at DESC, id DESC LIMIT ?",
    )
    .all(...values) as unknown as RunRecord[];
  return rows.map(runOf);
}

/** 还没结束的运行：重启之后从这里续跑。 */
export function activeRuns(database: DatabaseSync): RunRow[] {
  const rows = database
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE status IN ('running','waiting') ORDER BY started_at`,
    )
    .all() as unknown as RunRecord[];
  return rows.map(runOf);
}

/** 运行与哪些节点有关：起点便签与各角色节点。 */
export function runsTouchingNode(
  database: DatabaseSync,
  nodeId: string,
): string[] {
  const rows = database
    .prepare(
      "SELECT DISTINCT s.run_id AS id FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id " +
        "WHERE s.node_id = ? AND r.status IN ('running','waiting')",
    )
    .all(nodeId) as { id: string }[];
  return rows.map((row) => row.id);
}

/** 改运行状态；已经结束的运行不再改。 */
export function setRunStatus(
  database: DatabaseSync,
  id: string,
  status: RunStatus,
  reason: string | null,
  endedAt: number | null,
): boolean {
  const changes = database
    .prepare(
      "UPDATE workflow_runs SET status = ?, reason = ?, ended_at = ? " +
        "WHERE id = ? AND status IN ('running','waiting')",
    )
    .run(status, reason, endedAt, id);
  return Number(changes.changes) > 0;
}

export function setRunLayout(
  database: DatabaseSync,
  id: string,
  frameId: string,
  anchorNodeId: string,
  roles: Record<string, string>,
): void {
  database
    .prepare(
      "UPDATE workflow_runs SET frame_id = ?, anchor_node_id = ?, roles_json = ? WHERE id = ?",
    )
    .run(frameId, anchorNodeId, JSON.stringify(roles), id);
  const update = database.prepare(
    "UPDATE workflow_run_steps SET node_id = ? WHERE run_id = ? AND step_id = ?",
  );
  const run = runById(database, id);
  for (const step of run?.template.steps ?? []) {
    if (step.kind === "gate") continue;
    update.run(roles[step.role] ?? null, id, step.id);
  }
}

/* --------------------------------- 步骤 ----------------------------------- */

export interface StepRow {
  readonly runId: string;
  readonly stepId: string;
  readonly kind: WorkflowStepKind;
  readonly status: StepStatus;
  readonly nodeId: string | null;
  readonly queueId: string | null;
  readonly attempts: number;
  readonly delivered: boolean;
  readonly baselineState: string | null;
  readonly baselineEventAt: string | null;
  readonly observedBusy: boolean;
  readonly reason: string | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly outcome: StepOutcome | null;
}

interface StepRecord {
  run_id: string;
  step_id: string;
  kind: string;
  status: string;
  node_id: string | null;
  queue_id: string | null;
  attempts: number;
  delivered: number;
  baseline_state: string | null;
  baseline_event_at: string | null;
  observed_busy: number;
  reason: string | null;
  started_at: number | null;
  ended_at: number | null;
  outcome_json: string | null;
}

const STEP_COLUMNS =
  "run_id, step_id, kind, status, node_id, queue_id, attempts, delivered, baseline_state, " +
  "baseline_event_at, observed_busy, reason, started_at, ended_at, outcome_json";

function stepOf(row: StepRecord): StepRow {
  return {
    runId: row.run_id,
    stepId: row.step_id,
    kind: row.kind as WorkflowStepKind,
    status: row.status as StepStatus,
    nodeId: row.node_id,
    queueId: row.queue_id,
    attempts: Number(row.attempts),
    delivered: Number(row.delivered) === 1,
    baselineState: row.baseline_state,
    baselineEventAt: row.baseline_event_at,
    observedBusy: Number(row.observed_busy) === 1,
    reason: row.reason,
    startedAt: row.started_at === null ? null : Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    outcome: parse<StepOutcome | null>(row.outcome_json, null),
  };
}

export function stepsOf(database: DatabaseSync, runId: string): StepRow[] {
  const rows = database
    .prepare(
      `SELECT ${STEP_COLUMNS} FROM workflow_run_steps WHERE run_id = ? ORDER BY rowid`,
    )
    .all(runId) as unknown as StepRecord[];
  return rows.map(stepOf);
}

export function stepOfRun(
  database: DatabaseSync,
  runId: string,
  stepId: string,
): StepRow | undefined {
  const row = database
    .prepare(
      `SELECT ${STEP_COLUMNS} FROM workflow_run_steps WHERE run_id = ? AND step_id = ?`,
    )
    .get(runId, stepId) as StepRecord | undefined;
  return row === undefined ? undefined : stepOf(row);
}

/**
 * 从 `from` 里的某个状态改到 `to`，带上要一起写的列。答有没有改到：没改到
 * 就是别的路径先一步改过了。
 */
export function transitionStep(
  database: DatabaseSync,
  runId: string,
  stepId: string,
  from: readonly StepStatus[],
  to: StepStatus,
  fields: {
    readonly reason?: string | null;
    readonly startedAt?: number;
    readonly endedAt?: number;
    readonly outcome?: StepOutcome;
    readonly queueId?: string | null;
  } = {},
): boolean {
  const sets = ["status = ?"];
  const values: (string | number | null)[] = [to];
  if (fields.reason !== undefined) {
    sets.push("reason = ?");
    values.push(fields.reason);
  }
  if (fields.startedAt !== undefined) {
    sets.push("started_at = ?");
    values.push(fields.startedAt);
  }
  if (fields.endedAt !== undefined) {
    sets.push("ended_at = ?");
    values.push(fields.endedAt);
  }
  if (fields.outcome !== undefined) {
    sets.push("outcome_json = ?");
    values.push(JSON.stringify(fields.outcome));
  }
  if (fields.queueId !== undefined) {
    sets.push("queue_id = ?");
    values.push(fields.queueId);
  }
  const changes = database
    .prepare(
      `UPDATE workflow_run_steps SET ${sets.join(", ")} WHERE run_id = ? AND step_id = ? ` +
        `AND status IN (${from.map(() => "?").join(", ")})`,
    )
    .run(...values, runId, stepId, ...from);
  return Number(changes.changes) > 0;
}

/** 投了一次（或重投一次）：记下排队项，投递与基准从头来。 */
export function noteDispatched(
  database: DatabaseSync,
  runId: string,
  stepId: string,
  queueId: string,
): void {
  database
    .prepare(
      "UPDATE workflow_run_steps SET queue_id = ?, attempts = attempts + 1, delivered = 0, " +
        "baseline_state = NULL, baseline_event_at = NULL, observed_busy = 0 " +
        "WHERE run_id = ? AND step_id = ? AND status = 'running'",
    )
    .run(queueId, runId, stepId);
}

/** 看见投递落地了：记下那一刻节点的状态作为完成判定的基准。 */
export function noteDelivered(
  database: DatabaseSync,
  runId: string,
  stepId: string,
  baseline: {
    readonly state: string | null;
    readonly eventAt: string | null;
    readonly busy: boolean;
  },
): void {
  database
    .prepare(
      "UPDATE workflow_run_steps SET delivered = 1, baseline_state = ?, baseline_event_at = ?, " +
        "observed_busy = ? WHERE run_id = ? AND step_id = ? AND status = 'running' AND delivered = 0",
    )
    .run(
      baseline.state,
      baseline.eventAt,
      baseline.busy ? 1 : 0,
      runId,
      stepId,
    );
}

export function noteBusy(
  database: DatabaseSync,
  runId: string,
  stepId: string,
): void {
  database
    .prepare(
      "UPDATE workflow_run_steps SET observed_busy = 1 WHERE run_id = ? AND step_id = ? AND status = 'running'",
    )
    .run(runId, stepId);
}
