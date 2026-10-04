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

import { acquireAssetUrl, needsBearerFetch, useAssetUrl } from "./assets";

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
