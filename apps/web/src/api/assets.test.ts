import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireAssetUrl,
  bearerSourceFor,
  downloadRuntimeFile,
  needsBearerFetch,
  useAssetUrl,
} from "./assets";
import {
  type Source,
  type SourceCredentials,
  localSource,
  registerSource,
} from "./source";

const GATEWAY = "https://192.168.1.8:8443";
const ASSET = `${GATEWAY}/api/workspaces/w1/assets/0011223344556677.png`;

function source(
  httpBase: string,
  mode: SourceCredentials["mode"],
  sourceId = httpBase,
): Source {
  return {
    sourceId,
    httpBase,
    wsBase: httpBase.replace(/^http/, "ws"),
    credentials: {
      mode,
      access: async () => null,
      renew: async () => false,
      csrf: async () => null,
      renewCsrf: async () => null,
    },
    fetch: (input, init) => globalThis.fetch(input, init),
    WebSocket: globalThis.WebSocket,
  };
}

let unregister: (() => void) | null = null;
let created = 0;
const revoked: string[] = [];
beforeEach(() => {
  created = 0;
  revoked.length = 0;
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
  unregister?.();
  unregister = null;
});

describe("needsBearerFetch（R-55）", () => {
  it("只对 Bearer 模式的源、只按来源比", () => {
    const gateway = source(GATEWAY, "bearer");
    expect(needsBearerFetch(ASSET, [gateway])).toBe(true);
    expect(bearerSourceFor(ASSET, [gateway])).toBe(gateway);
    expect(needsBearerFetch(ASSET, [source(GATEWAY, "cookie")])).toBe(false);
    expect(needsBearerFetch(ASSET, [])).toBe(false);
    expect(needsBearerFetch("https://cdn.example/a.png", [gateway])).toBe(
      false,
    );
    expect(needsBearerFetch("data:image/png;base64,AA", [gateway])).toBe(false);
  });

  it("几个源并存：按地址找到那一个", () => {
    const CORE = "http://127.0.0.1:5123";
    const local = source(CORE, "bearer", "local");
    const remote = source(GATEWAY, "bearer", "remote");
    expect(
      bearerSourceFor(`${CORE}/api/workspaces/w1/assets/a.png`, [
        local,
        remote,
      ]),
    ).toBe(local);
    expect(bearerSourceFor(ASSET, [local, remote])).toBe(remote);
    expect(needsBearerFetch("http://127.0.0.1:9/a.png", [local, remote])).toBe(
      false,
    );
  });

  it("缺省看本机源与挂载的源：没装凭据的本机源不经 fetch", () => {
    expect(localSource.credentials.mode).not.toBe("bearer");
    expect(needsBearerFetch(`${localSource.httpBase}/a.png`)).toBe(false);
    expect(needsBearerFetch(ASSET)).toBe(false);
    unregister = registerSource(source(GATEWAY, "bearer"));
    expect(needsBearerFetch(ASSET)).toBe(true);
    unregister();
    unregister = null;
    expect(needsBearerFetch(ASSET)).toBe(false);
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
  it("不属于 Bearer 源的原样返回；属于的先 undefined，取回后是 blob:，经那个源的 fetch", async () => {
    const plain = renderHook(() => useAssetUrl(ASSET));
    expect(plain.result.current).toBe(ASSET);
    expect(renderHook(() => useAssetUrl(null)).result.current).toBeNull();

    unregister = registerSource(source(GATEWAY, "bearer"));
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

  it("取不回是 null（调用方画「图坏了」）", async () => {
    unregister = registerSource(source(GATEWAY, "bearer"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    const hook = renderHook(() => useAssetUrl(`${ASSET}?missing`));
    await waitFor(() => expect(hook.result.current).toBeNull());
  });
});
