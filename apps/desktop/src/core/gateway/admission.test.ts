import type { IncomingHttpHeaders } from "node:http";
import { describe, expect, it } from "vitest";
import { IdentityError } from "../identity/errors";
import type { IdentityService } from "../identity/service";
import {
  WS_TICKET_TTL_MS,
  WsTickets,
  accessCookieName,
  admit,
  anonymousPath,
  bearerToken,
  cookieValue,
  gate,
  impliedOrigin,
  loopbackOnlyPath,
  protocolTicket,
  safeMethod,
} from "./admission";

const HOST = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://armadra.example";

interface Seen {
  accessToken: string;
  requireCsrf: boolean;
  csrfToken: string;
  origin: string;
}

/**
 * 一份只记账的身份服务。这里验的是门自己的判定——哪些请求该带凭据、带哪一份、
 * 要不要 CSRF——而不是 `core/identity` 的认证，那边有自己的用例。
 */
function fake(outcome?: IdentityError): {
  service: IdentityService;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const service = {
    authenticate(request: {
      accessToken: string;
      requireCsrf?: boolean;
      csrfToken?: string;
      origin: string;
    }) {
      seen.push({
        accessToken: request.accessToken,
        requireCsrf: request.requireCsrf === true,
        csrfToken: request.csrfToken ?? "",
        origin: request.origin,
      });
      if (outcome !== undefined) throw outcome;
      return {} as never;
    },
  } as unknown as IdentityService;
  return { service, seen };
}

function context(outcome?: IdentityError) {
  const { service, seen } = fake(outcome);
  return {
    seen,
    value: { origins: new Set([ORIGIN]), service, hostId: HOST },
  };
}

function headers(extra: Record<string, string> = {}): IncomingHttpHeaders {
  return { origin: ORIGIN, ...extra };
}

