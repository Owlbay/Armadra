import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Board,
  BoardDocument,
  CanvasNode,
  ContentSource,
  Workspace,
} from "@armadra/shared";
import { contentSourceSchema } from "@armadra/shared";

/**
 * 输出到画板（ACP 设计 §7）：四条路各建出对应的对象 + 一条边 / 引用，
 * 一次撤销全回，来源字段是共享层的 `contentSourceSchema`。
 */
vi.mock("@/nodes/registry", () => {
  const meta = {
    labelKey: "node.sticky",
    icon: null,
    defaultSize: { width: 240, height: 200 },
    minSize: { width: 160, height: 120 },
    defaultColor: "#ffd60a",
    hasBridgeHandles: false,
  };
  const table = new Proxy({} as Record<string, typeof meta>, {
    get: () => meta,
  });
  return {
    NODE_META: table,
    nodeMeta: () => meta,
    DRAG_HANDLE_CLASS: "drag-handle",
    NODE_DRAG_HANDLE: ".drag-handle",
  };
});

const exportText = vi.fn();
vi.mock("./api", () => ({
  acpApi: { exportText: (...args: unknown[]) => exportText(...args) },
}));
vi.mock("@/canvas/whiteboard/mermaid/render", () => ({
  renderMermaidSvg: vi.fn(async () => "<svg/>"),
  svgToFile: vi.fn(
    (svg: string, name: string) =>
      new File([svg], `${name}.svg`, { type: "image/svg+xml" }),
  ),
}));
vi.mock("@/canvas/assets", () => ({
  uploadAsset: vi.fn(async () => ".armadra/assets/abc.png"),
}));
vi.mock("@/canvas/dnd/external-content", async (original) => ({
  ...(await original<object>()),
  rasterizeSvg: vi.fn(async (file: File) => file),
  measureImage: vi.fn(async () => ({ w: 300, h: 200 })),
}));

const { toast } = await import("sonner");
const { useCanvasStore, resetHistory } = await import("@/store/canvas-store");
const { undo } = await import("@/store/canvas/history");
const { emptyWhiteboard } = await import("@/canvas/whiteboard/model");
const { availableExports, codeBlocks, exportFileName, exportToBoard } =
  await import("./export-to-board");

const stamp = "2026-10-03T00:00:00.000Z";
const AGENT = "0f1a2b3c-4d5e-4f60-8a71-92b3c4d5e6f7";

const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "One",
  rootPath: "/tmp/one",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: stamp,
  createdAt: stamp,
  updatedAt: stamp,
};

const board: Board = {
  id: "019ff7d1-7419-74df-89e2-b1619d36ea7d",
  workspaceId: workspace.id,
  name: "Default",
  sortOrder: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  whiteboard: "",
  createdAt: stamp,
  updatedAt: stamp,
};

const agentNode = {
  id: AGENT,
  boardId: board.id,
  type: "terminal",
  title: "Claude",
  color: "#0a84ff",
  position: { x: 100, y: 100 },
  size: { width: 600, height: 400 },
  labels: [],
  note: "",
  data: { kind: "terminal", agent: { id: "claude", driver: "acp" } },
  createdAt: stamp,
  updatedAt: stamp,
} as CanvasNode;

const source: ContentSource = {
  nodeId: AGENT,
  sessionId: "8c1e7a52-0000-4000-8000-000000000001",
  messageId: "m3",
};

function load(): void {
  const document: BoardDocument = { board, nodes: [agentNode], edges: [] };
  useCanvasStore.getState().setWorkspace(workspace);
  useCanvasStore.getState().setDocument(document);
  useCanvasStore
    .getState()
    .setWhiteboard(emptyWhiteboard(), { history: "ignore" });
  resetHistory();
}

const state = () => useCanvasStore.getState();
const newNodes = () =>
  state().document?.nodes.filter((node) => node.id !== AGENT) ?? [];

beforeEach(() => {
  exportText.mockReset();
  load();
});

describe("解析", () => {
  it("找出围栏代码块并按语言判定可用的路", () => {
    const text =
      "结论\n\n```ts\nconst a = 1;\n```\n\n```mermaid\ngraph TD\nA-->B\n```\n";
    expect(codeBlocks(text)).toEqual([
      { lang: "ts", code: "const a = 1;" },
      { lang: "mermaid", code: "graph TD\nA-->B" },
    ]);
    expect([...availableExports(text)].sort()).toEqual([
      "editor",
      "mermaid",
      "sticky",
      "text",
    ]);
    expect([...availableExports("只有一句话")].sort()).toEqual([
      "sticky",
      "text",
    ]);
    expect(availableExports("  ").size).toBe(0);
  });

  it("文件名只留安全字符", () => {
    expect(exportFileName(source, 0, "typescript")).toBe("8c1e7a52-m3-1.ts");
    expect(exportFileName({ ...source, messageId: "../x" }, 1, "weird")).toBe(
      "8c1e7a52-x-2.txt",
    );
  });
});

