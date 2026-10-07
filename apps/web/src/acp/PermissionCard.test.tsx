import { scoped } from "../sources/scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const api = vi.hoisted(() => ({ answer: vi.fn() }));
vi.mock("./api", () => ({ acpApi: api }));

import { useAgentStatusStore } from "@/agent/status-store";
import { PermissionCard } from "./PermissionCard";
import { useAcpStore, type AcpPermissionView } from "./store";

const permission: AcpPermissionView = {
  pendingId: "n1-1-acp-t1",
  toolCall: { toolCallId: "t1", title: "pnpm test" },
  options: [
    { optionId: "always", name: "Always", kind: "allow_always" },
    { optionId: "once", name: "Once", kind: "allow_once" },
    { optionId: "no", name: "No", kind: "reject_once" },
  ],
};

beforeEach(() => {
  api.answer.mockReset().mockResolvedValue({});
  useAcpStore.getState().reset();
  useAcpStore.getState().addPermission("n1", permission);
});

afterEach(cleanup);

describe("PermissionCard", () => {
  it("groups options by kind: allow is default, reject is outline", () => {
    render(<PermissionCard permission={permission} canAnswer />);
    expect(screen.getByText("pnpm test")).toBeTruthy();
    const groups = screen.getAllByRole("group");
    expect(groups).toHaveLength(2);
    const [allow, reject] = groups as [HTMLElement, HTMLElement];
    expect(
      [...allow.querySelectorAll("button")].map((button) => [
        button.textContent,
        button.dataset.variant,
      ]),
    ).toEqual([
      ["始终允许", "default"],
      ["本次允许", "default"],
    ]);
    expect(
      [...reject.querySelectorAll("button")].map((button) => [
        button.textContent,
        button.dataset.variant,
      ]),
    ).toEqual([["拒绝", "outline"]]);
  });

  it("answers once with the option and collapses everywhere", () => {
    const resolveApproval = vi.spyOn(
      useAgentStatusStore.getState(),
      "resolveApproval",
    );
    render(<PermissionCard permission={permission} canAnswer />);
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    expect(api.answer).toHaveBeenCalledTimes(1);
    expect(api.answer).toHaveBeenCalledWith("n1-1-acp-t1", "deny", "no");
    expect(useAcpStore.getState().permissions[scoped("n1")]).toBeUndefined();
    expect(resolveApproval).toHaveBeenCalledWith("n1-1-acp-t1");
  });

  it("shows only the title to someone who cannot answer", () => {
    render(<PermissionCard permission={permission} canAnswer={false} />);
    expect(screen.getByText("pnpm test")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    // 同一张卡，按钮换成徽标（设计系统 §5.8）。
    expect(screen.getByText("等待接管")).toBeTruthy();
  });

  it("expands details with the diff, the input and the files before answering", () => {
    const detailed: AcpPermissionView = {
      ...permission,
      toolCall: {
        toolCallId: "t1",
        title: "Edit a.ts",
        locations: [{ path: "/repo/a.ts", line: 3 }],
        rawInput: { path: "a.ts", content: "new" },
        content: [
          { type: "diff", path: "/elsewhere/a.ts", oldText: "x", newText: "y" },
        ],
      },
    };
    render(<PermissionCard permission={detailed} canAnswer />);
    expect(screen.queryByText("/repo/a.ts:3")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    expect(screen.getByText("/repo/a.ts:3")).toBeTruthy();
    expect(screen.getByText("/elsewhere/a.ts")).toBeTruthy();
    expect(screen.getByText(/"content": "new"/)).toBeTruthy();
    expect(api.answer).not.toHaveBeenCalled();
  });

  it("puts focus on the first allow when pinned, unless someone is typing", () => {
    render(<PermissionCard permission={permission} canAnswer pinned />);
    expect(document.activeElement?.textContent).toBe("始终允许");
    cleanup();
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    field.focus();
    render(<PermissionCard permission={permission} canAnswer pinned />);
    expect(document.activeElement).toBe(field);
    // Esc 不答。
    fireEvent.keyDown(screen.getByRole("button", { name: "始终允许" }), {
      key: "Escape",
    });
    expect(api.answer).not.toHaveBeenCalled();
    field.remove();
  });
});
