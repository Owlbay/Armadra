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
  AcpPromptCapabilities,
  TerminalNodeData,
} from "@armadra/shared";

/** 假 core：会话视图只经 `acpApi` 说话；上传经 `runtimeApi.uploadAgentFile`。 */
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

const toasts = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toasts.error(...args) },
}));

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

import { runtimeApi } from "@/api/client";
import { PromptBox } from "./PromptBox";
import { usePromptAttachments } from "./PromptAttachments";
import { SessionView } from "./SessionView";
import { useAcpStore } from "./store";

const SESSION = "11111111-1111-4111-8111-111111111111";

const png = (name = "shot.png") =>
  new File([new Uint8Array(8)], name, { type: "image/png" });
const text = (name = "notes.txt") =>
  new File(["hello"], name, { type: "text/plain" });

const onSubmit = vi.fn();

function Box({
  capabilities,
  remote = false,
}: {
  capabilities: AcpPromptCapabilities | null;
  remote?: boolean;
}) {
  const attachments = usePromptAttachments(capabilities, remote);
  return (
    <PromptBox
      sessionId="s1"
      disabled={false}
      streaming={false}
      modes={null}
      onSubmit={onSubmit}
      onCancel={vi.fn()}
      onMode={vi.fn()}
      attachments={attachments}
    />
  );
}

function paste(files: File[]) {
  fireEvent.paste(screen.getByLabelText("消息"), {
    clipboardData: { files, items: [] },
  });
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.drive.mockResolvedValue({});
  onSubmit.mockReset().mockResolvedValue(true);
  toasts.error.mockReset();
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:preview-${(n += 1)}`);
  URL.revokeObjectURL = vi.fn();
  useAcpStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PromptBox attachments (§55)", () => {
  it("adds a pasted screenshot as a removable thumbnail and sends it", async () => {
    render(<Box capabilities={{ image: true, embeddedContext: false }} />);
    paste([png()]);
    const thumb = await screen.findByRole("img", { name: "shot.png" });
    expect(thumb.getAttribute("src")).toBe("blob:preview-1");
    // 移除：缩略图没了，预览地址收回。
    fireEvent.click(screen.getByRole("button", { name: "移除 shot.png" }));
    expect(screen.queryByRole("img", { name: "shot.png" })).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");

    paste([png("again.png")]);
    await screen.findByRole("img", { name: "again.png" });
    // 只有附件、没有字也能发。
    const input = screen.getByLabelText("消息");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const [sent, attached] = onSubmit.mock.calls[0]!;
    expect(sent).toBe("");
    expect(attached.map((item: { file: File }) => item.file.name)).toEqual([
      "again.png",
    ]);
    expect(screen.queryByRole("img", { name: "again.png" })).toBeNull();
  });

  it("refuses an image the agent does not take and keeps text files", async () => {
    render(<Box capabilities={{ image: false, embeddedContext: false }} />);
    paste([png(), text()]);
    expect(toasts.error).toHaveBeenCalledWith("这个 Agent 不接收图片");
    expect(screen.queryByRole("img")).toBeNull();
    expect(await screen.findByText("notes.txt")).toBeTruthy();
  });

  it("refuses a local file on an SSH node that takes no embedded context", () => {
    render(
      <Box capabilities={{ image: true, embeddedContext: false }} remote />,
    );
    paste([text()]);
    expect(toasts.error).toHaveBeenCalledWith("这个 Agent 打不开本机文件");
    expect(screen.queryByText("notes.txt")).toBeNull();
  });

  it("has no paperclip until the agent's capabilities are known", () => {
    render(<Box capabilities={null} />);
    expect(screen.queryByRole("button", { name: "添加附件" })).toBeNull();
    paste([png()]);
    expect(toasts.error).toHaveBeenCalledWith(
      "这台 core 版本较旧，不能发送附件",
    );
  });

  it("picks files with the paperclip and keeps them when sending fails", async () => {
    onSubmit.mockResolvedValue(false);
    const { container } = render(
      <Box capabilities={{ image: true, embeddedContext: true }} />,
    );
    expect(screen.getByRole("button", { name: "添加附件" })).toBeTruthy();
    const picker =
      container.querySelector<HTMLInputElement>("input[type=file]")!;
    fireEvent.change(picker, { target: { files: [text("a.md")] } });
    await screen.findByText("a.md");
    fireEvent.change(screen.getByLabelText("消息"), {
      target: { value: "see" },
    });
    fireEvent.keyDown(screen.getByLabelText("消息"), { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(await screen.findByText("a.md")).toBeTruthy();
    expect((screen.getByLabelText("消息") as HTMLTextAreaElement).value).toBe(
      "see",
    );
  });
});

describe("SessionView sends attachments (§55)", () => {
  const data: TerminalNodeData = {
    kind: "terminal",
    sessionId: SESSION,
    cwd: "/repo",
    agent: { id: "codex", driver: "acp" },
  };
  const log: AcpLogResponse = {
    entries: [],
    endOffset: 0,
    promptCapabilities: { image: true, embeddedContext: false },
  };

  it("uploads to the session's core, then prompts with the upload ids", async () => {
    api.log.mockResolvedValue(log);
    api.prompt.mockResolvedValue({ turnId: "t1" });
    const upload = vi
      .spyOn(runtimeApi, "uploadAgentFile")
      .mockImplementation(async (_w, file, name) => ({
        id: name.startsWith("shot") ? "a".repeat(32) : "b".repeat(32),
        name,
        path: `/data/agent-uploads/w1/x/${name}`,
        mimeType: file.type,
        bytes: file.size,
      }));
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByRole("button", { name: "添加附件" });
    // 拖到会话视图任何地方都算。
    const view = document.querySelector("[data-slot=acp-session-view]")!;
    fireEvent.drop(view, {
      dataTransfer: { types: ["Files"], files: [png(), text()], items: [] },
    });
    await screen.findByRole("img", { name: "shot.png" });
    const input = screen.getByLabelText("消息");
    fireEvent.change(input, { target: { value: "look" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() => expect(api.prompt).toHaveBeenCalled());
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[0]?.[0]).toBe("w1");
    const [session, sent, , ids] = api.prompt.mock.calls[0]!;
    expect(session).toBe(SESSION);
    expect(sent).toBe("look");
    expect(ids).toEqual(["a".repeat(32), "b".repeat(32)]);
    // 本页先画的那条用户消息带着附件。
    expect(await screen.findByText("notes.txt")).toBeTruthy();
  });

  it("does not prompt when an upload fails, and keeps the draft", async () => {
    api.log.mockResolvedValue(log);
    vi.spyOn(runtimeApi, "uploadAgentFile").mockRejectedValue(
      new Error("offline"),
    );
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByRole("button", { name: "添加附件" });
    paste([text()]);
    await screen.findByText("notes.txt");
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("消息"), { key: "Enter" });
    });
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("附件没有上传"),
    );
    expect(api.prompt).not.toHaveBeenCalled();
    expect(screen.getByText("notes.txt")).toBeTruthy();
  });
});