describe("四条路", () => {
  it("便签：建出节点、带来源、连一条边；一次撤销全回", async () => {
    const result = await exportToBoard("sticky", "一段结论", source);
    expect(result?.nodeIds).toHaveLength(1);
    const [sticky] = newNodes();
    expect(sticky?.type).toBe("sticky");
    expect(sticky?.data).toMatchObject({ content: "一段结论", source });
    expect(
      contentSourceSchema.parse((sticky?.data as { source: unknown }).source),
    ).toEqual(source);
    // 落在来源节点右侧。
    expect(sticky!.position.x).toBeGreaterThanOrEqual(100 + 600);
    expect(state().document?.edges).toEqual([
      expect.objectContaining({
        source: sticky!.id,
        target: AGENT,
        kind: "link",
      }),
    ]);
    undo();
    expect(newNodes()).toEqual([]);
    expect(state().document?.edges).toEqual([]);
  });

  it("白板文字：一条文字对象带 meta.source、一条引用；一次撤销全回", async () => {
    const result = await exportToBoard("text", "短结论", source);
    expect(result?.itemIds).toHaveLength(1);
    const { items, references } = state().whiteboard;
    expect(items).toEqual([
      expect.objectContaining({
        kind: "text",
        text: "短结论",
        meta: { source },
      }),
    ]);
    expect(references).toEqual([
      expect.objectContaining({ itemId: items[0]!.id, nodeId: AGENT }),
    ]);
    undo();
    expect(state().whiteboard.items).toEqual([]);
    expect(state().whiteboard.references).toEqual([]);
  });

  it("代码块：写文件后建编辑器节点、带来源、连一条边；一次撤销全回", async () => {
    exportText.mockImplementation(
      async (_workspace: string, nodeId: string, name: string) => ({
        path: `/tmp/one/.armadra/exports/acp/${nodeId}/${name}`,
        relativePath: `.armadra/exports/acp/${nodeId}/${name}`,
        bytes: 10,
      }),
    );
    const text = "看这里：\n```ts\nconst a = 1;\n```\n";
    const result = await exportToBoard("editor", text, source);
    expect(exportText).toHaveBeenCalledWith(
      workspace.id,
      AGENT,
      "8c1e7a52-m3-1.ts",
      "const a = 1;\n",
    );
    expect(result?.nodeIds).toHaveLength(1);
    const [editor] = newNodes();
    expect(editor?.type).toBe("editor");
    expect(editor?.data).toMatchObject({
      path: `.armadra/exports/acp/${AGENT}/8c1e7a52-m3-1.ts`,
      source,
    });
    expect(state().document?.edges).toEqual([
      expect.objectContaining({ source: editor!.id, target: AGENT }),
    ]);
    undo();
    expect(newNodes()).toEqual([]);
    expect(state().document?.edges).toEqual([]);
  });

  it("Mermaid flowchart：白板对象带来源，外面一个 Frame，一条引用指向 Frame；一次撤销全回", async () => {
    const text = "```mermaid\ngraph TD\n  A[开始] --> B[结束]\n```";
    const result = await exportToBoard("mermaid", text, source);
    expect(result?.frameId).toBeTruthy();
    const { items, references } = state().whiteboard;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.meta?.source?.nodeId === AGENT)).toBe(
      true,
    );
    const frame = newNodes().find((node) => node.id === result!.frameId);
    expect(frame?.type).toBe("group");
    // Frame 圈住全部对象（引用按几何读成员）。
    for (const item of items) {
      expect(item.x).toBeGreaterThanOrEqual(frame!.position.x);
      expect(item.x + item.w).toBeLessThanOrEqual(
        frame!.position.x + frame!.size!.width,
      );
    }
    expect(references).toEqual([
      expect.objectContaining({ itemId: frame!.id, nodeId: AGENT }),
    ]);
    undo();
    expect(state().whiteboard.items).toEqual([]);
    expect(state().whiteboard.references).toEqual([]);
    expect(newNodes()).toEqual([]);
  });

  it("Mermaid 别的图种：渲染成图片资产，一个图片对象 + 一条引用", async () => {
    const text = "```mermaid\nsequenceDiagram\n  A->>B: hi\n```";
    const result = await exportToBoard("mermaid", text, source);
    expect(result?.itemIds).toHaveLength(1);
    const { items, references } = state().whiteboard;
    expect(items).toEqual([
      expect.objectContaining({
        kind: "image",
        assetPath: ".armadra/assets/abc.png",
        meta: { source },
      }),
    ]);
    expect(references).toEqual([
      expect.objectContaining({ itemId: items[0]!.id, nodeId: AGENT }),
    ]);
    undo();
    expect(state().whiteboard.items).toEqual([]);
  });

  it("失败时提示一行并给重试，不留半成品", async () => {
    const spy = vi.spyOn(toast, "error");
    exportText.mockRejectedValue(new Error("boom"));
    const result = await exportToBoard(
      "editor",
      "```py\nprint(1)\n```",
      source,
    );
    expect(result).toBeNull();
    expect(newNodes()).toEqual([]);
    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ action: expect.any(Object) }),
    );
  });
});
