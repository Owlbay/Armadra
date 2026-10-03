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
});
