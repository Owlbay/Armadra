import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  AcpLogResponse,
  TerminalNodeData,
  WorkspaceEvent,
} from "@armadra/shared";

/** 假 core：会话视图只经 `acpApi` 说话，换掉这一个模块就够了。 */
const api = vi.hoisted(() => ({
  createSession: vi.fn(),
  log: vi.fn(),
  prompt: vi.fn(),
  cancel: vi.fn(),
  setMode: vi.fn(),
  switchDriver: vi.fn(),
  answer: vi.fn(),
  drive: vi.fn(),
}));
vi.mock("./api", () => ({ acpApi: api }));

const store = vi.hoisted(() => ({
  workspace: { id: "w1", rootPath: "/repo" },
  document: null,
  updateNodeData: vi.fn(),
}));
vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

import { dispatchWorkspaceEvent } from "@/api/events";
import { SessionView } from "./SessionView";
import { useAcpStore } from "./store";

const SESSION = "11111111-1111-4111-8111-111111111111";

const data: TerminalNodeData = {
  kind: "terminal",
  sessionId: SESSION,
  cwd: "/repo",
  agent: { id: "codex", driver: "acp" },
};

const emptyLog: AcpLogResponse = { entries: [], endOffset: 0 };

function emit(event: Record<string, unknown>) {
  act(() => dispatchWorkspaceEvent(event as WorkspaceEvent));
}

const update = (body: Record<string, unknown>) =>
  emit({ type: "acp.update", sessionId: SESSION, nodeId: "n1", update: body });

const text = (sessionUpdate: string, value: string) =>
  update({ sessionUpdate, content: { type: "text", text: value } });

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.log.mockResolvedValue(emptyLog);
  api.prompt.mockResolvedValue({ turnId: "turn-1" });
  api.drive.mockResolvedValue({});
  api.answer.mockResolvedValue({});
  api.cancel.mockResolvedValue(undefined);
  useAcpStore.getState().reset();
});

afterEach(cleanup);

