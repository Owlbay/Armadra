import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeConnectionError,
  RuntimeRequestError,
  createClient,
  isConflict,
  isDefinedError,
  localSource,
} from "./client";
import { type Source, installLocalTransport } from "./source";

/**
 * RPC 门面（工程规范化包 §1.4）：源的异步头、源的 `fetch`（401 换一枚只重发
 * 一次、CSRF 被拒换一枚只重发一次）、线上 envelope 变成 `RuntimeRequestError`、
 * `isDefinedError`。
 */

type Call = { url: string; init: RequestInit };
let calls: Call[];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function stubFetch(answer: (call: Call, index: number) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(input), init: init ?? {} };
      calls.push(call);
      return answer(call, calls.length - 1);
    }),
  );
}

const header = (call: Call | undefined, name: string) =>
  new Headers(call?.init.headers).get(name);

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  installLocalTransport(null);
});

describe("createClient", () => {
  it("POST <httpBase>/api/rpc/<域>/<动词>，体是 { json }，答案取 json", async () => {
    stubFetch(() => json(200, { json: { ts: 1, serverTs: 2 } }));
    const client = createClient(localSource);
    await expect(client.system.ping({ ts: 1 })).resolves.toEqual({
      ts: 1,
      serverTs: 2,
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:43120/api/rpc/system/ping");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      json: { ts: 1 },
    });
  });

  it("Cookie 模式：异步头带 CSRF；被拒（403 forbidden）换一枚只重发一次", async () => {
    const renewCsrf = vi.fn(async () => "fresh");
    const source: Source = {
      ...localSource,
      sourceId: "s1",
      httpBase: "https://box.example",
      wsBase: "wss://box.example",
      credentials: {
        mode: "cookie",
        access: async () => null,
        renew: async () => false,
        csrf: async () => "stale",
        renewCsrf,
      },
      fetch: (input, init) => globalThis.fetch(input, init),
    };
    stubFetch((call) =>
      header(call, "x-armadra-csrf") === "stale"
        ? json(403, { code: "forbidden", message: "csrf" })
        : json(200, { json: { paths: [], file: "" } }),
    );
    await expect(createClient(source).settings.local({})).resolves.toEqual({
      paths: [],
      file: "",
    });
    expect(calls.map((call) => header(call, "x-armadra-csrf"))).toEqual([
      "stale",
      "fresh",
    ]);
    expect(calls[0]?.url).toBe("https://box.example/api/rpc/settings/local");
    expect(renewCsrf).toHaveBeenCalledWith("stale");
  });

  it("Cookie 模式：发出时还没有令牌、途中会话建好了（配对那一刻）——带上新令牌重发一次", async () => {
    let token: string | null = null;
    const source: Source = {
      ...localSource,
      sourceId: "s1",
      httpBase: "https://box.example",
      wsBase: "wss://box.example",
      credentials: {
        mode: "cookie",
        access: async () => null,
        renew: async () => false,
        csrf: async () => token,
        renewCsrf: async () => null,
      },
      fetch: (input, init) => globalThis.fetch(input, init),
    };
    stubFetch((call) => {
      if (header(call, "x-armadra-csrf") === null) {
        // 门拒了这一次；与此同时配对完成，页面手里有了令牌。
        token = "fresh";
        return json(403, { code: "forbidden", message: "CSRF 校验未通过" });
      }
      return json(200, { json: { paths: [], file: "" } });
    });
    await expect(createClient(source).settings.local({})).resolves.toEqual({
      paths: [],
      file: "",
    });
    expect(calls.map((call) => header(call, "x-armadra-csrf"))).toEqual([
      null,
      "fresh",
    ]);
  });

  it("带别的码的 403 已经到过处理器，不重发", async () => {
    const source: Source = {
      ...localSource,
      credentials: {
        mode: "cookie",
        access: async () => null,
        renew: async () => false,
        csrf: async () => "c",
        renewCsrf: async () => "d",
      },
      fetch: (input, init) => globalThis.fetch(input, init),
    };
    stubFetch(() => json(403, { code: "forge_scope", message: "no" }));
    await expect(createClient(source).settings.get({})).rejects.toMatchObject({
      status: 403,
      code: "forge_scope",
    });
    expect(calls).toHaveLength(1);
  });

  it("Bearer 模式：源的 fetch 带密钥，401 换一枚只重发一次", async () => {
    let token = "A";
    const refresh = vi.fn(async () => {
      token = "B";
      return true;
    });
    installLocalTransport({
      origin: "http://127.0.0.1:43120",
      authorization: () => token,
      wsTicket: async () => "T",
      refresh,
    });
    stubFetch((call) =>
      header(call, "authorization") === "Bearer A"
        ? json(401, { code: "unauthenticated", message: "expired" })
        : json(200, { json: {} }),
    );
    await expect(createClient(localSource).settings.get({})).resolves.toEqual(
      {},
    );
    expect(calls.map((call) => header(call, "authorization"))).toEqual([
      "Bearer A",
      "Bearer B",
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    // 重发的是同一份体。
    expect(calls[1]?.init.body).toBe(calls[0]?.init.body);
  });

  it("换不出新密钥就把 401 交出去，不再重发", async () => {
    installLocalTransport({
      origin: "http://127.0.0.1:43120",
      authorization: () => "A",
      wsTicket: async () => "T",
      refresh: async () => false,
    });
    stubFetch(() => json(401, { code: "unauthenticated", message: "no" }));
    await expect(
      createClient(localSource).settings.get({}),
    ).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    expect(calls).toHaveLength(1);
  });
});

describe("失败", () => {
  it("envelope → RuntimeRequestError：状态、码、原话与整份体都在", async () => {
    stubFetch(() =>
      json(409, {
        code: "conflict",
        message: "版本变了",
        requestId: "r1",
        details: { revision: 3 },
      }),
    );
    const error = await createClient(localSource)
      .workspaces.open({ workspaceId: "w" })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RuntimeRequestError);
    expect(error).toMatchObject({
      status: 409,
      code: "conflict",
      coreMessage: "版本变了",
      body: { requestId: "r1", details: { revision: 3 } },
    });
    expect(isConflict(error)).toBe(true);
    expect(isDefinedError(error)).toBe(true);
    expect(isDefinedError(error, "conflict")).toBe(true);
    expect(isDefinedError(error, "not_found")).toBe(false);
  });

  it("连不上是 RuntimeConnectionError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Load failed");
      }),
    );
    await expect(
      createClient(localSource).settings.get({}),
    ).rejects.toBeInstanceOf(RuntimeConnectionError);
  });

  it("isDefinedError：没登记的码、连接失败、普通错误都不算", () => {
    expect(isDefinedError(new RuntimeRequestError(500, "x", "weird"))).toBe(
      false,
    );
    expect(isDefinedError(new RuntimeRequestError(500, "x"))).toBe(false);
    expect(isDefinedError(new RuntimeConnectionError("http://x"))).toBe(false);
    expect(isDefinedError(new Error("x"))).toBe(false);
    expect(isDefinedError(new RuntimeRequestError(404, "x", "not_found"))).toBe(
      true,
    );
  });
});
