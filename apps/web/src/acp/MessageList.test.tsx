import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

const opened = vi.hoisted(() => vi.fn());
vi.mock("@/files/open-editor", () => ({ openFileInEditor: opened }));

const store = vi.hoisted(() => ({
  workspace: { rootPath: "/repo" },
  document: null,
  addNode: vi.fn(() => "browser-1"),
}));
vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

import { MessageList, type MessageListActions } from "./MessageList";
import type { AcpItem } from "./store";

const writeText = vi.fn(async (_text: string) => undefined);

beforeEach(() => {
  writeText.mockClear();
  opened.mockClear();
  Object.assign(navigator, { clipboard: { writeText } });
});

afterEach(cleanup);

const user = (id: string, text: string, turn: number): AcpItem => ({
  kind: "message",
  id,
  role: "user",
  text,
  turn,
  at: "2026-10-07T06:02:00.000Z",
});
const reply = (id: string, text: string, turn: number): AcpItem => ({
  kind: "message",
  id,
  role: "assistant",
  text,
  turn,
});

function actions(patch: Partial<MessageListActions> = {}) {
  return {
    onEdit: vi.fn(),
    onResend: vi.fn(),
    onPrompt: vi.fn(),
    ...patch,
  } satisfies MessageListActions;
}

describe("MessageList", () => {
  it("groups items by turn, with the time on the turn's first prompt", () => {
    const { container } = render(
      <MessageList
        items={[
          user("m0", "one", 1),
          reply("m1", "first", 1),
          user("m2", "two", 3),
          reply("m3", "second", 3),
        ]}
        streaming={false}
      />,
    );
    const sections = container.querySelectorAll("section[data-turn]");
    expect(sections).toHaveLength(2);
    expect(container.querySelectorAll("time")).toHaveLength(2);
    expect(screen.getByRole("log").getAttribute("aria-live")).toBe("off");
  });

  it("copies, edits and regenerates from the message toolbars", async () => {
    const handlers = actions();
    render(
      <MessageList
        items={[
          user("m0", "old ask", 1),
          reply("m1", "old answer", 1),
          user("m2", "new ask", 3),
          reply("m3", "new answer", 3),
        ]}
        streaming={false}
        actions={handlers}
      />,
    );
    const answer = screen.getByText("new answer").closest(".group\\/act")!;
    fireEvent.click(
      within(answer as HTMLElement).getByRole("button", { name: "复制" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("new answer"));
    // 只有最后一回合有「重新生成」：重发它的提问。
    expect(screen.getAllByRole("button", { name: "重新生成" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    expect(handlers.onResend).toHaveBeenCalledWith("new ask");
    const ask = screen.getByText("old ask").closest(".group\\/act")!;
    fireEvent.click(
      within(ask as HTMLElement).getByRole("button", { name: "编辑后重发" }),
    );
    expect(handlers.onEdit).toHaveBeenCalledWith("old ask");
    // 回合正常结束：提问上没有「重新发送」。
    expect(screen.queryByRole("button", { name: "重新发送" })).toBeNull();
  });

  it("offers resend on the last prompt when that turn did not finish", () => {
    const handlers = actions({ resendable: true });
    render(
      <MessageList
        items={[user("m0", "ask", 1)]}
        streaming={false}
        actions={handlers}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "重新发送" }));
    expect(handlers.onResend).toHaveBeenCalledWith("ask");
  });

  it("has no regenerate while the turn is still streaming", () => {
    render(
      <MessageList
        items={[user("m0", "ask", 1), reply("m1", "part", 1)]}
        streaming
        actions={actions()}
      />,
    );
    expect(screen.queryByRole("button", { name: "重新生成" })).toBeNull();
    expect(screen.getByLabelText("正在输出")).toBeTruthy();
  });

  it("copies a code block on its own", async () => {
    render(
      <MessageList
        items={[reply("m0", "Here:\n\n```ts\nconst a = 1;\n```", 1)]}
        streaming={false}
      />,
    );
    const code = document.querySelector("[data-slot=acp-code]") as HTMLElement;
    fireEvent.click(within(code).getByRole("button", { name: "复制" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("const a = 1;\n"),
    );
  });

  it("shows a live thought with a spinner and a short summary while folded", () => {
    render(
      <MessageList
        items={[
          {
            kind: "message",
            id: "m0",
            role: "thought",
            text: "Look at the config loader first and then the tests around it",
            turn: 1,
          },
        ]}
        streaming
      />,
    );
    expect(screen.getByText("思考中")).toBeTruthy();
    expect(
      screen.getByText("Look at the config loader first and then"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /思考中/ }));
    expect(
      screen.getByText(
        "Look at the config loader first and then the tests around it",
      ),
    ).toBeTruthy();
  });

  it("draws images and resource links, opening a workspace file", async () => {
    render(
      <MessageList
        items={[
          {
            kind: "message",
            id: "m0",
            role: "assistant",
            text: "",
            turn: 1,
            attachments: [
              { type: "image", mimeType: "image/png", data: "aGk=" },
              { type: "image", mimeType: "image/png", dropped: true },
              {
                type: "resource_link",
                uri: "file:///repo/docs/a.md",
                name: "a.md",
              },
              {
                type: "resource_link",
                uri: "file:///etc/hosts",
                name: "hosts",
              },
            ],
          },
        ]}
        streaming={false}
      />,
    );
    const image = screen.getByRole("img", { name: "Agent 发来的图片" });
    expect(image.getAttribute("src")).toBe("data:image/png;base64,aGk=");
    expect(screen.getByText("图片未保存")).toBeTruthy();
    const links = document.querySelectorAll("[data-slot=acp-resource-link]");
    expect(links).toHaveLength(2);
    fireEvent.click(
      within(links[0] as HTMLElement).getByRole("button", { name: "打开" }),
    );
    expect(opened).toHaveBeenCalledWith("docs/a.md", {});
    // 工作区外的只能复制链接。
    const outside = links[1] as HTMLElement;
    expect(within(outside).queryByRole("button", { name: "打开" })).toBeNull();
    fireEvent.click(within(outside).getByRole("button", { name: "复制链接" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("file:///etc/hosts"),
    );
  });

  it("draws the plan under its turn's prompt and a mode notice", async () => {
    render(
      <MessageList
        items={[
          user("m0", "plan it", 1),
          { kind: "notice", id: "n1", turn: 1, notice: "mode", name: "Plan" },
        ]}
        streaming={false}
        plan={{
          turn: 1,
          settled: true,
          entries: [
            { content: "read", status: "completed" },
            { content: "write", status: "in_progress", priority: "high" },
          ],
        }}
      />,
    );
    expect(screen.getByText("模式已切换为 Plan")).toBeTruthy();
    const plan = document.querySelector("[data-slot=acp-plan]") as HTMLElement;
    // 回合结束了：折成一行。
    expect(plan.dataset.open).toBe("false");
    expect(within(plan).getByText("1/2 已完成")).toBeTruthy();
    fireEvent.click(within(plan).getByRole("button", { name: /计划/ }));
    expect(within(plan).getByText("高")).toBeTruthy();
    expect(within(plan).getByText("进行中")).toBeTruthy();
    fireEvent.click(within(plan).getByRole("button", { name: "复制为清单" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("- [x] read\n- [ ] write"),
    );
  });
});
