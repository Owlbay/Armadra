import type { CanvasNode, WorkflowDraftRow } from "@armadra/shared";

/**
 * `coordinator` 分区的假数据（设计展示页 §2.1，设计系统 §5.4）：ama 派出三个
 * 成员（done / working / failed），主从边从 ama 指向每个成员；外加一张
 * `workflow_propose` 的草案卡。纯对象，无副作用；标题是用户内容。
 */

const BOARD = "00000000-0000-4000-8000-0000000000c0";
const AT = "2026-10-03T09:00:00.000Z";

export const COORDINATOR_IDS = {
  lead: "00000000-0000-4000-8000-0000000000c1",
  done: "00000000-0000-4000-8000-0000000000c2",
  working: "00000000-0000-4000-8000-0000000000c3",
  failed: "00000000-0000-4000-8000-0000000000c4",
} as const;

function terminal(
  id: string,
  title: string,
  agentId: string,
  position: { x: number; y: number },
): CanvasNode {
  return {
    id,
    boardId: BOARD,
    type: "terminal",
    title,
    color: "#0a84ff",
    labels: [],
    note: "",
    position,
    // 节点宽 >440 才画头部徽标与状态胶囊（`nodes.css` 的容器查询）。
    size: { width: 456, height: 84 },
    data: { kind: "terminal", agent: { id: agentId } },
    createdAt: AT,
    updatedAt: AT,
  } as CanvasNode;
}

export const COORDINATOR_NODES: CanvasNode[] = [
  terminal(COORDINATOR_IDS.lead, "审查 src/x 与 src/y", "ama", {
    x: 16,
    y: 120,
  }),
  terminal(COORDINATOR_IDS.done, "src/x", "claude", { x: 560, y: 16 }),
  terminal(COORDINATOR_IDS.working, "src/y", "codex", { x: 560, y: 120 }),
  terminal(COORDINATOR_IDS.failed, "文档", "pi", { x: 560, y: 224 }),
];

export const COORDINATOR_EDGES = [
  COORDINATOR_IDS.done,
  COORDINATOR_IDS.working,
  COORDINATOR_IDS.failed,
].map((target) => ({
  id: `edge-${target}`,
  type: "link",
  source: COORDINATOR_IDS.lead,
  target,
  data: { role: "supervises" },
}));

/** 正在跑的那一个成员是工作流的第几步。 */
export const WORKING_STEP = 2;

export const BODY_LINES: Record<string, string> = {
  [COORDINATOR_IDS.lead]: "canvas_team → 3 成员",
  [COORDINATOR_IDS.done]: "✓ 结论已 post 给 ama",
  [COORDINATOR_IDS.working]: "> 读取 src/y/store.ts",
  [COORDINATOR_IDS.failed]: "✗ 本轮失败：上下文超限",
};

export const DRAFT: WorkflowDraftRow = {
  id: "draft-1",
  workspaceId: "ws",
  boardId: BOARD,
  proposerNodeId: COORDINATOR_IDS.lead,
  status: "pending",
  templateId: null,
  createdAt: AT,
  updatedAt: AT,
  draft: {
    version: 1,
    title: "双人审查后汇总",
    params: [],
    roles: [
      { id: "a", agentId: "claude", title: "前端" },
      { id: "b", agentId: "codex", title: "后端" },
      { id: "lead", agentId: "ama", title: "汇总" },
    ],
    links: [
      { from: "lead", to: "a", role: "supervises" },
      { from: "lead", to: "b", role: "supervises" },
    ],
    steps: [
      { id: "s1", kind: "prompt", role: "a", prompt: "审查前端", after: [] },
      { id: "s2", kind: "prompt", role: "b", prompt: "审查后端", after: [] },
      {
        id: "s3",
        kind: "collect",
        role: "lead",
        from: ["s1", "s2"],
        prompt: "汇总",
        after: ["s1", "s2"],
      },
    ],
  },
};
