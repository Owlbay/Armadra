import { describe, expect, it } from "vitest";
import { type CoreRequest, emptyRequest } from "../http/router";
import type { CoreContext } from "../main";
import { GatewayDomain } from "./index";
import type { Gateway } from "./listener";
import { parseConfig, postPairing, putGateway } from "./routes";

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
    };
    expect(postPairing(deps, request({ deviceName: "" })).status).toBe(400);
    expect(
      postPairing(deps, request({ deviceName: "x".repeat(65) })).status,
    ).toBe(400);
    expect(postPairing(deps, request({ origin: 1 })).status).toBe(400);
    expect(postPairing(deps, request({ deviceName: "手机" })).status).toBe(200);
  });
});
