import { scoped } from "../sources/scope";
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
  setModel: vi.fn(),
  answerElicitation: vi.fn(),
  switchDriver: vi.fn(),
  answer: vi.fn(),
  drive: vi.fn(),
}));
vi.mock("./api", () => ({ acpApi: api }));

const store = vi.hoisted(() => ({
  workspace: { id: "w1", rootPath: "/repo" },
  document: null as null | { nodes: Record<string, unknown>[] },
  updateNodeData: vi.fn(),
}));
vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

/** 控制面的连上 / 断开：测试自己报。 */
const connection = vi.hoisted(() => ({
  handlers: new Set<(id: string, connected: boolean, source: string) => void>(),
}));
vi.mock("@/api/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/events")>();
  return {
    ...actual,
    onWorkspaceConnection: (
      handler: (id: string, connected: boolean, source: string) => void,
    ) => {
      connection.handlers.add(handler);
      return () => connection.handlers.delete(handler);
    },
  };
});

import { RuntimeRequestError } from "@/api/client";
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
  api.setModel.mockResolvedValue(undefined);
  api.answerElicitation.mockResolvedValue({});
  store.updateNodeData.mockReset();
  store.document = null;
  useAcpStore.getState().reset();
});

const MODELS = {
  currentModelId: "small",
  availableModels: [
    { modelId: "small", name: "Small" },
    { modelId: "large", name: "Large" },
  ],
};

/**
 * 选一个模型。jsdom 里 Radix 的 Select 打不开（缺 pointer capture），走窄屏
 * 的「⋯」菜单——同一个回调。
 */
async function pickModel(name: string) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    ...original(query),
    matches: query.includes("767"),
  })) as typeof window.matchMedia;
  try {
    render(<SessionView nodeId="n1" data={data} />);
    const more = await screen.findByRole("button", { name: "更多" });
    fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name }));
  } finally {
    window.matchMedia = original;
  }
}

afterEach(cleanup);

function setConnected(connected: boolean) {
  act(() => {
    for (const handler of [...connection.handlers])
      handler("w1", connected, "local");
  });
}

async function sendPrompt(value: string) {
  const input = await screen.findByLabelText("消息");
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(api.prompt).toHaveBeenCalled());
  return api.prompt.mock.calls.at(-1)?.[2] as string;
}

/** 镜像里有了这一轮：提问与答复，`turns` 里记着它。 */
function loggedTurn(clientTurnId: string, state: string): AcpLogResponse {
  return {
    entries: [
      { role: "user", blocks: [{ type: "text", text: "go" }], endOffset: 3 },
      {
        role: "assistant",
        blocks: [{ type: "text", text: "done it" }],
        endOffset: 7,
      },
    ],
    endOffset: 7,
    turns: [
      {
        turnId: "1-1",
        clientTurnId,
        state: state as "ended",
        ...(state === "ended" ? { stopReason: "end_turn" } : {}),
      },
    ],
  };
}

