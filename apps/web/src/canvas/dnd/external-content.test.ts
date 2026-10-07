import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardDocument } from "@armadra/shared";

const fileInfo = vi.fn();
vi.mock("../../api/client", () => ({
  runtimeApi: {
    fileInfo: (...args: unknown[]) => fileInfo(...args),
    listFiles: vi.fn().mockRejectedValue(new Error("not a directory")),
    importLocalFiles: vi.fn().mockResolvedValue({ files: [] }),
  },
}));

import { megabytes, withinUploadLimit } from "../assets";
import { useCanvasStore } from "../../store/canvas-store";
import { canUndo, resetHistory, undo } from "../../store/canvas/history";
import { emptyWhiteboard } from "../whiteboard/model";
import {
  addNodesForPaths,
  IMAGE_GAP,
  MAX_IMAGE_DIMENSION,
  baseName,
  extensionOf,
  imageShapeSize,
  isImagePath,
  layoutImages,
  offsetBy,
  routeFile,
  routePath,
} from "./external-content";

/**
 * 外部内容的分流规则（React Flow 计划 F27）。
 *
 * 规则表换引擎一条没变，所以这份测试也基本原样留着：只有资产那一段跟着
 * `assets.ts` 的新接口改了（旧引擎的 `meta.armadra.path` 不存在了，路径
 * 现在直接写进白板对象）。副作用那一半在 `asset-import.test.ts`。
 */

const file = (name: string, type: string) => ({ name, type });

describe("routeFile", () => {
  it("认 MIME 白名单里的图片", () => {
    expect(routeFile(file("a.png", "image/png"))).toBe("image");
    expect(routeFile(file("a.svg", "image/svg+xml"))).toBe("image");
    expect(routeFile(file("a.avif", "image/avif"))).toBe("image");
  });

  it("MIME 为空时退回扩展名", () => {
    expect(routeFile(file("shot.JPEG", ""))).toBe("image");
    expect(routeFile(file("no-extension", ""))).toBe("file");
  });

  it("非图片一律持久化为文件", () => {
    expect(routeFile(file("notes.md", "text/markdown"))).toBe("file");
    expect(routeFile(file("main.rs", ""))).toBe("file");
    // Runtime 不收的图片格式也不当图片（会被资产接口 400）。
    expect(routeFile(file("clip.mp4", "video/mp4"))).toBe("file");
    expect(routeFile(file("x.tiff", "image/tiff"))).toBe("file");
  });

  it("按扩展名认 .mmd / .mermaid（它们没有可用的 MIME）", () => {
    expect(routeFile(file("chart.mmd", ""))).toBe("mermaid");
    expect(routeFile(file("chart.mermaid", "text/plain"))).toBe("mermaid");
    expect(routeFile(file("CHART.MMD", ""))).toBe("mermaid");
  });

  it("图片判定排在前面：`a.png.mmd` 仍然只算一种", () => {
    // 扩展名是 `.mmd`，所以走 mermaid 而不是图片。
    expect(routeFile(file("a.png.mmd", ""))).toBe("mermaid");
    // 真图片带 MIME 时不会被误判成图。
    expect(routeFile(file("a.mmd.png", "image/png"))).toBe("image");
  });
});

describe("routePath", () => {
  it("目录 → files 节点，文件 → editor 节点", () => {
    expect(routePath(true)).toBe("files");
    expect(routePath(false)).toBe("editor");
  });
});

describe("路径小工具", () => {
  it("baseName 认两种分隔符", () => {
    expect(baseName("/a/b/c.png")).toBe("c.png");
    expect(baseName("C:\\a\\b\\c.png")).toBe("c.png");
    expect(baseName("c.png")).toBe("c.png");
  });

  it("extensionOf 忽略大小写、不认隐藏文件的前导点", () => {
    expect(extensionOf("/a/B.PNG")).toBe("png");
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("Makefile")).toBe("");
  });

  it("isImagePath 覆盖八种扩展名", () => {
    for (const ext of [
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "avif",
      "bmp",
      "svg",
    ]) {
      expect(isImagePath(`/tmp/a.${ext}`)).toBe(true);
    }
    expect(isImagePath("/tmp/a.txt")).toBe(false);
  });
});

