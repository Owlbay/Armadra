import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const api = vi.hoisted(() => ({ drive: vi.fn() }));
vi.mock("./api", () => ({ acpApi: api }));

import { PromptBox } from "./PromptBox";

const onSubmit = vi.fn<(text: string) => Promise<boolean>>();
const onCancel = vi.fn();
const onMode = vi.fn();
const onModel = vi.fn();

const MODES = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
  ],
};
const MODELS = {
  currentModelId: "small",
  availableModels: [
    { modelId: "small", name: "Small" },
    { modelId: "large", name: "Large" },
  ],
};

/** 让 `(max-width: 767px)` 命中（窄屏），测完还原。 */
function narrowViewport() {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    ...original(query),
    matches: query.includes("767"),
  })) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

function renderBox(
  props: Partial<React.ComponentProps<typeof PromptBox>> = {},
) {
  return render(
    <PromptBox
      sessionId="s1"
      disabled={false}
      streaming={false}
      modes={null}
      onSubmit={onSubmit}
      onCancel={onCancel}
      onMode={onMode}
      {...props}
    />,
  );
}

beforeEach(() => {
  api.drive.mockReset().mockResolvedValue({});
  onSubmit.mockReset().mockResolvedValue(true);
  onCancel.mockReset();
  onMode.mockReset();
  onModel.mockReset();
});

afterEach(cleanup);

describe("PromptBox", () => {
  it("sends on Enter and keeps Shift+Enter for a new line", async () => {
    renderBox();
    const input = screen.getByLabelText("消息") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "第一行" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("第一行"));
    expect(input.value).toBe("");
  });

  it("does not send while an input method is composing", () => {
    renderBox();
    const input = screen.getByLabelText("消息");
    fireEvent.change(input, { target: { value: "ni" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the text when sending fails", async () => {
    onSubmit.mockResolvedValue(false);
    renderBox();
    const input = screen.getByLabelText("消息") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(input.value).toBe("hello"));
  });

  it("takes the human lease on focus and gives it back on blur and submit", async () => {
    renderBox();
    const input = screen.getByLabelText("消息");
    fireEvent.focus(input);
    expect(api.drive).toHaveBeenLastCalledWith("s1", "takeover");
    fireEvent.blur(input);
    expect(api.drive).toHaveBeenLastCalledWith("s1", "release");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "go" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(api.drive).toHaveBeenLastCalledWith("s1", "release");
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(api.drive.mock.calls).toEqual([
      ["s1", "takeover"],
      ["s1", "release"],
      ["s1", "takeover"],
      ["s1", "release"],
    ]);
  });

  it("releases the lease when unmounted while focused", () => {
    const { unmount } = renderBox();
    fireEvent.focus(screen.getByLabelText("消息"));
    unmount();
    expect(api.drive).toHaveBeenLastCalledWith("s1", "release");
  });

  it("turns the send button into stop during a turn, and Esc stops too", () => {
    renderBox({ streaming: true });
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByLabelText("消息"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("is disabled offline", () => {
    renderBox({ disabled: true });
    expect(
      (screen.getByLabelText("消息") as HTMLTextAreaElement).disabled,
    ).toBe(true);
  });

  it("offers a mode picker only when there is a choice", () => {
    const { rerender } = renderBox({
      modes: {
        currentModeId: "default",
        availableModes: [{ id: "default", name: "Default" }],
      },
    });
    expect(screen.queryByLabelText("模式")).toBeNull();
    rerender(
      <PromptBox
        sessionId="s1"
        disabled={false}
        streaming={false}
        modes={{
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan" },
          ],
        }}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onMode={onMode}
      />,
    );
    expect(screen.getByLabelText("模式")).toBeTruthy();
  });

  it("offers a model picker only when the agent gives a catalog", () => {
    const { rerender } = renderBox({ models: null, onModel });
    expect(screen.queryByLabelText("模型")).toBeNull();
    rerender(
      <PromptBox
        sessionId="s1"
        disabled={false}
        streaming={false}
        modes={null}
        models={MODELS}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onMode={onMode}
        onModel={onModel}
      />,
    );
    const trigger = screen.getByLabelText("模型");
    expect(trigger.textContent).toContain("Small");
  });

  it("folds mode and model into one menu on a narrow screen", async () => {
    const restore = narrowViewport();
    try {
      renderBox({ modes: MODES, models: MODELS, onModel });
      expect(screen.queryByLabelText("模式")).toBeNull();
      expect(screen.queryByLabelText("模型")).toBeNull();
      const more = screen.getByRole("button", { name: "更多" });
      fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" });
      const large = await screen.findByRole("menuitemradio", {
        name: "Large",
      });
      expect(screen.getByRole("menuitemradio", { name: "Plan" })).toBeTruthy();
      fireEvent.click(large);
      expect(onModel).toHaveBeenCalledWith("large");
    } finally {
      restore();
    }
  });

  it("shows no menu on a narrow screen when there is nothing to choose", () => {
    const restore = narrowViewport();
    try {
      renderBox({ modes: null, models: null, onModel });
      expect(screen.queryByRole("button", { name: "更多" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("fills the box from an edit-and-resend without sending, cursor at the end", async () => {
    const { rerender } = renderBox({ prefill: { text: "try again", seq: 1 } });
    const input = screen.getByLabelText("消息") as HTMLTextAreaElement;
    await waitFor(() => expect(input.value).toBe("try again"));
    expect(document.activeElement).toBe(input);
    expect(onSubmit).not.toHaveBeenCalled();
    // 同一句再填一次（seq 变了）也照样填进来。
    fireEvent.change(input, { target: { value: "" } });
    rerender(
      <PromptBox
        sessionId="s1"
        disabled={false}
        streaming={false}
        modes={null}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onMode={onMode}
        prefill={{ text: "try again", seq: 2 }}
      />,
    );
    await waitFor(() => expect(input.value).toBe("try again"));
  });

  it("shows context usage and turns to the warning colour near the limit", () => {
    renderBox({ usage: { used: 12_300, size: 200_000 } });
    const usage = document.querySelector("[data-slot=acp-usage]")!;
    // 数字按界面语言紧凑写（中文是「万」）。
    expect(usage.textContent).toBe("1.2万 / 20万");
    expect(usage.getAttribute("data-warn")).toBeNull();
    cleanup();
    renderBox({ usage: { used: 190, size: 200 } });
    expect(
      document
        .querySelector("[data-slot=acp-usage]")
        ?.getAttribute("data-warn"),
    ).toBe("true");
  });

  it("moves through slash commands with the arrow keys", () => {
    Element.prototype.scrollIntoView ??= () => undefined;
    renderBox({
      commands: [
        { name: "review", description: "" },
        { name: "init", description: "" },
      ],
    });
    const input = screen.getByLabelText("消息") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("/init ");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
