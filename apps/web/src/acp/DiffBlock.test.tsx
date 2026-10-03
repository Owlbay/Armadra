import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const opened = vi.hoisted(() => vi.fn());
vi.mock("@/files/open-editor", () => ({ openFileInEditor: opened }));

const store = vi.hoisted(() => ({ workspace: { rootPath: "/repo" } }));
vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

import { DiffBlock, workspaceRelative } from "./DiffBlock";

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

  it("has no open action outside the workspace", () => {
    render(<DiffBlock path="/tmp/x.ts" oldText="" newText="x" />);
    expect(screen.getByText("/tmp/x.ts")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
