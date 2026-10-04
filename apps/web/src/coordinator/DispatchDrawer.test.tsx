import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { CanvasEdge, CanvasNode } from "@armadra/shared";

import { TestProviders, installDomPolyfills } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import { useAgentStatusStore } from "@/agent/status-store";
import { useCanvasStore } from "@/store/canvas-store";
import type { DispatchTask } from "./api";

const api = vi.hoisted(() => ({ tasks: vi.fn(), retry: vi.fn() }));

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  coordinatorApi: api,
}));

const { DispatchDrawer, DispatchView } = await import("./DispatchDrawer");
const { buildDispatch, memberCount } = await import("./model");
const { openDispatchDrawer } = await import("./store");
const { MembersChip } = await import("./MembersChip");

/** 协调者分派抽屉（设计系统 §5.4、契约 §15.7）。 */

const BOARD = "00000000-0000-4000-8000-0000000000b0";
const AT = "2026-10-04T08:00:00.000Z";
const ID = {
  lead: "00000000-0000-4000-8000-000000000001",
  claude: "00000000-0000-4000-8000-000000000002",
  codex: "00000000-0000-4000-8000-000000000003",
  pi: "00000000-0000-4000-8000-000000000004",
  sticky: "00000000-0000-4000-8000-000000000005",
  stray: "00000000-0000-4000-8000-000000000006",
};

function terminal(id: string, title: string, agentId: string): CanvasNode {
  return {
    id,
    boardId: BOARD,
    type: "terminal",
    title,
    color: "#0a84ff",
    labels: [],
    note: "",
    position: { x: 0, y: 0 },
    data: { kind: "terminal", agent: { id: agentId } },
    createdAt: AT,
    updatedAt: AT,
  } as CanvasNode;
}

const NODES: CanvasNode[] = [
  terminal(ID.lead, "审查 src/x 与 src/y", "ama"),
  terminal(ID.claude, "src/x", "claude"),
  terminal(ID.codex, "src/y", "codex"),
  terminal(ID.pi, "文档", "pi"),
  terminal(ID.stray, "无关", "claude"),
  {
    id: ID.sticky,
    boardId: BOARD,
    type: "sticky",
    title: "",
    color: "#0a84ff",
    labels: [],
    note: "",
    position: { x: 0, y: 0 },
    data: {
      kind: "sticky",
      content: "审查结论\n两处问题",
      source: { nodeId: ID.lead, sessionId: "s" },
    },
    createdAt: AT,
    updatedAt: AT,
  } as CanvasNode,
];

function supervises(target: string): CanvasEdge {
  return {
    id: `00000000-0000-4000-8000-0000000001${target.slice(-2)}`,
    boardId: BOARD,
    source: ID.lead,
    target,
    kind: "link",
    role: "supervises",
    createdAt: AT,
    updatedAt: AT,
  } as CanvasEdge;
}

const EDGES = [supervises(ID.claude), supervises(ID.codex), supervises(ID.pi)];

function task(
  nodeId: string,
  runnerId: string,
  patch: Partial<DispatchTask> = {},
): DispatchTask {
  return {
    taskId: `sess:${runnerId}`,
    coordinatorNodeId: ID.lead,
    runnerId,
    nodeId,
    status: "running",
    startedAt: "2026-10-04T08:00:00.000Z",
    endedAt: null,
    reason: null,
    retryable: false,
    ...patch,
  };
}

const TASKS: DispatchTask[] = [
  task(ID.claude, "claude", {
    status: "done",
    endedAt: "2026-10-04T08:12:00.000Z",
  }),
  task(ID.codex, "codex", { startedAt: "2026-10-04T08:01:00.000Z" }),
  task(ID.pi, "pi", {
    status: "failed",
    startedAt: "2026-10-04T08:02:00.000Z",
    endedAt: "2026-10-04T08:03:00.000Z",
    reason: "turnFailed",
    retryable: true,
  }),
];

const NOW = Date.parse("2026-10-04T08:05:00.000Z");

beforeAll(() => installDomPolyfills());

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  api.tasks.mockReset();
  api.retry.mockReset();
  useAgentStatusStore.setState({ statuses: {} });
  useCanvasStore.setState({
    boardId: BOARD,
    document: {
      board: { id: BOARD },
      nodes: NODES,
      edges: EDGES,
    } as never,
  });
  useCanvasStore.getState().setPanel("dispatch", "closed");
});

afterEach(() => cleanup());

describe("buildDispatch", () => {
  it("joins task rows, supervised members and summary stickies", () => {
    const model = buildDispatch({
      coordinatorId: ID.lead,
      nodes: NODES,
      edges: EDGES,
      tasks: [
        ...TASKS,
        // 同一节点的旧行被新行盖住；别的协调者的行不算。
        task(ID.codex, "codex", {
          taskId: "old",
          status: "failed",
          startedAt: "2026-10-04T07:00:00.000Z",
        }),
        task(ID.stray, "claude", { coordinatorNodeId: "other" }),
      ],
      states: { [ID.codex]: "blocked", [ID.lead]: "working" },
      now: NOW,
    });
    expect(model.lead).toMatchObject({
      nodeId: ID.lead,
      agentId: "ama",
      status: { tone: "working" },
    });
    expect(
      model.members.map((member) => [
        member.title,
        member.status.tone,
        member.elapsedMs,
        member.retryable,
      ]),
    ).toEqual([
      ["src/x", "done", 12 * 60_000, false],
      ["src/y", "attention", 4 * 60_000, false],
      ["文档", "failed", 60_000, true],
    ]);
    expect(model.summaries).toEqual([{ nodeId: ID.sticky, title: "审查结论" }]);
    expect(memberCount(ID.lead, NODES, EDGES)).toBe(3);
  });

  it("lists supervised terminals without task rows by live status", () => {
    const model = buildDispatch({
      coordinatorId: ID.lead,
      nodes: NODES,
      edges: EDGES,
      tasks: [],
      states: { [ID.pi]: "working" },
      now: NOW,
    });
    expect(model.members.map((member) => member.status.tone)).toEqual([
      "idle",
      "idle",
      "working",
    ]);
    expect(model.members.every((member) => member.elapsedMs === null)).toBe(
      true,
    );
  });
});

