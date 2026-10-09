import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { candidateRoutes, pickRoute, probeDirect } from "./routing";
import type {
  CredentialProvider,
  SourceAccess,
  SourceDescriptor,
  Via,
} from "./types";

const ID = "a".repeat(32);
const DIRECT = "https://192.168.1.20:8443";
const RELAY = "https://relay.example";

const descriptor = (
  overrides: Partial<SourceDescriptor> = {},
): SourceDescriptor => ({
  sourceId: ID,
  kind: "relayed",
  label: "",
  baseUrl: DIRECT,
  relayOrigin: RELAY,
  cloudIssuer: "https://relay.example",
  fingerprint: "",
  orderIndex: 1,
  ...overrides,
});

const accessFor = (via: Via): SourceAccess => ({
  accessToken: `token-${via}`,
  expiresAtMs: 0,
  httpBase: via === "direct" ? DIRECT : `${RELAY}/s/${ID}`,
  wsBase:
    via === "direct"
      ? DIRECT.replace("https", "wss")
      : `wss://relay.example/s/${ID}`,
  ...(via === "relayed" ? { relayToken: "RT" } : {}),
});

function provider(
  fail: Partial<Record<Via, boolean>> = {},
): CredentialProvider & { asked: Via[] } {
  const asked: Via[] = [];
  return {
    asked,
    getAccess: vi.fn(async (_id: string, via: Via) => {
      asked.push(via);
      if (fail[via])
        throw Object.assign(new Error("no"), { code: "source_unauthorized" });
      return accessFor(via);
    }),
    refresh: vi.fn(async (_id: string, via: Via) => accessFor(via)),
    invalidate: vi.fn(),
  };
}

