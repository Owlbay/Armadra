/**
 * 输出到画板（ACP 设计 §7，设计系统 §5.2）。
 *
 * 会话视图里的一段助手回复 → 画布上的一个对象，四条路：
 *
 *  * 便签：`addNode("sticky")` + 一条 `link` 边连回来源 Agent；
 *  * 白板文字：`addItems([text])` + 一条 `reference`；
 *  * 代码块 → 编辑器：先经 `…/exports/{nodeId}/text` 把代码写成文件，再
 *    `addNode("editor")` + `link` 边；
 *  * Mermaid → 白板：flowchart 直接落成白板对象（不走粘贴确认对话框：来源
 *    明确），外面套一个 Frame，引用指向 Frame——Frame 引用按几何读它圈住的
 *    全部对象，一条引用就够；别的图种渲染成图片资产再落成一个图片对象。
 *
 * 来源链接就是连线：别的 Agent 经 `context summary` 立刻读得到。`source`
 * 字段只用于头部「来自 · 节点名」与跳回，core 不读。
 *
 * 每条路的画布改动都是一段同步代码，包在一个合并会话里：一次操作一条历史，
 * 撤销一次全回。异步的部分（写文件、渲染、上传）全在合并会话之前做完。
 *
 * 代码块写在来源 Agent 的工作目录里（core 按该节点的会话找，契约 §14.5），
 * 远端工作空间写在执行主机上。建出的节点亮一次未读光晕（`canvas/node-flash`）。
 */
import type { ContentSource, Position, Size } from "@armadra/shared";
import { MAX_STICKY_CONTENT } from "@armadra/shared";
import { toast } from "sonner";

import { t } from "@/app/preferences-store";
import { createContentReference } from "@/canvas/create-content-reference";
import { revealCreatedNode } from "@/canvas/created-node";
import { flashNodes } from "@/canvas/node-flash";
import { nodeDropPosition } from "@/canvas/placement";
import { uploadAsset } from "@/canvas/assets";
import {
  imageShapeSize,
  measureImage,
  rasterizeSvg,
} from "@/canvas/dnd/external-content";
import { getNextStyle } from "@/canvas/interaction/tool-store";
import { canvasScheme } from "@/canvas/whiteboard/scheme";
import { centreLayout, layoutGraph } from "@/canvas/whiteboard/mermaid/layout";
import { layoutOptions } from "@/canvas/whiteboard/mermaid/import";
import { parseMermaid } from "@/canvas/whiteboard/mermaid/parse";
import { graphToItems } from "@/canvas/whiteboard/mermaid/to-items";
import type { Item } from "@/canvas/whiteboard/model";
import { addItems, createItemId, select } from "@/canvas/whiteboard/store";
import { textItemAt } from "@/canvas/whiteboard/tools/draft";
import { defaultNodeSize } from "@/store/defaults";
import {
  absolutePosition,
  beginCoalesce,
  endCoalesce,
  useCanvasStore,
} from "@/store/canvas-store";
import { acpApi } from "./api";

export const EXPORT_KINDS = ["sticky", "text", "editor", "mermaid"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

/** 新对象落在来源节点右侧多远。 */
export const EXPORT_GAP = 48;
/** 一次最多落几个代码块：一条回复里贴了二十段代码时不铺满整块画布。 */
export const MAX_CODE_EXPORTS = 8;
/** Mermaid Frame 比图大一圈。 */
const FRAME_PADDING = 32;

/* --------------------------------- 解析 ----------------------------------- */

export interface CodeBlock {
  /** 围栏上的语言名，小写；没有就是空串。 */
  lang: string;
  code: string;
}

const FENCE = /^(`{3,}|~{3,})[ \t]*([^\s`]*)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm;

/** Markdown 里的围栏代码块，按出现顺序。 */
export function codeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  for (const match of markdown.matchAll(FENCE)) {
    const code = (match[3] ?? "").replace(/\n$/, "");
    if (code.trim() === "") continue;
    blocks.push({ lang: (match[2] ?? "").toLowerCase(), code });
  }
  return blocks;
}

