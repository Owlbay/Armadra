import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ app: false, saved: null as string | null }));
vi.mock("../mobile/native-bridge", async (original) => ({
  ...(await original<typeof import("../mobile/native-bridge")>()),
  isNativeApp: () => mocks.app,
}));
vi.mock("./runtime-url", async (original) => ({
  ...(await original<typeof import("./runtime-url")>()),
  savedRuntimeOrigin: () => mocks.saved,
}));

import {
  acquireAssetUrl,
  downloadRuntimeFile,
  needsBearerFetch,
  useAssetUrl,
} from "./assets";

const GATEWAY = "https://192.168.1.8:8443";
const ASSET = `${GATEWAY}/api/workspaces/w1/assets/0011223344556677.png`;

let created = 0;
const revoked: string[] = [];
beforeEach(() => {
  created = 0;
  revoked.length = 0;
  Object.assign(mocks, { app: false, saved: null });
  vi.stubGlobal(
    "URL",
    Object.assign(globalThis.URL, {
      createObjectURL: vi.fn(() => `blob:test/${++created}`),
      revokeObjectURL: vi.fn((url: string) => revoked.push(url)),
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("needsBearerFetch（R-55）", () => {
  it("只在原生 App 里、只对 Gateway 来源", () => {
    expect(needsBearerFetch(ASSET, true, GATEWAY)).toBe(true);
    expect(needsBearerFetch(ASSET, false, GATEWAY)).toBe(false);
    expect(needsBearerFetch(ASSET, true, null)).toBe(false);
    expect(needsBearerFetch("https://cdn.example/a.png", true, GATEWAY)).toBe(
      false,
    );
    expect(needsBearerFetch("data:image/png;base64,AA", true, GATEWAY)).toBe(
      false,
    );
  });
});

describe("needsBearerFetch：桌面壳（契约 §3.2）", () => {
  const CORE = "http://127.0.0.1:5123";
  it("壳里对 core 的回环来源经 fetch 取，别处的原样用", () => {
    const asset = `${CORE}/api/workspaces/w1/assets/a.png`;
    expect(needsBearerFetch(asset, false, null, true, CORE)).toBe(true);
    expect(needsBearerFetch(asset, false, null, false, CORE)).toBe(false);
    expect(
      needsBearerFetch("http://127.0.0.1:9/a.png", false, null, true, CORE),
    ).toBe(false);
    expect(
      needsBearerFetch("data:image/png;base64,AA", false, null, true, CORE),
    ).toBe(false);
  });
});

describe("downloadRuntimeFile", () => {
  it("经 fetch 取回，交给一个 blob: 链接存下", async () => {
    const load = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["x"]),
    })) as unknown as typeof fetch;
    const clicked: { href: string; download: string }[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push({ href: this.href, download: this.download });
      });
    try {
      await expect(
        downloadRuntimeFile("http://core/file-download?path=a", "a.bin", load),
      ).resolves.toBe(true);
    } finally {
      click.mockRestore();
    }
    expect(load).toHaveBeenCalledWith("http://core/file-download?path=a", {
      cache: "no-store",
    });
    expect(clicked).toEqual([{ href: "blob:test/1", download: "a.bin" }]);
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("取不回（401、网络错误）答 false，不点任何链接", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
    try {
      const refused = vi.fn(async () => ({ ok: false, status: 401 }));
      await expect(
        downloadRuntimeFile(
          "http://core/x",
          "x",
          refused as unknown as typeof fetch,
        ),
      ).resolves.toBe(false);
      const offline = vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      });
      await expect(
        downloadRuntimeFile(
          "http://core/x",
          "x",
          offline as unknown as typeof fetch,
        ),
      ).resolves.toBe(false);
      expect(click).not.toHaveBeenCalled();
    } finally {
      click.mockRestore();
    }
  });
});

describe("acquireAssetUrl", () => {
  it("同一个地址共用一次取回；最后一个占用者走时回收", async () => {
    const load = vi.fn(async () => new Response("png"));
    const a = acquireAssetUrl(ASSET, load);
    const b = acquireAssetUrl(ASSET, load);
    await expect(a.ready).resolves.toBe("blob:test/1");
    await expect(b.ready).resolves.toBe("blob:test/1");
    expect(load).toHaveBeenCalledTimes(1);
    a.release();
    a.release();
    expect(revoked).toEqual([]);
    b.release();
    expect(revoked).toEqual(["blob:test/1"]);
  });

  it("取不回答 null；取回之前都走了的不留", async () => {
    const failed = acquireAssetUrl(
      `${ASSET}?x`,
      vi.fn(async () => new Response("no", { status: 401 })),
    );
    await expect(failed.ready).resolves.toBeNull();
    failed.release();
    let finish: (value: Response) => void = () => undefined;
    const slow = acquireAssetUrl(
      `${ASSET}?slow`,
      () => new Promise<Response>((done) => (finish = done)),
    );
    slow.release();
    finish(new Response("png"));
    await expect(slow.ready).resolves.toBeNull();
    expect(revoked).toEqual(["blob:test/1"]);
  });
});

describe("useAssetUrl", () => {
  it("浏览器与桌面里原样返回；原生 App 里先 undefined，取回后是 blob:，经 fetch 带 Bearer", async () => {
    const plain = renderHook(() => useAssetUrl(ASSET));
    expect(plain.result.current).toBe(ASSET);
    expect(renderHook(() => useAssetUrl(null)).result.current).toBeNull();

    mocks.app = true;
    mocks.saved = GATEWAY;
    const fetcher = vi.fn(async () => new Response("png"));
    vi.stubGlobal("fetch", fetcher);
    const hook = renderHook(() => useAssetUrl(ASSET));
    expect(hook.result.current).toBeUndefined();
    await waitFor(() => expect(hook.result.current).toMatch(/^blob:test\//));
    expect(fetcher).toHaveBeenCalledWith(ASSET, { cache: "no-store" });
    const src = hook.result.current as string;
    act(() => hook.unmount());
    expect(revoked).toContain(src);
  });

  it("原生 App 里取不回是 null（调用方画「图坏了」）", async () => {
    mocks.app = true;
    mocks.saved = GATEWAY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    const hook = renderHook(() => useAssetUrl(`${ASSET}?missing`));
    await waitFor(() => expect(hook.result.current).toBeNull());
  });
});