describe("SessionView turn reconciliation (§39.9)", () => {
  it("confirms a turn whose request was lost on the way and draws its real outcome", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText("向它说第一句话");
    let answer: (log: AcpLogResponse) => void = () => undefined;
    api.log.mockImplementation(
      () => new Promise<AcpLogResponse>((resolve) => (answer = resolve)),
    );
    api.prompt.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const clientTurnId = await sendPrompt("go");
    expect(clientTurnId).toMatch(/.+/);
    expect(await screen.findByText("正在确认这一轮")).toBeTruthy();
    expect(screen.queryByText("这一轮没有完成")).toBeNull();
    await waitFor(() => expect(api.log).toHaveBeenCalledTimes(2));
    act(() => answer(loggedTurn(clientTurnId, "ended")));
    expect(await screen.findByText("done it")).toBeTruthy();
    expect(screen.queryByText("正在确认这一轮")).toBeNull();
    expect(screen.queryByText("这一轮没有送达")).toBeNull();
    expect(screen.queryByLabelText("正在输出")).toBeNull();
    expect(api.prompt).toHaveBeenCalledTimes(1);
  });

  it("keeps streaming when the lost turn is still running", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText("向它说第一句话");
    api.prompt.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    api.log.mockImplementation(async () =>
      loggedTurn(api.prompt.mock.calls[0]?.[2] as string, "running"),
    );
    const clientTurnId = await sendPrompt("go");
    expect(await screen.findByText("done it")).toBeTruthy();
    expect(screen.getByLabelText("正在输出")).toBeTruthy();
    // 结束帧带着它的 clientTurnId 来：照常收尾。
    emit({
      type: "acp.turn",
      sessionId: SESSION,
      nodeId: "n1",
      turnId: "1-1",
      clientTurnId,
      stopReason: "end_turn",
    });
    expect(screen.queryByLabelText("正在输出")).toBeNull();
  });

  it("says not delivered when core has no such turn, and retries with the same id", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText("向它说第一句话");
    api.prompt.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    api.log.mockResolvedValue({ entries: [], endOffset: 0, turns: [] });
    const clientTurnId = await sendPrompt("go");
    expect(await screen.findByText("这一轮没有送达")).toBeTruthy();
    // 提问留在时间线上，等重试。
    expect(screen.getByText("go")).toBeTruthy();
    // 另一轮的结束帧不是它的结局。
    emit({
      type: "acp.turn",
      sessionId: SESSION,
      nodeId: "n1",
      turnId: "9-9",
      clientTurnId: "someone-else",
      stopReason: "end_turn",
    });
    expect(screen.getByText("这一轮没有送达")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(api.prompt).toHaveBeenCalledTimes(2));
    expect(api.prompt).toHaveBeenLastCalledWith(SESSION, "go", clientTurnId);
    expect(screen.queryByText("这一轮没有送达")).toBeNull();
    expect(screen.getAllByText("go")).toHaveLength(1);
  });

  it("gives up confirming when the log stays unreachable, still retrying with the same id", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText("向它说第一句话");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.prompt.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      api.log.mockRejectedValue(new TypeError("Failed to fetch"));
      const clientTurnId = await sendPrompt("go");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(screen.getByText("这一轮没有送达")).toBeTruthy();
      expect(api.log).toHaveBeenCalledTimes(4);
      api.prompt.mockResolvedValueOnce({ turnId: "1-1" });
      fireEvent.click(screen.getByRole("button", { name: "重试" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(api.prompt).toHaveBeenLastCalledWith(SESSION, "go", clientTurnId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails at once when core refuses the prompt with a code", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText("向它说第一句话");
    api.prompt.mockRejectedValueOnce(
      new RuntimeRequestError(409, "gone", "acp_exited"),
    );
    await sendPrompt("go");
    expect(await screen.findByText("这一轮没有完成")).toBeTruthy();
    expect(screen.queryByText("正在确认这一轮")).toBeNull();
    expect(api.log).toHaveBeenCalledTimes(1);
  });

  it("rereads the log after the control channel reconnects and ends a turn it missed", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText("向它说第一句话");
    const clientTurnId = await sendPrompt("go");
    expect(screen.getByLabelText("正在输出")).toBeTruthy();
    setConnected(false);
    api.log.mockResolvedValue(loggedTurn(clientTurnId, "ended"));
    setConnected(true);
    expect(await screen.findByText("done it")).toBeTruthy();
    expect(api.log).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText("正在输出")).toBeNull();
  });

  it("does not reread on the first connected report", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText("向它说第一句话");
    setConnected(true);
    expect(api.log).toHaveBeenCalledTimes(1);
  });
});

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
      expect(api.prompt).toHaveBeenCalledWith(
        SESSION,
        "跑一下测试",
        expect.any(String),
      ),
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
    // 第三个参数是 §39.9 的 clientTurnId：拒答是 core 跑完的一轮，重发是新的
    // 一轮，换一个 id（沿用旧的会被 core 当成同一轮去重掉）。
    expect(api.prompt).toHaveBeenLastCalledWith(
      SESSION,
      "go",
      expect.any(String),
    );
    expect(api.prompt.mock.calls[1]?.[2]).not.toBe(
      api.prompt.mock.calls[0]?.[2],
    );
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

  it("draws an elicitation from the event stream, answers it and folds it away", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText("向它说第一句话");
    emit({
      type: "agent.approval",
      nodeId: "n1",
      pendingId: "n1-1-acp-e1",
      request: {
        request: {
          protocol: "acp",
          elicitation: {
            message: "Pick a color",
            mode: "form",
            requestedSchema: {
              type: "object",
              properties: {
                color: {
                  type: "string",
                  enum: ["red", "blue"],
                  default: "red",
                },
              },
              required: ["color"],
            },
          },
        },
      },
    });
    expect(await screen.findByText("Pick a color")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    await waitFor(() =>
      expect(api.answerElicitation).toHaveBeenCalledWith("n1-1-acp-e1", {
        action: "accept",
        content: { color: "red" },
      }),
    );
    expect(screen.queryByText("Pick a color")).toBeNull();
  });

  it("restores pending elicitations and the model catalog from the log", async () => {
    api.log.mockResolvedValue({
      ...emptyLog,
      models: MODELS,
      elicitations: [
        {
          pendingId: "e1",
          protocol: "acp",
          elicitation: { message: "Which branch?", mode: "form" },
        },
      ],
    } satisfies AcpLogResponse);
    render(<SessionView nodeId="n1" data={data} />);
    expect(await screen.findByText("Which branch?")).toBeTruthy();
    expect((await screen.findByLabelText("模型")).textContent).toContain(
      "Small",
    );
    // 一个 turn 结束时挂起的 elicitation 已由 core 回了 cancel。
    emit({
      type: "acp.turn",
      sessionId: SESSION,
      nodeId: "n1",
      turnId: "t",
      stopReason: "cancelled",
    });
    await waitFor(() => expect(screen.queryByText("Which branch?")).toBeNull());
  });

  it("changes the model and writes agent.model back to the node", async () => {
    store.document = {
      nodes: [{ id: "n1", data: { ...data, agent: { ...data.agent } } }],
    };
    api.log.mockResolvedValue({ ...emptyLog, models: MODELS });
    await pickModel("Large");
    await waitFor(() =>
      expect(api.setModel).toHaveBeenCalledWith(SESSION, "large"),
    );
    await waitFor(() =>
      expect(store.updateNodeData).toHaveBeenCalledWith(
        "n1",
        { agent: { id: "codex", driver: "acp", model: "large" } },
        { history: "ignore" },
      ),
    );
    expect(
      useAcpStore.getState().sessions[scoped(SESSION)]?.models?.currentModelId,
    ).toBe("large");
  });

  it("puts the previous model back when the change is refused", async () => {
    api.setModel.mockRejectedValue(new Error("acp_model_unavailable"));
    api.log.mockResolvedValue({ ...emptyLog, models: MODELS });
    await pickModel("Large");
    await waitFor(() =>
      expect(
        useAcpStore.getState().sessions[scoped(SESSION)]?.models
          ?.currentModelId,
      ).toBe("small"),
    );
    expect(store.updateNodeData).not.toHaveBeenCalled();
  });
});
