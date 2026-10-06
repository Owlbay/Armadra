import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireAssetUrl,
  bearerSourceFor,
  directFileUrl,
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

describe("downloadRuntimeFile 流式保存", () => {
  function picked() {
    const chunks: Uint8Array[] = [];
    let closed = false;
    const removed = vi.fn(async () => undefined);
    const handle = {
      createWritable: async () =>
        new WritableStream<Uint8Array>({
          write(chunk) {
            chunks.push(chunk);
          },
          close() {
            closed = true;
          },
        }),
      remove: removed,
    };
    const picker = vi.fn(async () => handle);
    return {
      picker,
      chunks,
      removed,
      get closed() {
        return closed;
      },
    };
  }

  function streamed(parts: string[]): Response {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const part of parts) controller.enqueue(encoder.encode(part));
          controller.close();
        },
      }),
    );
  }

  it("有保存对话框：先选文件，再把响应体逐块写进去，不取 Blob", async () => {
    const save = picked();
    const response = streamed(["ab", "cd", "ef"]);
    const blob = vi.spyOn(response, "blob");
    const load = vi.fn(async () => response) as unknown as typeof fetch;
    await expect(
      downloadRuntimeFile("http://core/x", "x.bin", load, {
        picker: save.picker,
      }),
    ).resolves.toBe(true);
    expect(save.picker).toHaveBeenCalledWith({ suggestedName: "x.bin" });
    expect(save.chunks.map((chunk) => new TextDecoder().decode(chunk))).toEqual(
      ["ab", "cd", "ef"],
    );
    expect(save.closed).toBe(true);
    expect(blob).not.toHaveBeenCalled();
    expect(created).toBe(0);
  });

  it("取消保存对话框答 true，不发请求", async () => {
    const load = vi.fn();
    const picker = vi.fn(async () => {
      throw new DOMException("cancelled", "AbortError");
    });
    await expect(
      downloadRuntimeFile(
        "http://core/x",
        "x",
        load as unknown as typeof fetch,
        {
          picker,
        },
      ),
    ).resolves.toBe(true);
    expect(load).not.toHaveBeenCalled();
  });

  it("取不回答 false，并删掉对话框建出来的文件", async () => {
    const save = picked();
    const load = vi.fn(
      async () => new Response("no", { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(
      downloadRuntimeFile("http://core/x", "x", load, { picker: save.picker }),
    ).resolves.toBe(false);
    expect(save.removed).toHaveBeenCalledTimes(1);
  });

  it("对话框打不开（没有用户激活）时退回 Blob", async () => {
    const picker = vi.fn(async () => {
      throw new DOMException("no activation", "SecurityError");
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    try {
      await expect(
        downloadRuntimeFile(
          "http://core/x",
          "x",
          vi.fn(async () => new Response("x")) as unknown as typeof fetch,
          { picker, sources: [], origin: "http://page" },
        ),
      ).resolves.toBe(true);
    } finally {
      click.mockRestore();
    }
    expect(created).toBe(1);
  });

  it("同源的 Cookie 源：只看状态就中止，正文交给浏览器自己的下载", async () => {
    const PAGE = "https://armadra.example";
    const url = `${PAGE}/api/workspaces/w1/file-download?path=big.iso`;
    let signal: AbortSignal | undefined;
    const response = streamed(["never read"]);
    const blob = vi.spyOn(response, "blob");
    const load = vi.fn(async (_input: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return response;
    }) as unknown as typeof fetch;
    const clicked: { href: string; download: string }[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push({ href: this.href, download: this.download });
      });
    try {
      await expect(
        downloadRuntimeFile(url, "big.iso", load, {
          picker: null,
          sources: [source(PAGE, "cookie")],
          origin: PAGE,
        }),
      ).resolves.toBe(true);
    } finally {
      click.mockRestore();
    }
    expect(signal?.aborted).toBe(true);
    expect(blob).not.toHaveBeenCalled();
    expect(clicked).toEqual([{ href: url, download: "big.iso" }]);
    expect(created).toBe(0);
  });

  it("同源但是 Bearer 的源：直接的链接没有凭据，仍经 Blob", async () => {
    const PAGE = "https://armadra.example";
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    try {
      await expect(
        downloadRuntimeFile(
          `${PAGE}/api/x`,
          "x",
          vi.fn(async () => new Response("x")) as unknown as typeof fetch,
          { picker: null, sources: [source(PAGE, "bearer")], origin: PAGE },
        ),
      ).resolves.toBe(true);
    } finally {
      click.mockRestore();
    }
    expect(created).toBe(1);
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

describe("directFileUrl（媒体票，契约 §37.4）", () => {
  const RELAY = "https://relay.example/s/0123456789abcdef0123456789abcdef";

  it("直连的源：core 的票地址拼在源地址后面", async () => {
    const issue = vi.fn().mockResolvedValue({ url: "/api/media/CORE" });
    const url = await directFileUrl(
      "w1",
      "a.mp4",
      "inline",
      issue,
      source(GATEWAY, "bearer"),
    );
    expect(url).toBe(`${GATEWAY}/api/media/CORE`);
    expect(issue).toHaveBeenCalledWith("w1", "a.mp4", "inline");
  });

  it("经中继的源：再用源的 fetch（带中继令牌）换中继的票", async () => {
    const issue = vi.fn().mockResolvedValue({ url: "/api/media/CORE" });
    const relayFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(`${RELAY}/_relay/media-tickets`);
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          path: "/api/media/CORE",
        });
        return new Response(
          JSON.stringify({ ticket: "R", path: "/_relay/m/RELAYTICKET" }),
          { status: 200 },
        );
      },
    );
    const relayed: Source = {
      ...source(RELAY, "bearer"),
      fetch: relayFetch as typeof fetch,
      relayed: () => true,
    };
    expect(await directFileUrl("w1", "a.mp4", "inline", issue, relayed)).toBe(
      `${RELAY}/_relay/m/RELAYTICKET`,
    );
    expect(relayFetch).toHaveBeenCalledTimes(1);
  });

  it("换票失败、形状不对、老中继答错都给 null（调用方退回 blob）", async () => {
    const bearer = source(GATEWAY, "bearer");
    expect(
      await directFileUrl(
        "w1",
        "a",
        "inline",
        vi.fn().mockRejectedValue(new Error("no procedure")),
        bearer,
      ),
    ).toBeNull();
    expect(
      await directFileUrl(
        "w1",
        "a",
        "inline",
        vi.fn().mockResolvedValue({ url: "https://evil.example/x" }),
        bearer,
      ),
    ).toBeNull();
    const oldRelay: Source = {
      ...source(RELAY, "bearer"),
      fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch,
      relayed: () => true,
    };
    expect(
      await directFileUrl(
        "w1",
        "a",
        "inline",
        vi.fn().mockResolvedValue({ url: "/api/media/CORE" }),
        oldRelay,
      ),
    ).toBeNull();
  });
});
