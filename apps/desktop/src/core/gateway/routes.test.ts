import { describe, expect, it } from "vitest";
import { type CoreRequest, emptyRequest } from "../http/router";
import type { CoreContext } from "../main";
import { GatewayDomain } from "./index";
import type { Gateway } from "./listener";
import {
  parseConfig,
  postPairing,
  postPairingCodeExchange,
  putGateway,
} from "./routes";

const noExchange = () => ({ status: 500 });

function request(body: unknown): CoreRequest {
  const encoded = Buffer.from(
    typeof body === "string" ? body : JSON.stringify(body),
    "utf8",
  );
  return {
    ...emptyRequest("PUT", "/api/gateway"),
    body: encoded,
    json: <T>() => JSON.parse(encoded.toString("utf8")) as T,
  };
}

describe("PUT /api/gateway 的请求体", () => {
  it("只收 gateway.* 的子集，未给的键不出现在补丁里", () => {
    expect(
      parseConfig(
        request({
          enabled: true,
          listen: "private",
          port: 8443,
          publicOrigin: "https://armadra.example",
          tls: { source: "file", certFile: "/c.pem", keyFile: "/k.pem" },
        }),
      ),
    ).toEqual({
      patch: {
        enabled: true,
        listen: "private",
        port: 8443,
        publicOrigin: "https://armadra.example",
        tls: { source: "file", certFile: "/c.pem", keyFile: "/k.pem" },
      },
    });
    expect(parseConfig(request({ enabled: false }))).toEqual({
      patch: { enabled: false },
    });
    expect(parseConfig(request({ publicOrigin: "" }))).toEqual({
      patch: { publicOrigin: "" },
    });
  });

  it("值错了是 400，不让规范化悄悄退回缺省", () => {
    for (const body of [
      "not json",
      [],
      { enabled: "yes" },
      { listen: "public" },
      { port: -1 },
      { port: 1.5 },
      { publicOrigin: "http://armadra.example" },
      { publicOrigin: "https://armadra.example/path" },
      { tls: { source: "magic" } },
      { tls: { certFile: 7 } },
      { tls: { password: "x" } },
      { other: 1 },
    ]) {
      const answer = parseConfig(request(body));
      expect("status" in answer && answer.status, JSON.stringify(body)).toBe(
        400,
      );
    }
  });
});

describe("服务器壳托管的 Gateway", () => {
  const context = {} as CoreContext;
  const fakeGateway = {
    address: { host: "127.0.0.1", port: 9443 },
    origin: () => "https://127.0.0.1:9443",
    origins: () => ["https://127.0.0.1:9443"],
    tls: () => ({
      source: "selfSigned",
      fingerprint: "f".repeat(64),
      subject: "CN=127.0.0.1",
      names: ["127.0.0.1"],
      notAfter: "Oct  3 00:00:00 2027 GMT",
      anchor: "pem",
    }),
    pair: () => {
      throw new Error("not used");
    },
  } as unknown as Gateway;

  it("改配置答 409，状态报 shell", async () => {
    const domain = new GatewayDomain(context);
    domain.adopt(fakeGateway);
    const deps = {
      status: () => domain.status(),
      configure: (patch: Record<string, never>) => domain.configure(patch),
      pair: (input: { origin?: string }) => domain.pair(input),
      exchangeCode: noExchange,
    };
    const answer = await putGateway(deps, request({ enabled: false }));
    expect(answer.status).toBe(409);
    expect((answer.body as { code: string }).code).toBe(
      "gateway_managed_by_shell",
    );
    const status = domain.status();
    expect(status.managedBy).toBe("shell");
    expect(status.running).toBe(true);
    expect((status.address as { port: number }).port).toBe(9443);
  });

  it("没在运行时铸票答 409", () => {
    const domain = new GatewayDomain(context);
    const answer = postPairing(
      {
        status: () => ({}),
        configure: async () => undefined,
        pair: (input) => domain.pair(input),
        exchangeCode: noExchange,
      },
      request({}),
    );
    expect(answer.status).toBe(409);
    expect((answer.body as { code: string }).code).toBe("gateway_not_running");
  });

  it("铸票的请求体：deviceName 限长、origin 必须是字符串", () => {
    const deps = {
      status: () => ({}),
      configure: async () => undefined,
      pair: () => ({ ok: true }),
      exchangeCode: noExchange,
    };
    expect(postPairing(deps, request({ deviceName: "" })).status).toBe(400);
    expect(
      postPairing(deps, request({ deviceName: "x".repeat(65) })).status,
    ).toBe(400);
    expect(postPairing(deps, request({ origin: 1 })).status).toBe(400);
    expect(postPairing(deps, request({ deviceName: "手机" })).status).toBe(200);
  });
});

