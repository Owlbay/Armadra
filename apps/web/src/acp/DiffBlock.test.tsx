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

const exported = vi.hoisted(() => vi.fn());
vi.mock("./export-to-board", () => ({ exportDiff: exported }));

import { DiffBlock, workspaceRelative } from "./DiffBlock";

const writeText = vi.fn(async (_text: string) => undefined);

beforeEach(() => {
  writeText.mockClear();
  exported.mockClear();
  Object.assign(navigator, { clipboard: { writeText } });
});

afterEach(cleanup);

describe("workspaceRelative", () => {
  it("only answers for files inside the workspace", () => {
    expect(workspaceRelative("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
    expect(workspaceRelative("/repo/src/a.ts", "/repo/")).toBe("src/a.ts");
    expect(workspaceRelative("C:\\repo\\a.ts", "C:\\repo")).toBe("a.ts");
    expect(workspaceRelative("/repository/a.ts", "/repo")).toBeNull();
    expect(workspaceRelative("/etc/hosts", "/repo")).toBeNull();
    expect(workspaceRelative("/repo/a.ts", undefined)).toBeNull();
  });
});

describe("DiffBlock", () => {
  it("renders ACP's old and new text with counts and opens the file", () => {
    render(
      <DiffBlock
        path="/repo/src/a.ts"
        oldText={"one\ntwo\n"}
        newText={"one\nthree\nfour\n"}
      />,
    );
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    expect(opened).toHaveBeenCalledWith("src/a.ts");
  });

  it("has no open or diff-node action outside the workspace, but copies the path", async () => {
    const source = { nodeId: "n1", sessionId: "s1" };
    render(
      <DiffBlock path="/tmp/x.ts" oldText="" newText="x" source={source} />,
    );
    expect(screen.getByText("/tmp/x.ts")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "打开" })).toBeNull();
    expect(screen.queryByRole("button", { name: "落为变更节点" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "复制路径" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/tmp/x.ts"));
  });

  it("copies the patch and saves the file as a diff node linked to its agent", async () => {
    const source = { nodeId: "n1", sessionId: "s1" };
    render(
      <DiffBlock
        path="/repo/src/a.ts"
        oldText={"one\n"}
        newText={"two\n"}
        source={source}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "复制补丁" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain("+two");
    expect(await screen.findByRole("button", { name: "已复制" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "落为变更节点" }));
    expect(exported).toHaveBeenCalledWith("src/a.ts", source);
  });

  it("folds a long patch to its first lines until asked", () => {
    const newText = Array.from({ length: 260 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const { container } = render(
      <DiffBlock path="/repo/big.ts" oldText="" newText={newText} />,
    );
    const rows = () =>
      container.querySelectorAll("[data-slot=acp-diff] pre > div").length;
    expect(rows()).toBe(60);
    fireEvent.click(screen.getByRole("button", { name: "展开全部" }));
    expect(rows()).toBeGreaterThan(200);
  });
});
