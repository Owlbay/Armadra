import type {
  WorkflowDraft,
  WorkflowRunJson,
  WorkflowRunStepJson,
  WorkflowTemplateJson,
} from "@armadra/shared";

/**
 * `workflow` 分区的假数据（设计展示页 §2.1）。纯对象，无副作用；名字与正文是
 * 数据不是界面文案。时钟钉在 {@link NOW}。
 */

export const NOW = Date.UTC(2026, 9, 3, 8, 0, 0);
const at = (minutesAgo: number) =>
  new Date(NOW - minutesAgo * 60_000).toISOString();

const REVIEW: WorkflowDraft = {
  version: 2,
  title: "审查一次 PR",
  params: [
    { name: "repo", type: "path", label: "仓库", default: "." },
    { name: "branch", type: "string", label: "分支", default: null },
  ],
  roles: [
    { id: "reviewerA", agentId: "claude", title: "前端审查" },
    { id: "reviewerB", agentId: "codex", title: "后端审查" },
    { id: "lead", agentId: "ama", title: "汇总" },
  ],
  links: [
    { from: "lead", to: "reviewerA", role: "supervises" },
    { from: "lead", to: "reviewerB", role: "supervises" },
  ],
  steps: [
    {
      id: "frontend",
      kind: "prompt",
      role: "reviewerA",
      prompt: "审查 {{branch}} 上 apps/web 的改动，结论 canvas post 给 lead",
      after: [],
    },
    {
      id: "backend",
      kind: "prompt",
      role: "reviewerB",
      prompt:
        "审查 {{branch}} 上 apps/desktop 的改动，结论 canvas post 给 lead",
      after: [],
    },
    {
      id: "summary",
      kind: "collect",
      role: "lead",
      from: ["frontend", "backend"],
      prompt: "把两份结论合成一张便签，列出必须改的",
      after: ["frontend", "backend"],
    },
    { id: "merge", kind: "gate", label: "合并前人工确认", after: ["summary"] },
  ],
};

const PAPER: WorkflowDraft = {
  version: 1,
  title: "复现论文",
  params: [{ name: "paper", type: "string", label: "论文", default: null }],
  roles: [
    { id: "reader", agentId: "claude", title: "读论文" },
    { id: "coder", agentId: "codex", title: "写实验" },
  ],
  links: [{ from: "reader", to: "coder", role: "peer" }],
  steps: [
    {
      id: "read",
      kind: "prompt",
      role: "reader",
      prompt: "读 {{paper}}，写出要复现的三个表",
      after: [],
    },
    {
      id: "code",
      kind: "collect",
      role: "coder",
      from: ["read"],
      prompt: "按表写实验脚本",
      after: ["read"],
    },
  ],
};

const RELEASE: WorkflowDraft = {
  version: 1,
  title: "每周发布检查",
  params: [],
  roles: [{ id: "checker", agentId: "copilot", title: "检查" }],
  links: [],
  steps: [
    {
      id: "check",
      kind: "prompt",
      role: "checker",
      prompt: "跑一遍发布清单并 post 结果",
      after: [],
    },
  ],
};

function template(
  id: string,
  body: WorkflowDraft,
  updated: number,
): WorkflowTemplateJson {
  return {
    id,
    name: body.title,
    version: body.version,
    createdFromDraft: null,
    template: body,
    createdAt: at(updated + 600),
    updatedAt: at(updated),
  };
}

export const TEMPLATES: WorkflowTemplateJson[] = [
  template("tpl-review", REVIEW, 60),
  template("tpl-paper", PAPER, 3_000),
  template("tpl-release", RELEASE, 9_000),
];

function step(
  stepId: string,
  patch: Partial<WorkflowRunStepJson>,
): WorkflowRunStepJson {
  return {
    stepId,
    kind: "prompt",
    role: null,
    status: "pending",
    nodeId: null,
    startedAt: null,
    endedAt: null,
    reason: null,
    outputs: [],
    decision: null,
    note: null,
    ...patch,
  };
}

function reviewRun(
  id: string,
  minutesAgo: number,
  branch: string,
  status: WorkflowRunJson["status"],
  steps: WorkflowRunStepJson[],
  reason: string | null = null,
): WorkflowRunJson {
  return {
    id,
    templateId: "tpl-review",
    templateVersion: 2,
    title: REVIEW.title,
    workspaceId: "ws",
    boardId: "board",
    frameId: `frame-${id}`,
    params: { repo: ".", branch },
    status,
    reason,
    roles: { reviewerA: "n-a", reviewerB: "n-b", lead: "n-l" },
    startedAt: at(minutesAgo),
    endedAt:
      status === "running" || status === "waiting" ? null : at(minutesAgo - 9),
    steps,
  };
}

const done = (
  stepId: string,
  role: string,
  body: string,
  kind: WorkflowRunStepJson["kind"] = "prompt",
) =>
  step(stepId, {
    kind,
    role,
    status: "done",
    nodeId: `n-${role}`,
    startedAt: at(30),
    endedAt: at(25),
    outputs: [{ key: `${stepId}:result`, body, at: at(26), target: "n-l" }],
  });

export const RUNS: WorkflowRunJson[] = [
  reviewRun("run-5", 12, "feat/workflow-pages", "waiting", [
    done(
      "frontend",
      "reviewerA",
      "两处必须改：表单缺参数时没有提示；对比框在窄屏溢出。",
    ),
    done("backend", "reviewerB", "没有阻断问题。"),
    done("summary", "lead", "必须改 2 项（前端），建议 1 项。", "collect"),
    step("merge", { kind: "gate", status: "waiting", startedAt: at(5) }),
  ]),
  reviewRun("run-4", 180, "feat/workflow-pages", "succeeded", [
    done(
      "frontend",
      "reviewerA",
      "三处必须改：表单缺参数时没有提示；对比框在窄屏溢出；关卡按钮顺序反了。",
    ),
    done("backend", "reviewerB", "没有阻断问题。"),
    done("summary", "lead", "必须改 3 项（前端）。", "collect"),
    step("merge", {
      kind: "gate",
      status: "done",
      decision: "approve",
      note: "改完再合",
    }),
  ]),
  reviewRun(
    "run-3",
    1_440,
    "fix/schedule-gate",
    "failed",
    [
      done("frontend", "reviewerA", "没有改动。"),
      step("backend", {
        role: "reviewerB",
        status: "failed",
        reason: "turnFailed",
      }),
      step("summary", { kind: "collect", role: "lead", status: "skipped" }),
      step("merge", { kind: "gate", status: "skipped" }),
    ],
    "backend:turnFailed",
  ),
  reviewRun(
    "run-2",
    2_900,
    "main",
    "cancelled",
    [
      step("frontend", { role: "reviewerA", status: "cancelled" }),
      step("backend", { role: "reviewerB", status: "cancelled" }),
      step("summary", { kind: "collect", role: "lead", status: "cancelled" }),
      step("merge", { kind: "gate", status: "cancelled" }),
    ],
    "cancelledByUser",
  ),
  reviewRun("run-1", 4_400, "feat/runners", "running", [
    step("frontend", { role: "reviewerA", status: "running" }),
    step("backend", { role: "reviewerB", status: "running" }),
    step("summary", { kind: "collect", role: "lead" }),
    step("merge", { kind: "gate" }),
  ]),
];

/** 展开的那一行，与勾了对比的两行。 */
export const EXPANDED = "run-5";
export const COMPARED = ["run-4", "run-5"];
