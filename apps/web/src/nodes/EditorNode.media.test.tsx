import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { usePreferencesStore } from "../app/preferences-store";

/**
 * 编辑器的媒体预览走媒体票（契约 §37.4）：音视频与图片直接拿 `/api/media/<票>`
 * 当 `src`，不把文件读进页面；图片、文本与退回 `blob:` 的那条各有上限，超了只给
 * 下载。
 */
const fileInfo = vi.fn();
const readFile = vi.fn();
const mediaTicket = vi.fn();
vi.mock("@/api/client", () => ({
  isConflict: () => false,
  runtimeApi: {
    settings: () => Promise.resolve({}),
    fileInfo: (...args: unknown[]) => fileInfo(...args),
    readFile: (...args: unknown[]) => readFile(...args),
    mediaTicket: (...args: unknown[]) => mediaTicket(...args),
    fileDownloadUrl: (_workspace: string, path: string) =>
      `http://localhost/file-download?path=${encodeURIComponent(path)}`,
  },
}));
vi.mock("@/store/canvas-store", () => ({
  useCanvasStore: (selector: (state: unknown) => unknown) =>
    selector({ workspace: { id: "w1" } }),
}));
vi.mock("./NodeShell", () => ({
  NodeShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
import { EditorNode } from "./EditorNode";

const MiB = 1024 * 1024;

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  fileInfo.mockReset();
  readFile.mockReset();
  mediaTicket.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function open(path: string, mimeType: string, preview: string, size: number) {
  fileInfo.mockResolvedValue({ path, name: path, size, mimeType, preview });
  render(
    <EditorNode
      id="media"
      selected={false}
      collapsed={false}
      focused={false}
      node={{ title: path, data: { kind: "editor", path } } as never}
    />,
  );
}

describe("媒体票预览", () => {
  it("视频直接用媒体票地址播放，不经 fetch 取字节", async () => {
    mediaTicket.mockResolvedValue({ url: "/api/media/TICKET" });
    const fetchBytes = vi.fn();
    vi.stubGlobal("fetch", fetchBytes);
    open("clip.mp4", "video/mp4", "video", 900 * MiB);
    await vi.waitFor(() =>
      expect(
        document.querySelector("video")?.getAttribute("src") ?? "",
      ).toMatch(/\/api\/media\/TICKET$/),
    );
    expect(mediaTicket).toHaveBeenCalledWith("w1", "clip.mp4", "inline");
    expect(fetchBytes).not.toHaveBeenCalled();
    // 地址里没有文件路径。
    expect(document.querySelector("video")?.getAttribute("src")).not.toContain(
      "clip",
    );
  });

  it("音频与图片同样直接取；播放失败退回下载卡片", async () => {
    mediaTicket.mockResolvedValue({ url: "/api/media/AUDIO" });
    open("take.mp3", "audio/mpeg", "audio", 3 * MiB);
    await vi.waitFor(() =>
      expect(
        document.querySelector("audio")?.getAttribute("src") ?? "",
      ).toMatch(/\/api\/media\/AUDIO$/),
    );
    fireEvent.error(document.querySelector("audio")!);
    expect(
      await screen.findByRole("button", { name: "下载文件" }),
    ).toBeTruthy();
    cleanup();

    mediaTicket.mockResolvedValue({ url: "/api/media/IMAGE" });
    open("photo.png", "image/png", "image", 2 * MiB);
    const image = await screen.findByRole("img");
    expect(image.getAttribute("src")).toMatch(/\/api\/media\/IMAGE$/);
  });

  it("超过上限的图片只给下载，不换票也不取字节", async () => {
    const fetchBytes = vi.fn();
    vi.stubGlobal("fetch", fetchBytes);
    open("huge.png", "image/png", "image", 64 * MiB);
    expect(
      await screen.findByRole("button", { name: "下载文件" }),
    ).toBeTruthy();
    expect(mediaTicket).not.toHaveBeenCalled();
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("超过可编辑上限的文本不读正文，只给下载", async () => {
    open("big.log", "text/plain", "text", 5 * MiB);
    expect(
      await screen.findByRole("button", { name: "下载文件" }),
    ).toBeTruthy();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("老 core 换不到票：小文件退回 blob，大文件只给下载", async () => {
    mediaTicket.mockRejectedValue(new Error("no such procedure"));
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:small"),
      revokeObjectURL: vi.fn(),
    });
    const fetchBytes = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob([new Uint8Array([1, 2, 3])]),
    });
    vi.stubGlobal("fetch", fetchBytes);
    open("small.mp4", "video/mp4", "video", 3);
    await vi.waitFor(() =>
      expect(document.querySelector("video")?.getAttribute("src")).toBe(
        "blob:small",
      ),
    );
    cleanup();
    fetchBytes.mockClear();
    open("large.mp4", "video/mp4", "video", 200 * MiB);
    expect(
      await screen.findByRole("button", { name: "下载文件" }),
    ).toBeTruthy();
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it("下载在 Bearer 源上没有保存对话框时用媒体票的附件地址，不取回成 Blob", async () => {
    mediaTicket.mockImplementation(
      async (_workspace: string, _path: string, disposition: string) =>
        disposition === "attachment"
          ? { url: "/api/media/DOWNLOAD" }
          : Promise.reject(new Error("preview off")),
    );
    open("archive.zip", "application/zip", "download", 300 * MiB);
    const download = await screen.findByRole("button", { name: "下载文件" });
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.href);
    });
    // 没有保存对话框；本机源在测试里不是 Bearer，同源判断给一个别的来源，
    // 让它走第三条。
    const fetchBytes = vi.fn();
    vi.stubGlobal("fetch", fetchBytes);
    vi.stubGlobal("location", { origin: "https://elsewhere.example" });
    fireEvent.click(download);
    await vi.waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0]).toMatch(/\/api\/media\/DOWNLOAD$/);
    expect(mediaTicket).toHaveBeenCalledWith("w1", "archive.zip", "attachment");
    expect(fetchBytes).not.toHaveBeenCalled();
  });
});
