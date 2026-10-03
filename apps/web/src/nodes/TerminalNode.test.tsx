import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CanvasNode, TerminalNodeData } from "@armadra/shared";

/**
 * 终端节点的节点体二选一（ACP 设计 §4.1、§6）：`agent.driver === "acp"` 画
 * 会话视图，其余画终端；头部 `⋯` 里「会话视图 / 终端视图」打钩并经 core 切换。
 */

vi.mock("@/terminal/TerminalSurface", async () => {
  const React = await import("react");
  return {
    BELL_FLASH_MS: 600,
    // 表面一挂上就报「已退出」：节点头要不要把它带到会话视图上，是下面那条用例。
    TerminalSurface: React.forwardRef(
      (props: { onStatusChange?: (status: unknown) => void }, _ref) => {
        React.useEffect(() => {
          props.onStatusChange?.({
            connection: "exited",
            exitCode: 0,
            error: null,
            render: "live",
          });
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);
        return <div data-testid="terminal-surface" />;
      },
    ),
  };
});
vi.mock("@/acp/SessionView", () => ({
  default: ({ nodeId }: { nodeId: string }) => (
    <div data-testid="session-view">{nodeId}</div>
  ),
}));
vi.mock("@/panels/resources/MemoryBadge", () => ({ MemoryBadge: () => null }));

const switchDriver = vi.hoisted(() => vi.fn());
// 服务器壳上「答得了审批」由会话决定；缺省答得了（桌面壳的情形）。
const access = vi.hoisted(() => ({ canAnswer: true }));
vi.mock("@/app/use-access", async (original) => ({
  ...(await original<typeof import("@/app/use-access")>()),
  useCanAnswer: () => access.canAnswer,
}));
vi.mock("@/acp/api", () => ({
  acpApi: { switchDriver },
}));

import { setAgentRegistry } from "@/agent/launch";
import { useAgentStatusStore } from "@/agent/status-store";
import { useWorkflowNodeSteps } from "@/workflow/node-steps";
import { installDomPolyfills } from "@/app/test-harness";
import { renderFlow } from "@/canvas/test-support";
import { useCanvasStore } from "@/store/canvas-store";
import { TerminalNode } from "./TerminalNode";

function terminalNode(data: TerminalNodeData): CanvasNode {
  return {
    id: "n1",
    boardId: "b1",
    type: "terminal",
    title: "codex",
    position: { x: 0, y: 0 },
    size: { width: 480, height: 320 },
    data,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  } as CanvasNode;
}

function renderNode(node: CanvasNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderFlow(
    <QueryClientProvider client={client}>
      <TerminalNode
        id={node.id}
        node={node}
        selected={false}
        collapsed={false}
        focused={false}
      />
    </QueryClientProvider>,
    { nodeId: node.id },
  );
}

beforeAll(installDomPolyfills);

const codexRow = {
  id: "codex",
  label: "Codex",
  color: "#10a37f",
  acp: {
    support: "official",
    program: "codex-acp",
    installed: true,
    resume: "load",
  },
};

beforeEach(() => {
  switchDriver.mockReset();
  access.canAnswer = true;
  useAgentStatusStore.setState({ statuses: {} });
  useWorkflowNodeSteps.setState({ steps: {} });
  setAgentRegistry([codexRow] as never);
});

afterEach(() => {
  cleanup();
  setAgentRegistry([]);
});

describe("TerminalNode body", () => {
  it("draws the session view for an ACP-driven node", async () => {
    renderNode(
      terminalNode({ kind: "terminal", agent: { id: "codex", driver: "acp" } }),
    );
    expect(await screen.findByTestId("session-view")).toBeTruthy();
    expect(screen.queryByTestId("terminal-surface")).toBeNull();
  });

  it("draws the terminal when the driver is terminal or absent", () => {
    renderNode(terminalNode({ kind: "terminal", agent: { id: "codex" } }));
    expect(screen.getByTestId("terminal-surface")).toBeTruthy();
    expect(screen.queryByTestId("session-view")).toBeNull();
  });

  it("does not carry the terminal's exit onto the session view", async () => {
    const terminal = terminalNode({ kind: "terminal", agent: { id: "codex" } });
    const view = renderNode(terminal);
    expect(await screen.findByText(/已退出/)).toBeTruthy();
    view.rerenderNode(
      <QueryClientProvider client={new QueryClient()}>
        <TerminalNode
          id="n1"
          node={terminalNode({
            kind: "terminal",
            agent: { id: "codex", driver: "acp" },
          })}
          selected={false}
          collapsed={false}
          focused={false}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("session-view")).toBeTruthy();
    expect(screen.queryByText(/已退出/)).toBeNull();
  });

  it("switches through the core from the header menu and records the new driver", async () => {
    const node = terminalNode({
      kind: "terminal",
      sessionId: "11111111-1111-4111-8111-111111111111",
      agent: { id: "codex" },
    });
    const updateNodeData = vi.fn();
    const original = useCanvasStore.getState();
    useCanvasStore.setState({
      document: { nodes: [node] } as never,
      updateNodeData,
    });
    switchDriver.mockResolvedValue({
      sessionId: "22222222-2222-4222-8222-222222222222",
      resumed: true,
    });
    try {
      renderNode(node);
      const trigger = screen.getByRole("button", { name: "更多" });
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      const session = await screen.findByRole("menuitemradio", {
        name: "会话视图",
      });
      expect(
        screen
          .getByRole("menuitemradio", { name: "终端视图" })
          .getAttribute("aria-checked"),
      ).toBe("true");
      fireEvent.click(session);
      await waitFor(() =>
        expect(updateNodeData).toHaveBeenCalledWith(
          "n1",
          {
            agent: { id: "codex", driver: "acp" },
            sessionId: "22222222-2222-4222-8222-222222222222",
            // 上一种驱动留下的退出码不属于新的这一代。
            lastExitCode: null,
          },
          { history: "ignore" },
        ),
      );
      expect(switchDriver).toHaveBeenCalledWith("n1", "acp");
    } finally {
      useCanvasStore.setState({
        document: original.document,
        updateNodeData: original.updateNodeData,
      });
    }
  });

  it("offers no switch for an agent without an ACP entry", async () => {
    setAgentRegistry([{ ...codexRow, acp: undefined }] as never);
    renderNode(terminalNode({ kind: "terminal", agent: { id: "codex" } }));
    const trigger = screen.getByRole("button", { name: "更多" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitemradio")).toBeNull();
  });

  it("shows who it waits for instead of approval buttons to someone who cannot answer", () => {
    access.canAnswer = false;
    useAgentStatusStore.setState({
      statuses: {
        n1: {
          nodeId: "n1",
          workspaceId: "w",
          agentId: "codex",
          state: "blocked",
          pendingId: "p1",
          unread: false,
          verified: true,
          restored: false,
          updatedAt: "2026-10-03T00:00:00.000Z",
        },
      } as never,
    });
    renderNode(terminalNode({ kind: "terminal", agent: { id: "codex" } }));
    expect(screen.getByText("等待接管")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "允许" })).toBeNull();
  });

  it("puts the running workflow step in front of the status pill", () => {
    useWorkflowNodeSteps.setState({ steps: { n1: 2 } });
    renderNode(terminalNode({ kind: "terminal", agent: { id: "codex" } }));
    expect(screen.getByText("第 2 步")).toBeTruthy();
  });
});
