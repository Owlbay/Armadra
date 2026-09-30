import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BoardDocument, CanvasNode, Workspace } from "@armadra/shared";

vi.mock("../api/client", () => ({
  runtimeApi: { agents: () => Promise.resolve([]) },
}));

import { installDomPolyfills, TestProviders } from "../app/test-harness";
import { useCanvasStore } from "../store/canvas-store";
import { EmptyCanvas } from "./EmptyCanvas";

installDomPolyfills();
afterEach(cleanup);

const now = new Date().toISOString();
const workspace: Workspace = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "alpha",
  rootPath: "/tmp/alpha",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: now,
  createdAt: now,
  updatedAt: now,
};

function documentWith(nodes: CanvasNode[]): BoardDocument {
  return {
    board: {
      id: "22222222-2222-4222-8222-222222222222",
      workspaceId: workspace.id,
      name: "Default",
      sortOrder: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      whiteboard: "",
      createdAt: now,
      updatedAt: now,
    },
    nodes,
    edges: [],
  };
}

function renderEmpty() {
  return render(
    <TestProviders>
      <EmptyCanvas />
    </TestProviders>,
  );
}

describe("EmptyCanvas", () => {
  beforeEach(() => {
    useCanvasStore.setState({
      workspace,
      document: documentWith([]),
      whiteboard: { ...useCanvasStore.getState().whiteboard, items: [] },
    });
  });

  it("空画布给出新建终端与新建菜单两个动作", () => {
    renderEmpty();
    expect(screen.getByRole("button", { name: "新建终端" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "新建" })).toBeTruthy();
  });

  it("点「新建终端」建出一个终端节点", () => {
    const addNode = vi.fn(() => "");
    useCanvasStore.setState({ addNode });
    renderEmpty();
    fireEvent.click(screen.getByRole("button", { name: "新建终端" }));
    expect(addNode).toHaveBeenCalledWith(
      "terminal",
      expect.objectContaining({ position: expect.any(Object) }),
    );
  });

  it("画布上已有节点时不显示", () => {
    useCanvasStore.setState({
      document: documentWith([{ id: "n1" } as CanvasNode]),
    });
    const { container } = renderEmpty();
    expect(container.querySelector("[data-slot='empty-canvas']")).toBeNull();
  });

  it("文档还没加载时不显示", () => {
    useCanvasStore.setState({ document: null });
    const { container } = renderEmpty();
    expect(container.querySelector("[data-slot='empty-canvas']")).toBeNull();
  });
});
