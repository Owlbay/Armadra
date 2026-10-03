import type { DatabaseSync } from "node:sqlite";
import { validAgentId } from "../agent/registry";
import type { CollabContext } from "../collab/service";
import { DomainError, uuidV7 } from "../workspaces/support";
import { parseDraft } from "./draft";
import type { WorkflowEngine } from "./engine";
import {
  type DraftRow,
  type RunRow,
  type StepRow,
  type TemplateRow,
  deleteTemplate,
  draftById,
  insertDraft,
  insertTemplate,
  listDrafts,
  listRuns,
  listTemplates,
  runById,
  settleDraft,
  stepsOf,
  templateById,
  updateTemplate,
} from "./store";
import {
  DRAFT_STATUSES,
  type DraftStatus,
  type GateDecision,
  type WorkflowDraft,
} from "./types";

/**
 * 工作流的服务层：草案存取与确认、模板 CRUD、运行的起停与关卡（契约 §15.2–
 * §15.3）。HTTP 面（`routes.ts`）与控制动词（`collab/control/workflow.ts`）都
 * 经过它，规矩只写一处。
 */

export interface WorkflowServiceOptions {
  readonly database: DatabaseSync;
  readonly engine: WorkflowEngine;
  readonly collab: () => CollabContext | undefined;
  readonly clock?: () => number;
}

const RULES = { validAgentId };

export class WorkflowService {
  readonly database: DatabaseSync;
  readonly engine: WorkflowEngine;
  private readonly clock: () => number;

  constructor(private readonly options: WorkflowServiceOptions) {
    this.database = options.database;
    this.engine = options.engine;
    this.clock = options.clock ?? (() => Date.now());
  }

  /* --------------------------------- 草案 --------------------------------- */

  /** `workflow-propose`：校验、落库、告诉页面出一张草案卡。 */
  propose(
    origin: {
      readonly workspaceId: string;
      readonly boardId: string;
      readonly nodeId: string | null;
    },
    raw: unknown,
  ): DraftRow {
    const draft = parseDraft(raw, RULES);
    const row = insertDraft(this.database, {
      id: uuidV7(),
      workspaceId: origin.workspaceId,
      boardId: origin.boardId,
      proposerNodeId: origin.nodeId,
      draft,
      createdAt: this.clock(),
    });
    this.publishDraft(row);
    return row;
  }

  drafts(filter: {
    readonly boardId?: string | undefined;
    readonly status?: string | undefined;
  }): DraftRow[] {
    if (
      filter.status !== undefined &&
      !(DRAFT_STATUSES as readonly string[]).includes(filter.status)
    ) {
      throw new DomainError(
        400,
        "bad_request",
        `status 只能是 ${DRAFT_STATUSES.join(" / ")}。`,
      );
    }
    return listDrafts(this.database, {
      boardId: filter.boardId,
      status: filter.status as DraftStatus | undefined,
    });
  }

  draft(id: string): DraftRow {
    const row = draftById(this.database, id);
    if (row === undefined) throw notFound("没有这份草案。");
    return row;
  }

