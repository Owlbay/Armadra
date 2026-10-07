import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  AgentInfo,
  Board,
  BoardDocument,
  CanvasNode,
  Workspace,
} from "@armadra/shared";

/**
 * 新建 Agent 向导（ACP 设计 §8 第 1 条）：未装适配器的灰掉并给命令；
 * 选 Agent 点「创建」即在画布给的目录里起会话（不带 prompt），并建出带
 * `sessionId` 的 ACP 节点。不问目录、不问任务。
 */
vi.mock("@/nodes/registry", () => {
  const meta = {
    labelKey: "node.terminal",
    icon: null,
    defaultSize: { width: 600, height: 400 },
    minSize: { width: 160, height: 120 },
    defaultColor: "#0a84ff",
    hasBridgeHandles: false,
  };
  const table = new Proxy({} as Record<string, typeof meta>, {
    get: () => meta,
  });
  return {
    NODE_META: table,
    nodeMeta: () => meta,
    DRAG_HANDLE_CLASS: "drag-handle",
    NODE_DRAG_HANDLE: ".drag-handle",
  };
});

const api = vi.hoisted(() => ({ createSession: vi.fn() }));
vi.mock("./api", () => ({ acpApi: api }));

const agents = vi.hoisted(() => ({ list: [] as AgentInfo[] }));
vi.mock("@/app/use-agents", () => ({
  useAgentsQuery: () => ({ data: agents.list }),
}));
vi.mock("@/platform/layout", async (original) => ({
  ...(await original<object>()),
  useCompactLayout: () => false,
}));

const { installDomPolyfills, TestProviders } = await import(
  "@/app/test-harness"
);
const { useCanvasStore, resetHistory } = await import("@/store/canvas-store");
const { NewAgentWizard, spawnPosition, wizardAgents } = await import(
  "./NewAgentWizard"
);
const { openNewAgentWizard, openSpawnAgentWizard, useWizardOpen } =
  await import("./wizard-open");

installDomPolyfills();

const stamp = "2026-10-03T00:00:00.000Z";
const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "One",
  rootPath: "/repo",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: stamp,
  createdAt: stamp,
  updatedAt: stamp,
};
const board: Board = {
  id: "019ff7d1-7419-74df-89e2-b1619d36ea7d",
  workspaceId: workspace.id,
  name: "Default",
  sortOrder: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  whiteboard: "",
  createdAt: stamp,
  updatedAt: stamp,
};

function agent(id: string, label: string, acpInstalled: boolean): AgentInfo {
  return {
    id,
    label,
    installed: true,
    resolvedPath: `/usr/bin/${id}`,
    launchCmd: id,
    color: "#d97757",
    acp: {
      support: "official",
      program: `${id}-acp`,
      installed: acpInstalled,
      resume: "load",
    },
  } as unknown as AgentInfo;
}

beforeEach(() => {
  api.createSession.mockReset();
  agents.list = [
    agent("claude", "Claude Code", false),
    agent("codex", "Codex", true),
    { ...agent("plain", "Plain", true), acp: undefined } as AgentInfo,
  ];
  const document: BoardDocument = { board, nodes: [], edges: [] };
  useCanvasStore.getState().setWorkspace(workspace);
  useCanvasStore.getState().setDocument(document);
  resetHistory();
  useWizardOpen.setState({ open: false, at: null, supervisorNodeId: null });
});
afterEach(cleanup);

/** 盖住整片画布、绑定了 worktree 的分组：落点怎么摆都在它里面。 */
function boundFrame(): CanvasNode {
  return {
    id: "019ff7d1-0000-7000-8000-00000000f001",
    boardId: board.id,
    type: "group",
    title: "feature/login",
    color: "#0a84ff",
    position: { x: -5000, y: -5000 },
    size: { width: 10000, height: 10000 },
    labels: [],
    note: "",
    data: {
      kind: "group",
      binding: {
        worktreePath: ".armadra/worktrees/feature",
        branch: "feature/login",
        repositoryId: "repo-1",
        initScript: null,
        initScriptState: "none",
        initScriptNodeId: null,
      },
    },
    createdAt: stamp,
    updatedAt: stamp,
  } as CanvasNode;
}

function renderWizard() {
  return render(
    <TestProviders>
      <NewAgentWizard />
    </TestProviders>,
  );
}

