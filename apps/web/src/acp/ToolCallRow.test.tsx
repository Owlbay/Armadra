import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const opened = vi.hoisted(() => vi.fn());
vi.mock("@/files/open-editor", () => ({ openFileInEditor: opened }));

const store = vi.hoisted(() => ({ workspace: { rootPath: "/repo" } }));
vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

import { ToolCallRow, commandOf } from "./ToolCallRow";
import type { AcpToolCallView } from "./store";

const writeText = vi.fn(async (_text: string) => undefined);

beforeEach(() => {
  writeText.mockClear();
  opened.mockClear();
  Object.assign(navigator, { clipboard: { writeText } });
});

afterEach(cleanup);

const call = (patch: Partial<AcpToolCallView> = {}): AcpToolCallView => ({
  toolCallId: "t1",
  title: "Run tests",
  kind: "execute",
  status: "completed",
  content: [],
  locations: [],
  rawInput: { command: "pnpm test" },
  rawOutput: "ok",
  ...patch,
});

describe("ToolCallRow", () => {
  it("draws a completed call with the done tone, not the idle grey", () => {
    render(<ToolCallRow call={call()} />);
    const pill = document.querySelector("[data-slot=status-pill]");
    expect(pill?.getAttribute("data-tone")).toBe("done");
    expect(pill?.textContent).toBe("已完成");
  });

  it("copies the command, the input and the output", async () => {
    render(<ToolCallRow call={call()} />);
    fireEvent.click(screen.getByRole("button", { name: "复制命令" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith("pnpm test"),
    );
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    fireEvent.click(screen.getByRole("button", { name: "复制入参" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(
        JSON.stringify({ command: "pnpm test" }, null, 2),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "复制输出" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("ok"));
  });

  it("opens a workspace file at its line from a location chip, folding the rest", () => {
    render(
      <ToolCallRow
        call={call({
          kind: "edit",
          locations: [
            { path: "/repo/src/a.ts", line: 12 },
            { path: "/elsewhere/b.ts" },
            { path: "/repo/c.ts" },
            { path: "/repo/d.ts" },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "打开 src/a.ts" }));
    expect(opened).toHaveBeenCalledWith("src/a.ts", { line: 12 });
    // 工作区外的只显示，不可点；多出来的折成 +N。
    expect(screen.getByText("b.ts")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /b\.ts/ })).toBeNull();
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "复制命令" })).toBeNull();
  });

  it("asks to retry a failed call through the edit-and-resend path", () => {
    const onRetry = vi.fn();
    render(<ToolCallRow call={call({ status: "failed" })} onRetry={onRetry} />);
    expect(
      document
        .querySelector("[data-slot=status-pill]")
        ?.getAttribute("data-tone"),
    ).toBe("failed");
    fireEvent.click(screen.getByRole("button", { name: "让它重试" }));
    expect(onRetry).toHaveBeenCalledWith("请重试：Run tests");
  });

  it("says terminal output is unavailable for a terminal block", () => {
    render(
      <ToolCallRow
        call={call({
          rawInput: undefined,
          rawOutput: undefined,
          content: [{ type: "terminal", terminalId: "x" }],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    expect(screen.getByText("终端输出不可用")).toBeTruthy();
  });

  it("finds the command in a string input or an argv array", () => {
    expect(commandOf(call({ rawInput: "ls -la" }))).toBe("ls -la");
    expect(commandOf(call({ rawInput: { command: ["git", "status"] } }))).toBe(
      "git status",
    );
    expect(commandOf(call({ kind: "read" }))).toBeNull();
  });
});