/** 一台假的直连 Gateway：`hello` 答 `hostId`，或者不答。 */
function gateway(answer: "ok" | "other" | "hang" | "down") {
  return vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        if (answer === "down") return reject(new TypeError("refused"));
        if (answer === "hang") {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
          return;
        }
        resolve(
          new Response(
            JSON.stringify({ hostId: answer === "ok" ? ID : "b".repeat(32) }),
            { status: 200 },
          ),
        );
      }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("probeDirect", () => {
  it("问匿名 hello，不带凭据；hostId 对得上才算通", async () => {
    const fetch = gateway("ok");
    await expect(probeDirect(DIRECT, ID, { fetch })).resolves.toBe(true);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${DIRECT}/api/identity/hello`);
    expect(init?.credentials).toBe("omit");
    await expect(
      probeDirect(DIRECT, ID, { fetch: gateway("other") }),
    ).resolves.toBe(false);
    await expect(
      probeDirect(DIRECT, ID, { fetch: gateway("down") }),
    ).resolves.toBe(false);
    await expect(probeDirect("", ID, { fetch })).resolves.toBe(false);
  });

  it("1.5 秒不答就当不通", async () => {
    const answer = probeDirect(DIRECT, ID, { fetch: gateway("hang") });
    await vi.advanceTimersByTimeAsync(1499);
    let settled = false;
    void answer.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toBe(false);
  });
});

describe("pickRoute（D27：直连优先）", () => {
  it("直连通：走直连；中继同时问过", async () => {
    const credentials = provider();
    const route = await pickRoute(descriptor(), credentials, {
      fetch: gateway("ok"),
    });
    expect(route.via).toBe("direct");
    expect(route.access.accessToken).toBe("token-direct");
    expect(credentials.asked).toEqual(["relayed", "direct"]);
  });

  it("直连超时：走中继", async () => {
    const credentials = provider();
    const route = pickRoute(descriptor(), credentials, {
      fetch: gateway("hang"),
    });
    await vi.advanceTimersByTimeAsync(1500);
    await expect(route).resolves.toMatchObject({
      via: "relayed",
      access: { relayToken: "RT" },
    });
  });

  it("直连答的不是这个源（hostId 不符）：走中继", async () => {
    const route = await pickRoute(descriptor(), provider(), {
      fetch: gateway("other"),
    });
    expect(route.via).toBe("relayed");
  });

  it("直连通但换不到直连的票：退回中继", async () => {
    const route = await pickRoute(descriptor(), provider({ direct: true }), {
      fetch: gateway("ok"),
    });
    expect(route.via).toBe("relayed");
  });

  it("两条都不通：带着中继的失败码抛", async () => {
    await expect(
      pickRoute(descriptor(), provider({ relayed: true }), {
        fetch: gateway("down"),
      }),
    ).rejects.toMatchObject({ code: "source_unauthorized" });
    await expect(
      pickRoute(descriptor({ baseUrl: "", relayOrigin: "" }), provider()),
    ).rejects.toMatchObject({ code: "source_unreachable" });
  });

  it("只有直连一条路（自托管）：不探，直接换票", async () => {
    const fetch = gateway("down");
    const route = await pickRoute(
      descriptor({ kind: "direct", relayOrigin: RELAY }),
      provider(),
      { fetch },
    );
    expect(route.via).toBe("direct");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("没有直连地址：只走中继，不探", async () => {
    const fetch = gateway("ok");
    const route = await pickRoute(descriptor({ baseUrl: "" }), provider(), {
      fetch,
    });
    expect(route.via).toBe("relayed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("候选路线", () => {
    expect(candidateRoutes(descriptor({ kind: "local" }))).toEqual(["local"]);
    expect(candidateRoutes(descriptor())).toEqual(["direct", "relayed"]);
    expect(candidateRoutes(descriptor({ kind: "direct" }))).toEqual(["direct"]);
    expect(
      candidateRoutes(descriptor({ kind: "hosted", baseUrl: "" })),
    ).toEqual(["relayed"]);
  });
});

describe("一源多路（§55）", () => {
  const LAN = "https://192.168.0.107:8443";
  const relayRoute = (origin: string, preferred: boolean, lastOkAtMs = 0) => ({
    via: "relayed" as const,
    origin,
    cloudIssuer: origin,
    fingerprint: "",
    preferred,
    lastOkAtMs,
  });
  const twoRelays = descriptor({
    baseUrl: "",
    routes: [relayRoute(LAN, false, 5), relayRoute(RELAY, true)],
  });

  function byOrigin(down: string[], selectsRelay = false) {
    const asked: (string | undefined)[] = [];
    const credentials: CredentialProvider = {
      getAccess: vi.fn(async (_id: string, via: Via, origin?: string) => {
        asked.push(origin);
        if (origin !== undefined && down.includes(origin))
          throw Object.assign(new Error("no"), { code: "source_unreachable" });
        return { ...accessFor(via), httpBase: `${origin ?? "core"}/s/${ID}` };
      }),
      refresh: vi.fn(async (_id: string, via: Via) => accessFor(via)),
      invalidate: vi.fn(),
      ...(selectsRelay ? { selectsRelay: true } : {}),
    };
    return { credentials, asked };
  }

  it("中继按首选、再按最近成功逐条试，第一条成的用，记下是哪一条", async () => {
    const { credentials, asked } = byOrigin([RELAY]);
    const route = await pickRoute(twoRelays, credentials);
    expect(asked).toEqual([RELAY, LAN]);
    expect(route).toMatchObject({ via: "relayed", origin: LAN });
    expect(candidateRoutes(twoRelays)).toEqual(["relayed"]);
  });

  it("全不成：抛首选那条的失败", async () => {
    const { credentials } = byOrigin([RELAY, LAN]);
    await expect(pickRoute(twoRelays, credentials)).rejects.toMatchObject({
      code: "source_unreachable",
    });
  });

  it("凭据来源自己选中继（桌面）：只问一次，不带来源", async () => {
    const { credentials, asked } = byOrigin([], true);
    const route = await pickRoute(twoRelays, credentials);
    expect(asked).toEqual([undefined]);
    expect(route.origin).toBeUndefined();
  });

  it("旧描述没有 routes：由镜像字段推出，行为与之前一样", async () => {
    const legacy = descriptor({ baseUrl: "" });
    const { credentials, asked } = byOrigin([]);
    await expect(pickRoute(legacy, credentials)).resolves.toMatchObject({
      via: "relayed",
    });
    expect(asked).toEqual([undefined]);
  });
});