describe("认证门", () => {
  it("回环专用面在公网这一侧不存在", () => {
    for (const path of ["/hook/abc", "/control/x", "/verify"]) {
      expect(loopbackOnlyPath(path)).toBe(true);
      expect(
        gate({ method: "GET", path, headers: headers() }, context().value),
      ).toMatchObject({ status: 404 });
    }
  });

  it("只接受白名单里的来源，逐字节比规范化之后的拼法", () => {
    const ctx = context().value;
    expect(
      gate({ method: "GET", path: "/api/workspaces", headers: headers() }, ctx),
    ).toMatchObject({ status: 401 });
    expect(
      gate(
        {
          method: "GET",
          path: "/api/workspaces",
          headers: { origin: "https://evil.example" },
        },
        ctx,
      ),
    ).toMatchObject({ status: 403 });
    // 默认端口的另一种拼法规范化之后仍是同一个来源。
    expect(
      gate(
        {
          method: "GET",
          path: "/api/workspaces",
          headers: { origin: `${ORIGIN}:443` },
        },
        ctx,
      ),
    ).toMatchObject({ status: 401 });
  });

  it("API 与升级必须带 Origin，静态请求不必", () => {
    const ctx = context().value;
    expect(
      gate({ method: "GET", path: "/api/workspaces", headers: {} }, ctx),
    ).toMatchObject({ status: 403 });
    expect(
      gate(
        {
          method: "GET",
          path: "/api/workspaces/1/events",
          headers: {},
          upgrade: true,
        },
        ctx,
      ),
    ).toMatchObject({ status: 403 });
    expect(
      gate({ method: "GET", path: "/index.html", headers: {} }, ctx),
    ).toBeUndefined();
  });

  it("Sec-Fetch-Site：发了就必须是同源，没发不放宽", () => {
    const ctx = context().value;
    expect(
      gate(
        {
          method: "GET",
          path: "/api/health",
          headers: headers({ "sec-fetch-site": "cross-site" }),
        },
        ctx,
      ),
    ).toMatchObject({ status: 403 });
    expect(
      gate(
        {
          method: "GET",
          path: "/api/health",
          headers: headers({ "sec-fetch-site": "same-origin" }),
        },
        ctx,
      ),
    ).toBeUndefined();
  });

  it("同源只读请求缺的 Origin 按 Sec-Fetch-Site 与 Host 补，其余不补", () => {
    const origins = new Set(["https://127.0.0.1:8443"]);
    const same = { "sec-fetch-site": "same-origin", host: "127.0.0.1:8443" };
    expect(impliedOrigin("GET", same, origins)).toBe("https://127.0.0.1:8443");
    expect(impliedOrigin("HEAD", same, origins)).toBe("https://127.0.0.1:8443");
    // 写方法、已带 Origin、非浏览器、跨站、Host 不在白名单：都不补。
    expect(impliedOrigin("POST", same, origins)).toBeUndefined();
    expect(
      impliedOrigin("GET", { ...same, origin: "https://x" }, origins),
    ).toBeUndefined();
    expect(
      impliedOrigin("GET", { host: "127.0.0.1:8443" }, origins),
    ).toBeUndefined();
    expect(
      impliedOrigin(
        "GET",
        { ...same, "sec-fetch-site": "cross-site" },
        origins,
      ),
    ).toBeUndefined();
    expect(
      impliedOrigin("GET", { ...same, host: "evil.example" }, origins),
    ).toBeUndefined();
  });

  it("健康检查与身份面不要会话，其余都要", () => {
    const ctx = context();
    for (const path of ["/health", "/api/health", "/api/identity/pair"]) {
      expect(anonymousPath(path)).toBe(true);
      expect(
        gate({ method: "POST", path, headers: headers() }, ctx.value),
      ).toBeUndefined();
    }
    expect(ctx.seen).toHaveLength(0);
  });

  it("写方法要 CSRF，只读方法不要", () => {
    const ctx = context();
    gate(
      {
        method: "GET",
        path: "/api/workspaces",
        headers: headers({ cookie: `${accessCookieName(HOST)}=abc` }),
      },
      ctx.value,
    );
    gate(
      {
        method: "POST",
        path: "/api/workspaces",
        headers: headers({
          cookie: `${accessCookieName(HOST)}=abc`,
          "x-armadra-csrf": "secret",
        }),
      },
      ctx.value,
    );
    expect(ctx.seen[0]).toMatchObject({
      requireCsrf: false,
      accessToken: "abc",
    });
    expect(ctx.seen[1]).toMatchObject({
      requireCsrf: true,
      csrfToken: "secret",
    });
    expect(safeMethod("head")).toBe(true);
    expect(safeMethod("delete")).toBe(false);
  });

  it("认证失败是 401，CSRF 失败是 403", () => {
    const denied = context(new IdentityError("permission"));
    expect(
      gate(
        {
          method: "POST",
          path: "/api/workspaces",
          headers: headers({ cookie: `${accessCookieName(HOST)}=abc` }),
        },
        denied.value,
      ),
    ).toMatchObject({ status: 403 });
    const expired = context(new IdentityError("unauthenticated"));
    expect(
      gate(
        {
          method: "GET",
          path: "/api/workspaces",
          headers: headers({ cookie: `${accessCookieName(HOST)}=abc` }),
        },
        expired.value,
      ),
    ).toMatchObject({ status: 401 });
  });

  it("Cookie 名带 `__Host-` 前缀，同名两条按没有处理", () => {
    const name = accessCookieName(HOST);
    expect(name.startsWith("__Host-armadra_")).toBe(true);
    expect(cookieValue({ cookie: `${name}=one` }, name)).toBe("one");
    expect(cookieValue({ cookie: `${name}=one; ${name}=two` }, name)).toBe("");
    expect(cookieValue({}, name)).toBe("");
  });
});