describe("NewAgentWizard", () => {
  it("只列有 ACP 入口的；没装适配器的灰掉并给安装命令", async () => {
    openNewAgentWizard();
    renderWizard();
    const claude = await screen.findByText("Claude Code");
    const row = claude.closest("[data-agent-row]") as HTMLElement;
    expect(row.dataset.disabled).toBe("true");
    expect(row.querySelector("button[role=radio]")).toHaveProperty(
      "disabled",
      true,
    );
    const copy = screen.getByRole("button", { name: "复制命令" });
    expect(copy.getAttribute("title")).toBe(
      "npm i -g @agentclientprotocol/claude-agent-acp",
    );
    expect(screen.queryByText("Plain")).toBeNull();
    // 能用的那一家默认选中。
    const codexRow = screen
      .getByText("Codex")
      .closest("[data-agent-row]") as HTMLElement;
    expect(
      codexRow.querySelector("button[role=radio]")?.getAttribute("data-state"),
    ).toBe("checked");
  });

  it("一步：选 Agent 点「创建」，在工作区根起会话、不带 prompt，建出 ACP 节点", async () => {
    api.createSession.mockResolvedValue({ id: "sess-1" });
    openNewAgentWizard({ x: 500, y: 300 });
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: "创建" }));

    await waitFor(() => expect(useWizardOpen.getState().open).toBe(false));
    const call = api.createSession.mock.calls[0]![0];
    expect(call).toMatchObject({
      workspaceId: workspace.id,
      cwd: "/repo",
      agentId: "codex",
    });
    expect(call).not.toHaveProperty("prompt");
    const node = useCanvasStore
      .getState()
      .document?.nodes.find((item) => item.id === call.nodeId);
    expect(node?.type).toBe("terminal");
    expect(node?.data).toMatchObject({
      kind: "terminal",
      sessionId: "sess-1",
      agent: { id: "codex", driver: "acp" },
    });
  });

  it("不问目录、不问任务：对话框里没有这两项，也没有「继续 / 上一步」", async () => {
    openNewAgentWizard();
    renderWizard();
    await screen.findByRole("button", { name: "创建" });
    expect(screen.queryByLabelText("目录")).toBeNull();
    expect(screen.queryByLabelText("任务")).toBeNull();
    expect(screen.queryByRole("button", { name: "继续" })).toBeNull();
    expect(screen.queryByRole("button", { name: "上一步" })).toBeNull();
  });

  it("创建失败留在对话框并给错误行，不建节点", async () => {
    api.createSession.mockRejectedValue(new Error("acp_not_installed"));
    openNewAgentWizard();
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: "创建" }));
    expect(await screen.findByText("没有创建成功")).toBeTruthy();
    expect(useWizardOpen.getState().open).toBe(true);
    expect(useCanvasStore.getState().document?.nodes).toEqual([]);
  });

  it("落点在绑定了 worktree 的分组里：会话开在那个 checkout，节点继承同一目录", async () => {
    useCanvasStore.getState().setDocument({
      board,
      nodes: [boundFrame()],
      edges: [],
    });
    api.createSession.mockResolvedValue({ id: "sess-3" });
    openNewAgentWizard({ x: 500, y: 300 });
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: "创建" }));
    await waitFor(() => expect(useWizardOpen.getState().open).toBe(false));
    expect(api.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/repo/.armadra/worktrees/feature" }),
    );
    const node = useCanvasStore
      .getState()
      .document?.nodes.find((item) => item.type === "terminal");
    expect(node?.data).toMatchObject({
      cwd: "/repo/.armadra/worktrees/feature",
    });
  });

  it("没有可用的 Agent 时是空态", async () => {
    agents.list = [agent("claude", "Claude Code", false)];
    openNewAgentWizard();
    renderWizard();
    expect(await screen.findByText("还没有可用的 Agent")).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开集成设置" })).toBeTruthy();
  });
});

describe("派生 Agent", () => {
  const lead: CanvasNode = {
    id: "019ff7d1-0000-7000-8000-00000000a001",
    boardId: board.id,
    type: "terminal",
    title: "Lead",
    color: "#0a84ff",
    position: { x: 100, y: 200 },
    size: { width: 600, height: 400 },
    labels: [],
    note: "",
    data: { kind: "terminal", agent: { id: "codex", driver: "acp" } },
    createdAt: stamp,
    updatedAt: stamp,
  } as CanvasNode;

  it("同一个向导：标题换成「派生 Agent」，建好后连主从边并放在主的右侧；撤销一次全回", async () => {
    useCanvasStore.getState().setDocument({ board, nodes: [lead], edges: [] });
    resetHistory();
    api.createSession.mockResolvedValue({ id: "sess-spawn" });
    openSpawnAgentWizard(lead.id);
    renderWizard();
    expect(await screen.findByText("派生 Agent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(useWizardOpen.getState().open).toBe(false));

    const document = useCanvasStore.getState().document!;
    const created = document.nodes.find((node) => node.id !== lead.id)!;
    expect(created.position).toEqual({ x: 100 + 600 + 60, y: 200 });
    expect(document.edges).toHaveLength(1);
    expect(document.edges[0]).toMatchObject({
      source: lead.id,
      target: created.id,
      role: "supervises",
    });

    useCanvasStore.getState().undo();
    const after = useCanvasStore.getState().document!;
    expect(after.nodes.map((node) => node.id)).toEqual([lead.id]);
    expect(after.edges).toEqual([]);
  });

  it("右侧已经有节点时往下错开", () => {
    const taken = {
      ...lead,
      id: "019ff7d1-0000-7000-8000-00000000a002",
      position: { x: 760, y: 200 },
    } as CanvasNode;
    const position = spawnPosition([lead, taken], lead.id)!;
    expect(position.x).toBe(760);
    expect(position.y).toBeGreaterThanOrEqual(200 + 400);
    expect(spawnPosition([lead], "missing")).toBeNull();
  });
});

describe("纯函数", () => {
  it("只列有 acp 字段的", () => {
    expect(wizardAgents(agents.list).map((item) => item.id)).toEqual([
      "claude",
      "codex",
    ]);
  });
});