const isMermaid = (block: CodeBlock) => block.lang === "mermaid";

/** 这段文字能走哪几条路；不可用的菜单项灰掉（设计系统 §5.2）。 */
export function availableExports(text: string): ReadonlySet<ExportKind> {
  const kinds = new Set<ExportKind>();
  if (text.trim() === "") return kinds;
  kinds.add("sticky");
  kinds.add("text");
  const blocks = codeBlocks(text);
  if (blocks.some((block) => !isMermaid(block))) kinds.add("editor");
  if (blocks.some(isMermaid)) kinds.add("mermaid");
  return kinds;
}

const EXTENSIONS: Record<string, string> = {
  ts: "ts",
  typescript: "ts",
  tsx: "tsx",
  js: "js",
  javascript: "js",
  jsx: "jsx",
  mjs: "mjs",
  py: "py",
  python: "py",
  rs: "rs",
  rust: "rs",
  go: "go",
  sh: "sh",
  bash: "sh",
  shell: "sh",
  zsh: "sh",
  console: "sh",
  json: "json",
  yaml: "yml",
  yml: "yml",
  toml: "toml",
  md: "md",
  markdown: "md",
  html: "html",
  css: "css",
  scss: "scss",
  sql: "sql",
  java: "java",
  kotlin: "kt",
  kt: "kt",
  swift: "swift",
  c: "c",
  h: "h",
  cpp: "cpp",
  "c++": "cpp",
  cs: "cs",
  csharp: "cs",
  rb: "rb",
  ruby: "rb",
  php: "php",
  diff: "diff",
  patch: "diff",
  xml: "xml",
  dockerfile: "dockerfile",
};

export function extensionFor(lang: string): string {
  return EXTENSIONS[lang] ?? "txt";
}

/**
 * 导出文件名：`<会话前缀>-<messageId>-<n>.<ext>`。只留 `[A-Za-z0-9_-]`，
 * 与契约 §14.5 的文件名规则对齐；会话前缀让同一节点换过会话后不互相覆盖。
 */
export function exportFileName(
  source: ContentSource,
  index: number,
  lang: string,
): string {
  const clean = (value: string) =>
    value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  const session = clean(source.sessionId).slice(0, 8) || "s";
  const message = clean(source.messageId ?? "") || "m";
  return `${session}-${message}-${index + 1}.${extensionFor(lang)}`;
}

/* --------------------------------- 落点 ----------------------------------- */

interface Origin {
  /** 来源节点右侧、与它顶边齐平的落点（左上角）。 */
  topLeft: Position;
  boardId: string;
  workspaceId: string;
}

function originOf(source: ContentSource): Origin | null {
  const state = useCanvasStore.getState();
  const document = state.document;
  const workspace = state.workspace;
  if (!document || !workspace) return null;
  const node = document.nodes.find((item) => item.id === source.nodeId);
  if (!node) return null;
  const at = absolutePosition(document.nodes, node);
  return {
    topLeft: {
      x:
        at.x +
        (node.size?.width ?? defaultNodeSize(node.type).width) +
        EXPORT_GAP,
      y: at.y,
    },
    boardId: document.board.id,
    workspaceId: workspace.id,
  };
}

/** 节点类型的落点：以「来源右侧」为锚点，压住别的节点就按 32px 让开。 */
function nodeAt(
  type: "sticky" | "editor",
  origin: Position,
  index = 0,
): Position {
  const size: Size = defaultNodeSize(type);
  return nodeDropPosition(type, {
    anchor: {
      x: origin.x + size.width / 2,
      y: origin.y + size.height / 2 + index * (size.height + 24),
    },
    size,
  });
}

/** 一段同步的画布改动 = 一条历史。 */
function asOneStep<T>(label: string, run: () => T): T {
  beginCoalesce(label);
  try {
    return run();
  } finally {
    endCoalesce();
  }
}

/* --------------------------------- 四条路 --------------------------------- */

