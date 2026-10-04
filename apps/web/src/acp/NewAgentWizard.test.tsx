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
  Workspace,
} from "@armadra/shared";

/**
 * 新建 Agent 向导（ACP 设计 §8 第 1 条）：未装适配器的灰掉并给命令；
 * 走完三步即起会话（任务作为第一条 prompt）并建出带 `sessionId` 的 ACP 节点。
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
const platform = vi.hoisted(() => ({
  desktop: false,
  pickDirectory: vi.fn<() => Promise<string | null>>(),
}));
vi.mock("@/platform", async (original) => ({
  ...(await original<object>()),
  isDesktop: () => platform.desktop,
  pickDirectory: platform.pickDirectory,
}));
vi.mock("@/platform/layout", async (original) => ({
  ...(await original<object>()),
  useCompactLayout: () => false,
}));

const { installDomPolyfills, TestProviders } = await import(
  "@/app/test-harness"
);
const { useCanvasStore, resetHistory } = await import("@/store/canvas-store");
const { NewAgentWizard, folderChoices, wizardAgents } = await import(
  "./NewAgentWizard"
);
const { openNewAgentWizard, useWizardOpen } = await import("./wizard-open");

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
  platform.desktop = false;
  platform.pickDirectory.mockReset();
  agents.list = [
    agent("claude", "Claude Code", false),
    agent("codex", "Codex", true),
    { ...agent("plain", "Plain", true), acp: undefined } as AgentInfo,
  ];
  const document: BoardDocument = { board, nodes: [], edges: [] };
  useCanvasStore.getState().setWorkspace(workspace);
  useCanvasStore.getState().setDocument(document);
  resetHistory();
  useWizardOpen.setState({ open: false, at: null });
});
afterEach(cleanup);

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

  it("走完三步：起会话带首条 prompt，建出带 sessionId 的 ACP 节点", async () => {
    api.createSession.mockResolvedValue({ id: "sess-1" });
    openNewAgentWizard({ x: 500, y: 300 });
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: "继续" }));
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    fireEvent.click(screen.getByRole("radio", { name: "补测试" }));
    const task = screen.getByLabelText("任务") as HTMLTextAreaElement;
    expect(task.value).toContain("测试");
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(useWizardOpen.getState().open).toBe(false));
    expect(api.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: workspace.id,
        cwd: "/repo",
        agentId: "codex",
        prompt: task.value.trim(),
      }),
    );
    const nodeId = api.createSession.mock.calls[0]![0].nodeId as string;
    const node = useCanvasStore
      .getState()
      .document?.nodes.find((item) => item.id === nodeId);
    expect(node?.type).toBe("terminal");
    expect(node?.data).toMatchObject({
      kind: "terminal",
      sessionId: "sess-1",
      agent: { id: "codex", driver: "acp" },
    });
  });

  it("创建失败停在第三步并给错误行，不建节点", async () => {
    api.createSession.mockRejectedValue(new Error("acp_not_installed"));
    openNewAgentWizard();
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: "继续" }));
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    fireEvent.change(screen.getByLabelText("任务"), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByText("没有创建成功")).toBeTruthy();
    expect(useWizardOpen.getState().open).toBe(true);
    expect(useCanvasStore.getState().document?.nodes).toEqual([]);
  });

  it("第二步「选择文件夹…」：桌面壳选的目录成为会话 cwd 并写进节点", async () => {
    platform.desktop = true;
    platform.pickDirectory.mockResolvedValue("/elsewhere/project");
    api.createSession.mockResolvedValue({ id: "sess-2" });
    openNewAgentWizard();
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: "继续" }));
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹…" }));
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "目录" }).textContent,
      ).toContain("/elsewhere/project"),
    );
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(useWizardOpen.getState().open).toBe(false));
    expect(api.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/elsewhere/project" }),
    );
    const node = useCanvasStore.getState().document?.nodes[0];
    expect(node?.data).toMatchObject({ cwd: "/elsewhere/project" });
  });

  it("取消选择器不改目录", async () => {
    platform.desktop = true;
    platform.pickDirectory.mockResolvedValue(null);
    openNewAgentWizard();
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: "继续" }));
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹…" }));
    await waitFor(() => expect(platform.pickDirectory).toHaveBeenCalled());
    expect(
      screen.getByRole("combobox", { name: "目录" }).textContent,
    ).toContain("工作区根目录");
  });

  it("没有桌面壳、或远端工作空间时不给「选择文件夹…」", async () => {
    openNewAgentWizard();
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: "继续" }));
    expect(screen.queryByRole("button", { name: "选择文件夹…" })).toBeNull();
    cleanup();

    platform.desktop = true;
    useCanvasStore
      .getState()
      .setWorkspace({ ...workspace, executionHostId: "build-box" });
    openNewAgentWizard();
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: "继续" }));
    expect(screen.queryByRole("button", { name: "选择文件夹…" })).toBeNull();
  });

  it("没有可用的 Agent 时第一步就是空态", async () => {
    agents.list = [agent("claude", "Claude Code", false)];
    openNewAgentWizard();
    renderWizard();
    expect(await screen.findByText("还没有可用的 Agent")).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开集成设置" })).toBeTruthy();
  });
});

describe("纯函数", () => {
  it("目录候选：根在最前、去重、最多六个", () => {
    expect(
      folderChoices("/r", [
        "/r",
        "/a",
        undefined,
        "/a",
        "/b",
        "/c",
        "/d",
        "/e",
        "/f",
      ]),
    ).toEqual(["/r", "/a", "/b", "/c", "/d", "/e"]);
  });

  it("只列有 acp 字段的", () => {
    expect(wizardAgents(agents.list).map((item) => item.id)).toEqual([
      "claude",
      "codex",
    ]);
  });
});
