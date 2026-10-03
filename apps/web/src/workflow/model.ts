import type {
  WorkflowDraft,
  WorkflowRunJson,
  WorkflowRunStepJson,
  WorkflowTemplateJson,
} from "@armadra/shared";

import type { StatusTone } from "@/ui/status-pill";

/**
 * 工作流页面的纯函数：状态到胶囊、参数摘要、两次运行的逐步对比。组件只组合
 * 它们，规则可以不渲染就测。
 */

export function runTone(status: WorkflowRunJson["status"]): StatusTone {
  switch (status) {
    case "running":
      return "working";
    case "waiting":
      return "attention";
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    default:
      return "paused";
  }
}

export function stepTone(status: WorkflowRunStepJson["status"]): StatusTone {
  switch (status) {
    case "running":
      return "working";
    case "waiting":
      return "attention";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "pending":
      return "queued";
    default:
      return "paused";
  }
}

/** 运行行上那一串参数：`名字=值`，长的截断，空的不出现。 */
export function paramSummary(
  params: Readonly<Record<string, string>>,
  limit = 60,
): string {
  const text = Object.entries(params)
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `${name}=${value}`)
    .join(" · ");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** 正在等人的关卡（通常最多一个）。 */
export function waitingGates(run: WorkflowRunJson): WorkflowRunStepJson[] {
  return run.steps.filter(
    (step) => step.kind === "gate" && step.status === "waiting",
  );
}

/** 一次运行一共产出了几条 `post`。 */
export function outputCount(run: WorkflowRunJson): number {
  return run.steps.reduce((total, step) => total + step.outputs.length, 0);
}

export function finished(run: WorkflowRunJson): boolean {
  return (
    run.status === "succeeded" ||
    run.status === "failed" ||
    run.status === "cancelled"
  );
}

/** 模板卡上的三个数：角色、步骤、上一次运行。 */
export function templateStats(
  template: WorkflowTemplateJson,
  runs: readonly WorkflowRunJson[],
): { roles: number; steps: number; lastRunAt: string | null } {
  const last = runs
    .filter((run) => run.templateId === template.id)
    .map((run) => run.startedAt)
    .sort()
    .at(-1);
  return {
    roles: template.template.roles.length,
    steps: template.template.steps.length,
    lastRunAt: last ?? null,
  };
}

export interface CompareRow {
  readonly stepId: string;
  readonly kind: WorkflowRunStepJson["kind"];
  readonly left: WorkflowRunStepJson | null;
  readonly right: WorkflowRunStepJson | null;
  /** 两边的产出正文（与关卡答复）逐字相同。 */
  readonly same: boolean;
}

function digest(step: WorkflowRunStepJson | null): string {
  if (step === null) return "";
  return JSON.stringify([
    step.status,
    step.outputs.map((output) => output.body),
    step.decision,
    step.note,
  ]);
}

/**
 * 两次运行按步骤并排：左边那次的步骤顺序在前，右边独有的步骤（模板改过）
 * 接在后面。同一步的产出正文逐字比。
 */
export function compareRuns(
  left: WorkflowRunJson,
  right: WorkflowRunJson,
): CompareRow[] {
  const ids: string[] = [];
  for (const step of [...left.steps, ...right.steps]) {
    if (!ids.includes(step.stepId)) ids.push(step.stepId);
  }
  return ids.map((stepId) => {
    const a = left.steps.find((step) => step.stepId === stepId) ?? null;
    const b = right.steps.find((step) => step.stepId === stepId) ?? null;
    return {
      stepId,
      kind: (a ?? b)!.kind,
      left: a,
      right: b,
      same: a !== null && b !== null && digest(a) === digest(b),
    };
  });
}

/** 一份模板的参数初值：模板的缺省值，没有就空串。 */
export function defaultParams(template: WorkflowDraft): Record<string, string> {
  const values: Record<string, string> = {};
  for (const param of template.params) values[param.name] = param.default ?? "";
  return values;
}

/** 起跑前缺了哪些参数（没有缺省值、也没填）。 */
export function missingParams(
  template: WorkflowDraft,
  values: Readonly<Record<string, string>>,
): string[] {
  return template.params
    .filter((param) => (values[param.name] ?? "").trim() === "")
    .filter((param) => (param.default ?? "") === "")
    .map((param) => param.name);
}

/** 填了的参数（空的不发：core 用模板的缺省值）。 */
export function filledParams(
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value.trim() !== ""),
  );
}
