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

/* ------------------------------ 编辑器（R-36） ----------------------------- */

type Step = WorkflowDraft["steps"][number];
type Role = WorkflowDraft["roles"][number];

/** 不和已有的重名的下一个标识：`step1`、`step2`……（`[A-Za-z][A-Za-z0-9_-]*`）。 */
export function nextId(prefix: string, taken: readonly string[]): string {
  for (let n = taken.length + 1; ; n += 1) {
    const id = `${prefix}${n}`;
    if (!taken.includes(id)) return id;
  }
}

/**
 * 在末尾加一步：依赖上一步（顺序执行），汇总步骤从上一步汇总；提示 / 汇总
 * 用第一个角色。正文留空，由人填。
 */
export function addStep(
  draft: WorkflowDraft,
  kind: Step["kind"],
): { draft: WorkflowDraft; id: string } {
  const id = nextId(
    "step",
    draft.steps.map((step) => step.id),
  );
  const previous = draft.steps.at(-1)?.id;
  const after = previous === undefined ? [] : [previous];
  const role = draft.roles[0]?.id ?? "";
  const step: Step =
    kind === "gate"
      ? { id, kind, label: "", after }
      : kind === "collect"
        ? { id, kind, role, prompt: "", from: after, after }
        : { id, kind, role, prompt: "", after };
  return { draft: { ...draft, steps: [...draft.steps, step] }, id };
}

/** 删一步：别的步骤对它的依赖与汇总来源一并去掉。 */
export function removeStep(
  draft: WorkflowDraft,
  stepId: string,
): WorkflowDraft {
  return {
    ...draft,
    steps: draft.steps
      .filter((step) => step.id !== stepId)
      .map((step) => {
        const after = step.after.filter((id) => id !== stepId);
        return step.kind === "collect"
          ? { ...step, after, from: step.from.filter((id) => id !== stepId) }
          : { ...step, after };
      }),
  };
}

/** 拖排：把第 `from` 步挪到第 `to` 位。依赖不变，只是列表顺序。 */
export function moveStep(
  draft: WorkflowDraft,
  from: number,
  to: number,
): WorkflowDraft {
  if (from === to || from < 0 || to < 0) return draft;
  if (from >= draft.steps.length || to >= draft.steps.length) return draft;
  const steps = [...draft.steps];
  const [moved] = steps.splice(from, 1);
  steps.splice(to, 0, moved as Step);
  return { ...draft, steps };
}

/** `stepId` 经依赖（直接或间接）等着 `target` 吗。勾上会成环的依赖不让勾。 */
export function dependsOn(
  draft: WorkflowDraft,
  stepId: string,
  target: string,
): boolean {
  const edges = new Map(draft.steps.map((step) => [step.id, step.after]));
  const seen = new Set<string>();
  const stack = [...(edges.get(stepId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(edges.get(id) ?? []));
  }
  return false;
}

/** 加一个角色：沿用第一个角色的 CLI。 */
export function addRole(draft: WorkflowDraft): {
  draft: WorkflowDraft;
  id: string;
} {
  const id = nextId(
    "role",
    draft.roles.map((role) => role.id),
  );
  const role: Role = { id, agentId: draft.roles[0]?.agentId ?? "claude" };
  return { draft: { ...draft, roles: [...draft.roles, role] }, id };
}

/** 有步骤在用、或只剩一个角色时不能删。 */
export function roleInUse(draft: WorkflowDraft, roleId: string): boolean {
  return draft.steps.some(
    (step) => step.kind !== "gate" && step.role === roleId,
  );
}

/** 删一个角色：连着它的协作连线一并去掉。调用方先用 {@link roleInUse} 挡住。 */
export function removeRole(
  draft: WorkflowDraft,
  roleId: string,
): WorkflowDraft {
  return {
    ...draft,
    roles: draft.roles.filter((role) => role.id !== roleId),
    links: draft.links.filter(
      (link) => link.from !== roleId && link.to !== roleId,
    ),
  };
}

export function updateRole(
  draft: WorkflowDraft,
  roleId: string,
  patch: Partial<Role>,
): WorkflowDraft {
  return {
    ...draft,
    roles: draft.roles.map((role) =>
      role.id === roleId ? { ...role, ...patch } : role,
    ),
  };
}

/**
 * 保存前页面能看出来的问题（core 会再按契约 §15.1 校验一遍）：每一步的正文
 * 不空、汇总至少有一个来源、步骤与角色都至少一个。答出有问题的步骤 id。
 */
export function incompleteSteps(draft: WorkflowDraft): string[] {
  return draft.steps
    .filter((step) =>
      step.kind === "gate"
        ? step.label.trim() === ""
        : step.prompt.trim() === "" ||
          (step.kind === "collect" && step.from.length === 0),
    )
    .map((step) => step.id);
}

export function canSaveDraft(draft: WorkflowDraft): boolean {
  return (
    draft.steps.length > 0 &&
    draft.roles.length > 0 &&
    incompleteSteps(draft).length === 0
  );
}