  /**
   * 确认：草案（人可能改过，`draft` 给了就用它）存成模板，草案记 `confirmed`。
   * 两步在一个事务里：不会有一份确认了却没有模板的草案。
   */
  confirm(
    id: string,
    edit: { readonly name?: unknown; readonly draft?: unknown },
  ): { draft: DraftRow; template: TemplateRow } {
    const row = this.draft(id);
    if (row.status !== "pending") throw draftNotPending();
    const body =
      edit.draft === undefined ? row.draft : parseDraft(edit.draft, RULES);
    const name = templateName(edit.name, body);
    const now = this.clock();
    const templateId = uuidV7();
    let template: TemplateRow;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!settleDraft(this.database, id, "confirmed", templateId, now)) {
        throw draftNotPending();
      }
      template = insertTemplate(this.database, {
        id: templateId,
        name,
        template: body,
        createdFromDraft: id,
        createdAt: now,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const settled = this.draft(id);
    this.publishDraft(settled);
    return { draft: settled, template };
  }

  discard(id: string): DraftRow {
    const row = this.draft(id);
    if (!settleDraft(this.database, row.id, "discarded", null, this.clock())) {
      throw draftNotPending();
    }
    const settled = this.draft(id);
    this.publishDraft(settled);
    return settled;
  }

  /* --------------------------------- 模板 --------------------------------- */

  templates(): TemplateRow[] {
    return listTemplates(this.database);
  }

  template(id: string): TemplateRow {
    const row = templateById(this.database, id);
    if (row === undefined) throw notFound("没有这个模板。");
    return row;
  }

  createTemplate(body: {
    readonly name?: unknown;
    readonly template?: unknown;
  }): TemplateRow {
    const template = parseDraft(body.template, RULES);
    return insertTemplate(this.database, {
      id: uuidV7(),
      name: templateName(body.name, template),
      template,
      createdFromDraft: null,
      createdAt: this.clock(),
    });
  }

  /** 改模板：`template.version` 必须比库里的大（只增）。 */
  updateTemplate(
    id: string,
    body: { readonly name?: unknown; readonly template?: unknown },
  ): TemplateRow {
    const current = this.template(id);
    const template = parseDraft(body.template, RULES);
    const name =
      body.name === undefined
        ? current.name
        : templateName(body.name, template);
    if (
      template.version <= current.version ||
      !updateTemplate(this.database, id, name, template, this.clock())
    ) {
      throw new DomainError(
        409,
        "template_version_stale",
        `模板的 version 只增：库里是 ${current.version}，这次要大于它。`,
      );
    }
    return this.template(id);
  }

  deleteTemplate(id: string): void {
    if (!deleteTemplate(this.database, id)) throw notFound("没有这个模板。");
  }

  /* --------------------------------- 运行 --------------------------------- */

  async startRun(body: {
    readonly templateId?: unknown;
    readonly params?: unknown;
    readonly boardId?: unknown;
  }): Promise<RunRow> {
    if (typeof body.templateId !== "string" || body.templateId === "") {
      throw new DomainError(400, "bad_request", "templateId 不能缺。");
    }
    if (body.boardId !== undefined && typeof body.boardId !== "string") {
      throw new DomainError(400, "bad_request", "boardId 必须是字符串。");
    }
    const template = this.template(body.templateId);
    return this.engine.startRun({
      template,
      params: body.params,
      boardId: body.boardId as string | undefined,
    });
  }

  runs(filter: {
    readonly templateId?: string | undefined;
    readonly boardId?: string | undefined;
    readonly limit?: number | undefined;
  }): RunRow[] {
    return listRuns(this.database, filter);
  }

  run(id: string): RunRow {
    const row = runById(this.database, id);
    if (row === undefined) throw notFound("没有这次运行。");
    return row;
  }

  steps(runId: string): StepRow[] {
    return stepsOf(this.database, runId);
  }

  cancel(id: string): Promise<RunRow> {
    return this.engine.cancel(id);
  }

  answerGate(
    runId: string,
    stepId: string,
    body: { readonly decision?: unknown; readonly note?: unknown },
  ): Promise<RunRow> {
    if (body.decision !== "approve" && body.decision !== "reject") {
      throw new DomainError(
        400,
        "bad_request",
        "decision 只能是 approve / reject。",
      );
    }
    if (
      body.note !== undefined &&
      body.note !== null &&
      (typeof body.note !== "string" || [...body.note].length > 2_000)
    ) {
      throw new DomainError(
        400,
        "bad_request",
        "note 是最多 2000 字的字符串。",
      );
    }
    return this.engine.answerGate(
      runId,
      stepId,
      body.decision as GateDecision,
      (body.note as string | null | undefined) ?? undefined,
    );
  }

  /* --------------------------------- 发布 --------------------------------- */

  private publishDraft(row: DraftRow): void {
    this.options.collab()?.publish(row.workspaceId, {
      type: "workflow.draft",
      draftId: row.id,
      boardId: row.boardId,
      status: row.status,
    });
  }
}

function templateName(raw: unknown, template: WorkflowDraft): string {
  if (raw === undefined || raw === null) return template.title;
  if (typeof raw !== "string" || raw.trim() === "" || [...raw].length > 160) {
    throw new DomainError(400, "bad_request", "name 是 1–160 个字符。");
  }
  return raw.trim();
}

function notFound(message: string): DomainError {
  return new DomainError(404, "not_found", message);
}

function draftNotPending(): DomainError {
  return new DomainError(
    409,
    "draft_not_pending",
    "这份草案已经确认或丢弃了。",
  );
}

/* ---------------------------------- JSON ---------------------------------- */

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export function draftJson(row: DraftRow): Record<string, unknown> {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    boardId: row.boardId,
    proposerNodeId: row.proposerNodeId,
    status: row.status,
    templateId: row.templateId,
    draft: row.draft,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function templateJson(row: TemplateRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    createdFromDraft: row.createdFromDraft,
    template: row.template,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function stepJson(row: StepRow, run: RunRow): Record<string, unknown> {
  const definition = run.template.steps.find((step) => step.id === row.stepId);
  return {
    stepId: row.stepId,
    kind: row.kind,
    role:
      definition === undefined || definition.kind === "gate"
        ? null
        : definition.role,
    status: row.status,
    nodeId: row.nodeId,
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
    reason: row.reason,
    outputs: row.outcome?.outputs ?? [],
    decision: row.outcome?.decision ?? null,
    note: row.outcome?.note ?? null,
  };
}

export function runJson(
  row: RunRow,
  steps: readonly StepRow[],
): Record<string, unknown> {
  return {
    id: row.id,
    templateId: row.templateId,
    templateVersion: row.templateVersion,
    title: row.template.title,
    workspaceId: row.workspaceId,
    boardId: row.boardId,
    frameId: row.frameId,
    params: row.params,
    status: row.status,
    reason: row.reason,
    roles: row.roles,
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
    steps: steps.map((step) => stepJson(step, row)),
  };
}