export interface ExportResult {
  /** 新建的节点 id（便签 / 编辑器）。 */
  nodeIds: string[];
  /** 新建的白板对象 id（文字 / Mermaid）。 */
  itemIds: string[];
  /** Mermaid flowchart 外面那个 Frame。 */
  frameId?: string;
}

/** 整条回复 / 选中段落 → 便签节点 + 一条 `link` 边。 */
export function exportSticky(
  text: string,
  source: ContentSource,
): ExportResult | null {
  const origin = originOf(source);
  const content = text.trim().slice(0, MAX_STICKY_CONTENT);
  if (!origin || !content) return null;
  const id = asOneStep("acp.export.sticky", () => {
    const store = useCanvasStore.getState();
    const created = store.addNode("sticky", {
      position: nodeAt("sticky", origin.topLeft),
      data: { kind: "sticky", content, source },
    });
    if (created) store.addEdge(created, source.nodeId);
    return created;
  });
  if (!id) return null;
  revealCreatedNode(id);
  flashNodes([id]);
  return { nodeIds: [id], itemIds: [] };
}

/** 短结论 → 白板文字对象 + 一条引用。 */
export function exportText(
  text: string,
  source: ContentSource,
): ExportResult | null {
  const origin = originOf(source);
  const content = text.trim();
  if (!origin || !content) return null;
  const item = {
    ...textItemAt(origin.topLeft, createItemId()),
    text: content,
    h: Math.max(24, 20 * content.split("\n").length),
    meta: { source },
  };
  asOneStep("acp.export.text", () => {
    addItems([item]);
    createContentReference(item.id, source.nodeId, { notify: false });
  });
  select([item.id]);
  return { nodeIds: [], itemIds: [item.id] };
}

/** 代码块 → 文件 → 编辑器节点 + 一条 `link` 边（每块一个）。 */
export async function exportCode(
  text: string,
  source: ContentSource,
): Promise<ExportResult | null> {
  const origin = originOf(source);
  if (!origin) return null;
  const blocks = codeBlocks(text)
    .filter((block) => !isMermaid(block))
    .slice(0, MAX_CODE_EXPORTS);
  if (blocks.length === 0) return null;
  // 先写完全部文件：合并会话里不能等网络，不然别的编辑会被并进这一步。
  const paths: string[] = [];
  for (const [index, block] of blocks.entries()) {
    const written = await acpApi.exportText(
      origin.workspaceId,
      source.nodeId,
      exportFileName(source, index, block.lang),
      `${block.code}\n`,
    );
    paths.push(written.relativePath);
  }
  // 写文件期间画布可能被切走：落不下就当没做。
  const now = originOf(source);
  if (!now || now.boardId !== origin.boardId) return null;
  const ids = asOneStep("acp.export.editor", () => {
    const store = useCanvasStore.getState();
    const created: string[] = [];
    for (const [index, path] of paths.entries()) {
      const id = store.addNode("editor", {
        title: path.slice(path.lastIndexOf("/") + 1),
        position: nodeAt("editor", now.topLeft, index),
        data: { kind: "editor", path, source },
      });
      if (!id) continue;
      store.addEdge(id, source.nodeId);
      created.push(id);
    }
    return created;
  });
  if (ids.length === 0) return null;
  revealCreatedNode(ids[0] as string);
  flashNodes(ids);
  return { nodeIds: ids, itemIds: [] };
}

function boundsOf(items: readonly Item[]) {
  const left = Math.min(...items.map((item) => item.x));
  const top = Math.min(...items.map((item) => item.y));
  const right = Math.max(...items.map((item) => item.x + item.w));
  const bottom = Math.max(...items.map((item) => item.y + item.h));
  return { left, top, right, bottom };
}