describe("POST /api/gateway/pairing-code/exchange 的请求体", () => {
  it("只收 code，带上来源地址与 Origin 交给域", () => {
    const seen: unknown[] = [];
    const deps = {
      status: () => ({}),
      configure: async () => undefined,
      pair: () => ({}),
      exchangeCode: (input: unknown) => {
        seen.push(input);
        return { status: 200, body: {} };
      },
    };
    const withOrigin = (body: unknown): CoreRequest => {
      const base = request(body);
      return {
        ...base,
        headers: { ...base.headers, origin: "https://192.168.1.20:8443" },
        raw: {
          socket: { remoteAddress: "::ffff:192.168.1.30" },
        } as unknown as CoreRequest["raw"],
      };
    };
    expect(
      postPairingCodeExchange(deps, withOrigin({ code: "3f7k-9q2m" })).status,
    ).toBe(200);
    expect(seen[0]).toMatchObject({
      code: "3f7k-9q2m",
      origin: "https://192.168.1.20:8443",
      remoteIp: "192.168.1.30",
    });
    for (const body of [
      "not json",
      [],
      {},
      { code: 7 },
      { code: "x".repeat(33) },
      { code: "ABCD1234", extra: true },
    ]) {
      expect(
        postPairingCodeExchange(deps, request(body)).status,
        JSON.stringify(body),
      ).toBe(400);
    }
    expect(seen).toHaveLength(1);
  });
});

describe("配对短码的档位（Gateway 域）", () => {
  const issued = {
    ticket: `${"a".repeat(32)}.${"b".repeat(43)}`,
    expiresAtMs: Date.now() + 120_000,
    origin: "https://192.168.1.20:8443",
    fingerprint: "f".repeat(64),
    webUrl: "https://192.168.1.20:8443/#pair=x",
    deepLink: "armadra://pair?host=x&ticket=x&fp=x",
  };
  const gatewayOn = (mode: string, publicOrigins: string[] = []) =>
    ({
      address: { host: "0.0.0.0", port: 8443 },
      mode,
      publicOrigins,
      pair: () => issued,
    }) as unknown as Gateway;

  it("私网档：配对载荷带 XXXX-XXXX 的短码", () => {
    const domain = new GatewayDomain({} as CoreContext);
    domain.adopt(gatewayOn("private"));
    const payload = domain.pair({}) as Record<string, unknown>;
    expect(payload.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(payload.ticket).toBe(issued.ticket);
  });

  it("公网 all 档与配了对外来源：不签短码，兑换答 403", () => {
    for (const gateway of [
      gatewayOn("all"),
      gatewayOn("private", ["https://armadra.example"]),
    ]) {
      const domain = new GatewayDomain({} as CoreContext);
      domain.adopt(gateway);
      expect((domain.pair({}) as Record<string, unknown>).code).toBeNull();
      const answer = domain.exchangeCode({
        code: "AAAAAAAA",
        remoteIp: "203.0.113.9",
        origin: issued.origin,
      });
      expect(answer.status).toBe(403);
      expect((answer.body as { code: string }).code).toBe(
        "pairing_code_disabled",
      );
    }
  });

  it("没在运行时答 409", () => {
    const domain = new GatewayDomain({} as CoreContext);
    expect(
      domain.exchangeCode({ code: "AAAAAAAA", remoteIp: "", origin: undefined })
        .status,
    ).toBe(409);
  });
});