describe("SessionView", () => {
  it("同一个节点挂两份会话视图（手机焦点页 + 画布）时分块只拼一遍", async () => {
    render(
      <>
        <SessionView nodeId="n1" data={data} />
        <SessionView nodeId="n1" data={data} />
      </>,
    );
    await waitFor(() =>
      expect(screen.getAllByText("向它说第一句话")).toHaveLength(2),
    );
    useAcpStore.getState().begin(SESSION, "hi");
    text("agent_message_chunk", "echo: ");
    text("agent_message_chunk", "hi");
    expect(screen.getAllByText("echo: hi")).toHaveLength(2);
    expect(screen.queryByText("echo: hiecho: hi")).toBeNull();
  });

  it("shows skeletons while loading, then the empty state", async () => {
    let resolve: (log: AcpLogResponse) => void = () => undefined;
    api.log.mockReturnValue(new Promise((done) => (resolve = done)));
    const { container } = render(<SessionView nodeId="n1" data={data} />);
    expect(container.querySelector('[data-slot="acp-loading"]')).not.toBeNull();
    await act(async () => resolve(emptyLog));
    expect(await screen.findByText("向它说第一句话")).toBeTruthy();
    expect(api.log).toHaveBeenCalledWith(SESSION);
  });

  it("turns the event stream into messages, tool rows and a permission card", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText("向它说第一句话");

    const input = screen.getByLabelText("消息");
    fireEvent.change(input, { target: { value: "跑一下测试" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(api.prompt).toHaveBeenCalledWith(SESSION, "跑一下测试"),
    );
    expect(screen.getByText("跑一下测试")).toBeTruthy();
    // 回合进行中：尾部 Spinner，发送钮换成停止。
    expect(screen.getByLabelText("正在输出")).toBeTruthy();
    expect(screen.getByLabelText("停止")).toBeTruthy();

    text("agent_message_chunk", "Running ");
    text("agent_message_chunk", "tests");
    expect(screen.getByText("Running tests")).toBeTruthy();

    update({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "pnpm test",
      kind: "execute",
      status: "in_progress",
    });
    expect(screen.getByText("pnpm test")).toBeTruthy();
    expect(screen.getByText("运行中")).toBeTruthy();
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    });
    expect(screen.getByText("已完成")).toBeTruthy();

    emit({
      type: "agent.approval",
      nodeId: "n1",
      pendingId: "n1-1-acp-t2",
      request: {
        id: "n1-1-acp-t2",
        request: {
          protocol: "acp",
          toolCall: { toolCallId: "t2", title: "rm -rf dist" },
          options: [
            { optionId: "ok", name: "Allow", kind: "allow_once" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
        },
      },
    });
    expect(screen.getByText("rm -rf dist")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "本次允许" }));
    expect(api.answer).toHaveBeenCalledWith("n1-1-acp-t2", "allow", "ok");
    expect(screen.queryByText("rm -rf dist")).toBeNull();

    emit({
      type: "acp.turn",
      sessionId: SESSION,
      nodeId: "n1",
      turnId: "turn-1",
      stopReason: "end_turn",
    });
    expect(screen.queryByLabelText("正在输出")).toBeNull();
    expect(screen.getByLabelText("发送")).toBeTruthy();

    // 回合边界之后的输出是新的一条，不接在上一条后面。
    text("agent_message_chunk", "Next");
    expect(screen.getByText("Next")).toBeTruthy();
    expect(screen.getByText("Running tests")).toBeTruthy();
  });

  it("ignores events of other sessions", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText("向它说第一句话");
    emit({
      type: "acp.update",
      sessionId: "other",
      nodeId: "n2",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "elsewhere" },
      },
    });
    expect(screen.queryByText("elsewhere")).toBeNull();
  });

  it("rebuilds from the log and draws a pending permission after a reload", async () => {
    api.log.mockResolvedValue({
      entries: [
        {
          role: "user",
          blocks: [{ type: "text", text: "hello" }],
          endOffset: 5,
        },
        {
          role: "assistant",
          blocks: [{ type: "text", text: "hi there" }],
          endOffset: 9,
        },
      ],
      endOffset: 9,
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
        ],
      },
      pending: [
        {
          pendingId: "p1",
          protocol: "acp",
          toolCall: { toolCallId: "t9", title: "write a.ts" },
          options: [{ optionId: "y", name: "Allow", kind: "allow_always" }],
        },
      ],
    } satisfies AcpLogResponse);
    render(<SessionView nodeId="n1" data={data} />);
    expect(await screen.findByText("hello")).toBeTruthy();
    expect(screen.getByText("hi there")).toBeTruthy();
    expect(screen.getByText("write a.ts")).toBeTruthy();
    expect(screen.getByRole("button", { name: "始终允许" })).toBeTruthy();
    expect(screen.getByLabelText("模式")).toBeTruthy();
  });

  it("drops chunks that arrive before the log answers", async () => {
    let resolve: (log: AcpLogResponse) => void = () => undefined;
    api.log.mockReturnValue(new Promise((done) => (resolve = done)));
    render(<SessionView nodeId="n1" data={data} />);
    // core 先写镜像再发事件：这一块已经在读回来的记录里了。
    text("agent_message_chunk", "already");
    await act(async () =>
      resolve({
        entries: [
          {
            role: "assistant",
            blocks: [{ type: "text", text: "already" }],
            endOffset: 7,
          },
        ],
        endOffset: 7,
      }),
    );
    expect(await screen.findAllByText("already")).toHaveLength(1);
  });

  it("offers a retry when the log cannot be read", async () => {
    api.log.mockRejectedValueOnce(new Error("down"));
    render(<SessionView nodeId="n1" data={data} />);
    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByText("向它说第一句话")).toBeTruthy();
    expect(api.log).toHaveBeenCalledTimes(2);
  });

  it("shows a failed turn with a retry that resends the prompt", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    const input = await screen.findByLabelText("消息");
    await screen.findByText("向它说第一句话");
    fireEvent.change(input, { target: { value: "go" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.prompt).toHaveBeenCalledTimes(1));
    emit({
      type: "acp.turn",
      sessionId: SESSION,
      nodeId: "n1",
      turnId: "turn-1",
      stopReason: "refusal",
    });
    expect(screen.getByText("这一轮没有完成")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(api.prompt).toHaveBeenCalledTimes(2));
    expect(api.prompt).toHaveBeenLastCalledWith(SESSION, "go");
  });

  it("starts a session when the node has none and records its id", async () => {
    api.createSession.mockResolvedValue({ id: SESSION });
    const fresh: TerminalNodeData = {
      kind: "terminal",
      cwd: "/repo/app",
      agent: { id: "codex", driver: "acp", permissionMode: "plan" },
    };
    render(<SessionView nodeId="n1" data={fresh} />);
    await waitFor(() =>
      expect(store.updateNodeData).toHaveBeenCalledWith(
        "n1",
        { sessionId: SESSION, lastExitCode: null },
        { history: "ignore" },
      ),
    );
    expect(api.createSession).toHaveBeenCalledWith({
      workspaceId: "w1",
      nodeId: "n1",
      cwd: "/repo/app",
      agentId: "codex",
      permissionMode: "plan",
    });
  });

  it("leaves the loading state once the new session id is written back", async () => {
    // 写回会话 id 会让起会话的 effect 自己被清理（依赖变了）；清理之后「正在起」
    // 也得收起，否则骨架屏永远不走（真浏览器里撞出来的）。
    api.createSession.mockResolvedValue({ id: SESSION });
    api.log.mockResolvedValue(emptyLog);
    const fresh: TerminalNodeData = {
      kind: "terminal",
      agent: { id: "codex", driver: "acp" },
    };
    // 真画布里写回节点数据会同步重渲染这个节点：在写回的那一刻就换上新 id。
    let view: ReturnType<typeof render> | undefined;
    store.updateNodeData.mockImplementationOnce(() => {
      view?.rerender(
        <SessionView nodeId="n1" data={{ ...fresh, sessionId: SESSION }} />,
      );
    });
    view = render(<SessionView nodeId="n1" data={fresh} />);
    expect(await screen.findByText("向它说第一句话")).toBeTruthy();
    expect(document.querySelector('[data-slot="acp-loading"]')).toBeNull();
  });

  it("says the session did not start and retries", async () => {
    api.createSession.mockRejectedValueOnce(new Error("acp_not_installed"));
    api.createSession.mockResolvedValueOnce({ id: SESSION });
    const fresh: TerminalNodeData = {
      kind: "terminal",
      agent: { id: "codex", driver: "acp" },
    };
    render(<SessionView nodeId="n1" data={fresh} />);
    expect(await screen.findByText("会话没有启动")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(api.createSession).toHaveBeenCalledTimes(2));
  });
});
