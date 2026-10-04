/**
 * `openGateway` 带着 ACME 管理器时，`tls-alpn-01` 的验证握手打在 Gateway 自己
 * 的 TLS 端口上（`./alpn.ts`）；挑战挂着的那段时间里页面与接口照常。只在回环
 * 上监听。
 */

import { request as httpsRequest } from "node:https";
import { dirname, resolve } from "node:path";
import { connect as tlsConnect, createSecureContext } from "node:tls";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type RunningCore, run } from "../main";
import { tempDir } from "../testing/temp-dir";
import { ACME_TLS_PROTOCOL, type AcmeTlsResponder } from "./alpn";
import { type Gateway, openGateway } from "./listener";
import { acmeChallengeCertificate } from "./tls";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");

let core: RunningCore;
let gateway: Gateway;
let pending = true;

const keyAuthorization = "token-3.thumbprint";
const challenge = createSecureContext(
  acmeChallengeCertificate("armadra.test", keyAuthorization, new Date()),
);
const responder: AcmeTlsResponder = {
  pending: () => pending,
  context: (name) => (name === "armadra.test" ? challenge : undefined),
};

beforeAll(async () => {
  core = await run({
    argv: [
      "--listen",
      "tcp:127.0.0.1:0",
      "--data-dir",
      tempDir("armadra-gateway-acme-"),
    ],
    env: {
      ARMADRA_CORE: "ts",
      ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir,
      ARMADRA_LOG: "error",
    },
    stdout: () => {},
  });
  gateway = await openGateway(core, {
    listen: { host: "127.0.0.1", port: 0 },
    publicOrigins: [],
    hosts: () => ["127.0.0.1"],
    tls: { generated: "selfSigned" },
    acme: responder,
    deviceName: "test",
  });
}, 60_000);

afterAll(async () => {
  await gateway?.close();
  await core?.stop();
});

function handshake(
  servername: string,
): Promise<{ protocol: string | false | null; san: string | undefined }> {
  return new Promise((done, failed) => {
    const socket = tlsConnect(
      {
        host: "127.0.0.1",
        port: gateway.address.port,
        servername,
        ALPNProtocols: [ACME_TLS_PROTOCOL],
        rejectUnauthorized: false,
      },
      () => {
        const answer = {
          protocol: socket.alpnProtocol,
          san: socket.getPeerCertificate().subjectaltname,
        };
        socket.destroy();
        done(answer);
      },
    );
    socket.on("error", failed);
  });
}

function health(): Promise<number> {
  return new Promise((done, failed) => {
    const client = httpsRequest(
      {
        host: "127.0.0.1",
        port: gateway.address.port,
        path: "/health",
        rejectUnauthorized: false,
        agent: false,
      },
      (response) => {
        response.resume();
        done(response.statusCode ?? 0);
      },
    );
    client.on("error", failed);
    client.end();
  });
}

describe("Gateway 监听上的 tls-alpn-01", () => {
  it("挑战挂着：验证握手拿到挑战证书，健康检查照常 200", async () => {
    pending = true;
    const answer = await handshake("armadra.test");
    expect(answer.protocol).toBe(ACME_TLS_PROTOCOL);
    expect(answer.san).toBe("DNS:armadra.test");
    await expect(handshake("other.test")).rejects.toThrow();
    expect(await health()).toBe(200);
  });

  it("没有挑战：连接不经检查直接进 TLS", async () => {
    pending = false;
    await expect(handshake("armadra.test")).rejects.toThrow(
      /no application protocol/,
    );
    expect(await health()).toBe(200);
  });
});