describe("DispatchView 五态", () => {
  const full = () =>
    buildDispatch({
      coordinatorId: ID.lead,
      nodes: NODES,
      edges: EDGES,
      tasks: TASKS,
      states: {},
      now: NOW,
    });

  it("空：一句话加一个聚焦 ama 的动作", () => {
    const onFocusLead = vi.fn();
    render(
      <TestProviders>
        <DispatchView
          model={buildDispatch({
            coordinatorId: ID.lead,
            nodes: NODES.slice(0, 1),
            edges: [],
            tasks: [],
            states: {},
            now: NOW,
          })}
          onFocusLead={onFocusLead}
        />
      </TestProviders>,
    );
    expect(screen.getByText("让 ama 组织一次分工")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "对 ama 说" }));
    expect(onFocusLead).toHaveBeenCalled();
  });

  it("加载：骨架而不是空态", () => {
    const { container } = render(
      <TestProviders>
        <DispatchView model={full()} loading />
      </TestProviders>,
    );
    expect(
      container.querySelector('[data-slot="dispatch-loading"]'),
    ).toBeTruthy();
    expect(screen.queryByText("让 ama 组织一次分工")).toBeNull();
  });

  it("错误：行内 Alert 带重新读取", () => {
    const onReload = vi.fn();
    render(
      <TestProviders>
        <DispatchView
          model={buildDispatch({
            coordinatorId: ID.lead,
            nodes: NODES.slice(0, 1),
            edges: [],
            tasks: [],
            states: {},
            now: NOW,
          })}
          error
          onReload={onReload}
        />
      </TestProviders>,
    );
    expect(screen.getByText("读不到分派记录")).toBeTruthy();
    expect(screen.queryByText("让 ama 组织一次分工")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    expect(onReload).toHaveBeenCalled();
  });

  it("有数据：三行成员、汇总「打开」、失败行「重试」", () => {
    const onRetry = vi.fn();
    const onOpen = vi.fn();
    const { container } = render(
      <TestProviders>
        <DispatchView model={full()} onRetry={onRetry} onOpen={onOpen} />
      </TestProviders>,
    );
    const rows = container.querySelectorAll('[data-slot="dispatch-member"]');
    expect(rows).toHaveLength(3);
    expect((rows[0] as HTMLElement).style.borderLeftColor).toBe(
      "var(--agent-claude)",
    );
    expect(within(rows[0] as HTMLElement).getByText("已完成")).toBeTruthy();
    expect(
      within(rows[0] as HTMLElement).getByText("12 分 00 秒"),
    ).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("运行中")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("本轮失败")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "重试" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledWith("sess:pi");
    expect(screen.getByText("汇总 → 便签「审查结论」")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    expect(onOpen).toHaveBeenCalledWith(ID.sticky);
  });

  it("权限：不能起 Agent 的人看到「只读」", () => {
    render(
      <TestProviders>
        <DispatchView model={full()} canRetry={false} />
      </TestProviders>,
    );
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.getByText("只读")).toBeTruthy();
  });

  it("离线：顶部 Alert，整棵树置灰、按钮禁用", () => {
    const { container } = render(
      <TestProviders>
        <DispatchView model={full()} offline onRetry={vi.fn()} />
      </TestProviders>,
    );
    expect(screen.getByText("已断开，正在重连")).toBeTruthy();
    const tree = container.querySelector('[data-slot="dispatch-tree"]');
    expect(tree?.getAttribute("data-offline")).toBe("true");
    expect(
      (screen.getByRole("button", { name: "重试" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("DispatchDrawer", () => {
  it("opens from the ama chip, reads the board's tasks and retries a failed row", async () => {
    api.tasks.mockResolvedValue(TASKS);
    api.retry.mockResolvedValue({ ...TASKS[2], status: "running" });
    render(
      <TestProviders>
        <MembersChip nodeId={ID.lead} />
        <DispatchDrawer />
      </TestProviders>,
    );
    fireEvent.click(screen.getByRole("button", { name: "3 成员" }));
    expect(useCanvasStore.getState().panels.dispatch).toBe("drawer");
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-slot="dispatch-member"]'),
      ).toHaveLength(3),
    );
    expect(api.tasks).toHaveBeenCalledWith(BOARD);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(api.retry).toHaveBeenCalledWith("sess:pi"));
  });

  it("closes with the header button", async () => {
    api.tasks.mockResolvedValue([]);
    openDispatchDrawer(ID.lead);
    render(
      <TestProviders>
        <DispatchDrawer />
      </TestProviders>,
    );
    await screen.findByText("分派");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(useCanvasStore.getState().panels.dispatch).toBe("closed");
  });
});