describe("imageShapeSize", () => {
  it("小图保持自然尺寸", () => {
    expect(imageShapeSize({ w: 320, h: 200 })).toEqual({ w: 320, h: 200 });
    expect(imageShapeSize({ w: MAX_IMAGE_DIMENSION, h: 400 })).toEqual({
      w: MAX_IMAGE_DIMENSION,
      h: 400,
    });
  });

  it("按最大边等比缩到 800", () => {
    expect(imageShapeSize({ w: 4000, h: 2000 })).toEqual({ w: 800, h: 400 });
    expect(imageShapeSize({ w: 1000, h: 3000 })).toEqual({ w: 267, h: 800 });
  });

  it("尺寸不合法时退回正方形", () => {
    expect(imageShapeSize({ w: 0, h: 0 })).toEqual({ w: 800, h: 800 });
    expect(imageShapeSize({ w: Number.NaN, h: Number.NaN })).toEqual({
      w: 800,
      h: 800,
    });
  });

  it("最大边可覆盖", () => {
    expect(imageShapeSize({ w: 400, h: 200 }, 100)).toEqual({ w: 100, h: 50 });
  });
});

describe("layoutImages", () => {
  it("单张图居中在落点上", () => {
    expect(layoutImages([{ w: 200, h: 100 }], { x: 50, y: 30 })).toEqual([
      { x: -50, y: -20 },
    ]);
  });

  it("多张图横排、整排居中、间距固定", () => {
    const points = layoutImages(
      [
        { w: 100, h: 100 },
        { w: 100, h: 50 },
      ],
      { x: 0, y: 0 },
    );
    const total = 100 + 100 + IMAGE_GAP;
    expect(points[0]).toEqual({ x: -total / 2, y: -50 });
    expect(points[1]).toEqual({ x: -total / 2 + 100 + IMAGE_GAP, y: -25 });
  });

  it("空数组不产生落点", () => {
    expect(layoutImages([], { x: 0, y: 0 })).toEqual([]);
  });
});

describe("offsetBy", () => {
  it("每个节点错开 28px", () => {
    expect(offsetBy({ x: 10, y: 20 }, 0)).toEqual({ x: 10, y: 20 });
    expect(offsetBy({ x: 10, y: 20 }, 2)).toEqual({ x: 66, y: 76 });
  });
});

describe("资产限额", () => {
  it("withinUploadLimit 卡在 8 MiB", () => {
    expect(withinUploadLimit(8 * 1024 * 1024)).toBe(true);
    expect(withinUploadLimit(8 * 1024 * 1024 + 1)).toBe(false);
  });

  it("megabytes 用来拼提示语", () => {
    expect(megabytes(8 * 1024 * 1024)).toBe("8");
  });
});

/* ----------------------- 导入批次成组（UI 设计 §6.3） ----------------------- */

describe("导入批次", () => {
  const STAMP = "2026-10-07T00:00:00.000Z";
  beforeEach(() => {
    resetHistory();
    fileInfo
      .mockReset()
      .mockImplementation((_workspace: string, path: string) =>
        Promise.resolve({ path, name: baseName(path) }),
      );
    useCanvasStore.setState({
      workspace: { id: "w1", rootPath: "/w" } as never,
      document: {
        board: {
          id: "019ff7d1-0d12-7421-833d-2c5e8d64ed00",
          workspaceId: "w1",
          name: "board",
          sortOrder: 0,
          viewport: { x: 0, y: 0, zoom: 1 },
          whiteboard: "",
          createdAt: STAMP,
          updatedAt: STAMP,
        },
        nodes: [],
        edges: [],
      } as unknown as BoardDocument,
      whiteboard: emptyWhiteboard(),
    });
  });
  afterEach(() => {
    resetHistory();
    useCanvasStore.setState({ document: null, whiteboard: emptyWhiteboard() });
  });

  const nodes = () => useCanvasStore.getState().document?.nodes ?? [];

  it("一次拖入 ≥ 2 个文件：套一个「导入」组，节点 parentId 指向它", async () => {
    await addNodesForPaths(["src/a.ts", "src/b.ts", "README.md"], {
      x: 100,
      y: 100,
    });
    const groups = nodes().filter((node) => node.type === "group");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.data).toMatchObject({ kind: "group", origin: "import" });
    const editors = nodes().filter((node) => node.type === "editor");
    expect(editors).toHaveLength(3);
    expect(editors.every((node) => node.parentId === groups[0]!.id)).toBe(true);
    // 一条历史：撤销一次整批消失。
    undo();
    expect(canUndo()).toBe(false);
    expect(nodes()).toHaveLength(0);
  });

  it("单个文件不套组", async () => {
    await addNodesForPaths(["src/a.ts"], { x: 0, y: 0 });
    expect(nodes().map((node) => node.type)).toEqual(["editor"]);
    expect(nodes()[0]!.parentId).toBeUndefined();
  });
});