describe("Bearer 模式（原生 App）", () => {
  const APP = "capacitor://localhost";
  const host = new URL(ORIGIN).host;
  const app = (extra: Record<string, string> = {}): IncomingHttpHeaders => ({
    origin: APP,
    host,
    ...extra,
  });

  it("会话来源是 App 连上的 Gateway 来源，不是 App 自己的；不要 CSRF", () => {
    const { value, seen } = context();
    const admission = admit(
      {
        method: "POST",
        path: "/api/workspaces",
        headers: app({ authorization: "Bearer tok", cookie: "x=y" }),
      },
      value,
    );
    expect(admission.refusal).toBeUndefined();
    expect(admission.bearer).toEqual({ appOrigin: APP });
    expect(admission.origin).toBe(ORIGIN);
    expect(seen).toEqual([
      { accessToken: "tok", requireCsrf: false, csrfToken: "", origin: ORIGIN },
    ]);
  });

  it("只有 capacitor://localhost 与 https://localhost 两个来源走这条", () => {
    const { value } = context();
    for (const origin of ["capacitor://localhost", "https://localhost"]) {
      expect(
        admit(
          {
            method: "GET",
            path: "/api/workspaces",
            headers: { origin, host, authorization: "Bearer t" },
          },
          value,
        ).bearer,
      ).toEqual({ appOrigin: origin });
    }
    expect(
      admit(
        {
          method: "GET",
          path: "/api/workspaces",
          headers: {
            origin: "capacitor://evil",
            host,
            authorization: "Bearer t",
          },
        },
        value,
      ).refusal?.status,
    ).toBe(403);
  });

  it("Host 不在来源白名单里是 403；回环专用面仍是 404", () => {
    const { value } = context();
    expect(
      admit(
        {
          method: "GET",
          path: "/api/workspaces",
          headers: {
            origin: APP,
            host: "attacker.example",
            authorization: "Bearer t",
          },
        },
        value,
      ).refusal?.status,
    ).toBe(403);
    expect(
      admit({ method: "POST", path: "/hook/x", headers: app() }, value).refusal
        ?.status,
    ).toBe(404);
  });

  it("没有 Bearer 是 401，Cookie 不算；预检与身份面不要凭据", () => {
    const { value, seen } = context();
    expect(
      admit(
        {
          method: "GET",
          path: "/api/workspaces",
          headers: app({ cookie: `${accessCookieName(HOST)}=v` }),
        },
        value,
      ).refusal?.status,
    ).toBe(401);
    expect(
      admit(
        { method: "OPTIONS", path: "/api/workspaces", headers: app() },
        value,
      ).refusal,
    ).toBeUndefined();
    expect(
      admit(
        { method: "POST", path: "/api/identity/pair", headers: app() },
        value,
      ).refusal,
    ).toBeUndefined();
    // ws-ticket 在身份面里，但它要会话。
    expect(
      admit(
        { method: "POST", path: "/api/identity/ws-ticket", headers: app() },
        value,
      ).refusal?.status,
    ).toBe(401);
    expect(seen).toEqual([]);
  });

  it("认证失败是 401（不区分 CSRF，Bearer 没有 CSRF）", () => {
    const { value } = context(new IdentityError("permission"));
    expect(
      admit(
        {
          method: "POST",
          path: "/api/workspaces",
          headers: app({ authorization: "Bearer tok" }),
        },
        value,
      ).refusal?.status,
    ).toBe(401);
  });

  it("升级只认 Sec-WebSocket-Protocol 里的一次性票", () => {
    const tickets = new WsTickets();
    const { value, seen } = context();
    const withTickets = { ...value, wsTickets: tickets };
    const { ticket } = tickets.issue({ accessToken: "tok", origin: ORIGIN });
    const upgrade = (protocol?: string) =>
      admit(
        {
          method: "GET",
          path: "/api/workspaces/w/events",
          headers: app(
            protocol === undefined
              ? {}
              : { "sec-websocket-protocol": protocol },
          ),
          upgrade: true,
        },
        withTickets,
      );
    expect(upgrade().refusal?.status).toBe(401);
    expect(upgrade(`armadra-ticket.${ticket}`).refusal).toBeUndefined();
    expect(seen.at(-1)?.accessToken).toBe("tok");
    // 用过就没了。
    expect(upgrade(`armadra-ticket.${ticket}`).refusal?.status).toBe(401);
  });

  it("票 30 秒过期，绑在签票时的会话来源上", () => {
    let now = 1_000;
    const tickets = new WsTickets(() => now);
    const issued = tickets.issue({ accessToken: "a", origin: ORIGIN });
    expect(issued.expiresAtMs).toBe(1_000 + WS_TICKET_TTL_MS);
    now += WS_TICKET_TTL_MS;
    expect(tickets.consume(issued.ticket)).toBeUndefined();
    const fresh = tickets.issue({ accessToken: "b", origin: ORIGIN });
    expect(tickets.consume(fresh.ticket)).toEqual({
      accessToken: "b",
      origin: ORIGIN,
    });
  });

  it("头的解析：重复或不合规的一律按没有", () => {
    expect(bearerToken({ authorization: "Bearer abc" })).toBe("abc");
    expect(bearerToken({ authorization: "Basic abc" })).toBe("");
    expect(bearerToken({ authorization: "Bearer a,b" })).toBe("");
    expect(
      protocolTicket({ "sec-websocket-protocol": "x, armadra-ticket.t1" }),
    ).toBe("t1");
    expect(
      protocolTicket({
        "sec-websocket-protocol": "armadra-ticket.a, armadra-ticket.b",
      }),
    ).toBe("");
  });
});
