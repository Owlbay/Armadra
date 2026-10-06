import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { resolveTls, type TlsMaterial } from "../gateway/tls";
import { CoreFailure } from "../http/errors";
import { tempDir } from "../testing/temp-dir";
import {
  forgetAnchors,
  networkTransport,
  normalizeFingerprint,
  presentedAnchor,
  normalizeOrigin,
} from "./http-client";

/**
 * 真 TLS 下的指纹钉扎：本地 CA（与 Gateway `localCa`、个人中转自签同一种）签的
 * 叶证书，信任锚在链里或只在 `/ca.crt`；指纹不对、或拿公开的 CA 配别人的叶证书
 * 冒充，都是 `fingerprint_mismatch`。
 */

const servers: Server[] = [];

afterEach(async () => {
  forgetAnchors();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});

function material(): TlsMaterial {
  return resolveTls({
    dataDir: tempDir("armadra-pin-"),
    hosts: ["127.0.0.1", "localhost"],
    generated: "localCa",
  });
}

async function serve(
  cert: string,
  key: string,
  anchor: string,
): Promise<string> {
  const server = createServer({ cert, key }, (request, response) => {
    if (request.url === "/ca.crt") {
      response.writeHead(200, { "content-type": "application/x-x509-ca-cert" });
      response.end(anchor);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, path: request.url }));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function code(work: Promise<unknown>): Promise<string> {
  return work.then(
    () => "resolved",
    (error: unknown) =>
      error instanceof CoreFailure ? error.code : String(error),
  );
}

const get = (origin: string, fingerprint: string) =>
  networkTransport({
    method: "GET",
    url: `${origin}/hello`,
    fingerprint,
    timeoutMs: 5_000,
  });

describe("指纹钉扎", () => {
  it("服务端只发叶证书：从 /ca.crt 取信任锚，指纹对上就通", async () => {
    const tls = material();
    const origin = await serve(tls.cert, tls.key, tls.anchor ?? "");
    const answer = await get(origin, tls.fingerprint);
    expect(answer).toEqual({ status: 200, body: { ok: true, path: "/hello" } });
  });

  it("链里带着 CA：直接在链里认出信任锚", async () => {
    const tls = material();
    const origin = await serve(`${tls.cert}\n${tls.anchor}`, tls.key, "");
    expect((await get(origin, tls.fingerprint)).status).toBe(200);
  });

  it("指纹不对 → fingerprint_mismatch", async () => {
    const tls = material();
    const origin = await serve(tls.cert, tls.key, tls.anchor ?? "");
    expect(await code(get(origin, "0".repeat(64)))).toBe(
      "fingerprint_mismatch",
    );
  });

  it("拿公开的 CA 配别人的叶证书冒充 → fingerprint_mismatch", async () => {
    const real = material();
    const forged = material();
    // 冒充者的叶证书 + 真 CA（CA 证书是公开的），钉的是真 CA 的指纹。
    const origin = await serve(
      `${forged.cert}\n${real.anchor}`,
      forged.key,
      real.anchor ?? "",
    );
    expect(await code(get(origin, real.fingerprint))).toBe(
      "fingerprint_mismatch",
    );
  });

  it("不给指纹就用系统信任：自签证书连不上", async () => {
    const tls = material();
    const origin = await serve(tls.cert, tls.key, tls.anchor ?? "");
    expect(await code(get(origin, ""))).toBe("source_unreachable");
  });

  it("没人监听 → source_unreachable", async () => {
    expect(await code(get("https://127.0.0.1:1", "a".repeat(64)))).toBe(
      "source_unreachable",
    );
  });
});

describe("首次添加：问出对端的信任锚给人核对", () => {
  it("只发叶证书：答 /ca.crt 里签了它的那张的指纹", async () => {
    const tls = material();
    const origin = await serve(tls.cert, tls.key, tls.anchor ?? "");
    expect(await presentedAnchor(origin, 5_000)).toBe(tls.fingerprint);
  });

  it("链里带着 CA：答链里最末那张", async () => {
    const tls = material();
    const origin = await serve(
      `${tls.cert}${tls.anchor ?? ""}`,
      tls.key,
      tls.anchor ?? "",
    );
    expect(await presentedAnchor(origin, 5_000)).toBe(tls.fingerprint);
  });

  it("http 回环不需要指纹；没人监听 → source_unreachable", async () => {
    expect(await presentedAnchor("http://127.0.0.1:1", 1_000)).toBeNull();
    expect(await code(presentedAnchor("https://127.0.0.1:1", 1_000))).toBe(
      "source_unreachable",
    );
  });
});

describe("地址与指纹的规范拼法", () => {
  it("来源：https，或回环上的 http；不带账号与路径", () => {
    expect(normalizeOrigin("https://Relay.Example.com:8102/app/")).toBe(
      "https://relay.example.com:8102",
    );
    expect(normalizeOrigin("http://127.0.0.1:8102")).toBe(
      "http://127.0.0.1:8102",
    );
    for (const bad of [
      "http://192.168.1.2",
      "ftp://x",
      "https://user:pw@x.test",
      "not a url",
    ]) {
      expect(() => normalizeOrigin(bad), bad).toThrow(CoreFailure);
    }
  });

  it("指纹：带冒号与大写的写法归一；长度不对拒绝", () => {
    const colon = "AB:".repeat(31) + "AB";
    expect(normalizeFingerprint(colon)).toBe("ab".repeat(32));
    expect(normalizeFingerprint(undefined)).toBe("");
    expect(() => normalizeFingerprint("abc")).toThrow(CoreFailure);
  });
});