/** Mermaid 代码块 → 白板对象（flowchart）或图片对象，外加一条引用。 */
export async function exportMermaid(
  text: string,
  source: ContentSource,
): Promise<ExportResult | null> {
  const origin = originOf(source);
  const block = codeBlocks(text).find(isMermaid);
  if (!origin || !block) return null;
  const parsed = await parseMermaid(block.code);
  const meta = { source };

  if (parsed.kind === "graph") {
    const now = originOf(source);
    if (!now || now.boardId !== origin.boardId) return null;
    const style = getNextStyle();
    const layout = layoutGraph(parsed.graph, layoutOptions());
    const probe = centreLayout(layout, { x: 0, y: 0 });
    const items = graphToItems(parsed.graph, probe, {
      style: { color: style.color, size: style.size },
      scheme: canvasScheme(),
      newId: createItemId,
    });
    if (items.length === 0) return null;
    // 先按原点排一次量出包围盒，再整体平移到来源右侧（Frame 留一圈边）。
    const box = boundsOf(items);
    const dx = now.topLeft.x + FRAME_PADDING - box.left;
    const dy = now.topLeft.y + FRAME_PADDING - box.top;
    const placed = items.map(
      (item) => ({ ...item, x: item.x + dx, y: item.y + dy, meta }) as Item,
    );
    const frameSize = {
      width: box.right - box.left + FRAME_PADDING * 2,
      height: box.bottom - box.top + FRAME_PADDING * 2,
    };
    const result = asOneStep("acp.export.mermaid", () => {
      const ids = addItems(placed);
      const frameId = useCanvasStore.getState().addNode("group", {
        title: t("acp.export.frame"),
        position: now.topLeft,
        size: frameSize,
        select: false,
      });
      if (frameId) {
        createContentReference(frameId, source.nodeId, { notify: false });
      }
      return { ids, frameId };
    });
    select(result.ids);
    return {
      nodeIds: [],
      itemIds: result.ids,
      ...(result.frameId ? { frameId: result.frameId } : {}),
    };
  }

  // 别的图种：渲染成 SVG → 栅格化 → 资产（内容寻址，不把字节塞进白板文档）。
  const { renderMermaidSvg, svgToFile } = await import(
    "@/canvas/whiteboard/mermaid/render"
  );
  const svg = await renderMermaidSvg(block.code);
  const file = await rasterizeSvg(
    svgToFile(svg, parsed.diagramType || "diagram"),
  );
  const natural = (await measureImage(file)) ?? { w: 480, h: 320 };
  const assetPath = await uploadAsset(origin.workspaceId, file);
  const now = originOf(source);
  if (!now || now.boardId !== origin.boardId) return null;
  const size = imageShapeSize(natural);
  const item: Item = {
    id: createItemId(),
    kind: "image",
    x: now.topLeft.x,
    y: now.topLeft.y,
    w: size.w,
    h: size.h,
    z: 0,
    parentId: null,
    style: { color: "black", size: "m" },
    assetPath,
    alt: parsed.diagramType || "mermaid",
    meta,
  };
  asOneStep("acp.export.mermaid", () => {
    addItems([item]);
    createContentReference(item.id, source.nodeId, { notify: false });
  });
  select([item.id]);
  return { nodeIds: [], itemIds: [item.id] };
}

/**
 * 菜单入口：四条路的分派 + 失败提示。失败 → sonner 一行「没有放到画板上」
 * +「重试」（设计系统 §5.2），重试就是把同一次调用再做一遍。
 */
export async function exportToBoard(
  kind: ExportKind,
  text: string,
  source: ContentSource,
): Promise<ExportResult | null> {
  let result: ExportResult | null = null;
  try {
    switch (kind) {
      case "sticky":
        result = exportSticky(text, source);
        break;
      case "text":
        result = exportText(text, source);
        break;
      case "editor":
        result = await exportCode(text, source);
        break;
      case "mermaid":
        result = await exportMermaid(text, source);
        break;
    }
  } catch {
    result = null;
  }
  if (!result) {
    toast.error(t("acp.export.failed"), {
      action: {
        label: t("acp.error.retry"),
        onClick: () => void exportToBoard(kind, text, source),
      },
    });
  }
  return result;
}
