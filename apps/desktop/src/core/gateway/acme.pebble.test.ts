/**
 * ACME 对着 dev-stack 的 Pebble 真签（外部服务 §6.3 / §14）。
 *
 * 只在 `ARMADRA_DEV_STACK=1` 且 Pebble 在跑时执行（`pnpm dev-stack up pebble`），
 * 否则整份 skipped：CI 的单测行不起容器。Pebble 的 `PEBBLE_VA_ALWAYS_VALID=1`
 * 不回连挑战地址，所以这里验的是 RFC 8555 的整条往返——账户、订单（带
 * `profile`）、授权、挑战、定稿、取证书——以及续期换证书、证书链能验到 Pebble
 * 这次运行的根；挑战监听本身由 `acme.test.ts` 覆盖。
 *
 * 目录服务器的 TLS 证书由 Pebble 镜像里的 minica 根签，用 `docker compose cp`
 * 取出来当 `ARMADRA_ACME_CA_BUNDLE`；签出来的证书链到 Pebble 每次启动现生成的
 * 根，从管理端口 `GET /roots/0` 取。只连回环。
 *
 * 第二组对着 profile `pebble-va`（`pnpm dev-stack up pebble-va --profile
 * pebble-va`）：那一份 Pebble 真去回连挑战地址——`tls-alpn-01` 打
 * `host.docker.internal:5001`、`http-01` 打 `:5002`，容器经宿主转发落到本机
 * 回环上的监听（用例只绑 127.0.0.1）。Linux 上宿主回环对容器不通，那里整组
 * skipped。
 */

import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  createServer as createHttpsServer,
  request as httpsRequest,
} from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { tempDir } from "../testing/temp-dir";
import { AcmeManager, acmeConfigFrom } from "./acme";
import { interceptAcmeTls } from "./alpn";
import { pemBlocks, resolveTls } from "./tls";

const here = dirname(fileURLToPath(import.meta.url));
const stack = resolve(here, "../../../../../tools/dev-stack");
const enabled = process.env.ARMADRA_DEV_STACK === "1";
const silent = { debug() {}, info() {}, warn() {}, error() {} };

function compose(args: string[]) {
  const command = [
    "compose",
    "--project-directory",
    stack,
    "-f",
    join(stack, "docker-compose.yml"),
  ];
  const envFile = join(stack, ".data/dev.env");
  if (existsSync(envFile)) command.push("--env-file", envFile);
  return spawnSync("docker", [...command, ...args], { encoding: "utf8" });
}

/** Pebble 在跑就取出 minica 根的路径，不在跑返回 `undefined`。 */
function pebbleRoot(directory: string, service = "pebble"): string | undefined {
  if (!enabled) return undefined;
  const running = compose([
    ...(service === "pebble" ? [] : ["--profile", service]),
    "ps",
    "-q",
    service,
  ]);
  if (running.status !== 0 || running.stdout.trim() === "") return undefined;
  const target = join(directory, `${service}.minica.pem`);
  const copied = compose([
    ...(service === "pebble" ? [] : ["--profile", service]),
    "cp",
    `${service}:/test/certs/pebble.minica.pem`,
    target,
  ]);
  return copied.status === 0 ? target : undefined;
}

function get(url: string, ca: string): Promise<string> {
  return new Promise((done, failed) => {
    const client = httpsRequest(url, { ca }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    });
    client.on("error", failed);
    client.end();
  });
}

const scratch = enabled ? tempDir("armadra-acme-pebble-") : "";
const minica = pebbleRoot(scratch);

describe.skipIf(minica === undefined)("ACME 对 Pebble", () => {
  it("签发 shortlived 证书、链到 Pebble 的根，续期换一张新的", async () => {
    const dataDir = tempDir("armadra-acme-pebble-data-");
    const config = acmeConfigFrom({
      email: "dev@armadra.test",
      publicOrigins: ["https://armadra.test:8443"],
      env: {
        ARMADRA_ACME_DIRECTORY: "https://127.0.0.1:14000/dir",
        ARMADRA_ACME_CA_BUNDLE: minica,
        ARMADRA_ACME_PROFILE: "shortlived",
        ARMADRA_ACME_HTTP_PORT: "0",
        ARMADRA_ACME_HTTP_HOST: "127.0.0.1",
      },
    });
    const manager = new AcmeManager(dataDir, config, { log: silent });
    await manager.start();
    try {
      const material = resolveTls({ dataDir, hosts: [], generated: "acme" });
      expect(material.source).toBe("acme");
      expect(material.names).toEqual(["armadra.test"]);
      const leaf = new X509Certificate(material.cert);
      // Pebble 的 shortlived profile：6 天。
      const days =
        (new Date(leaf.validTo).getTime() -
          new Date(leaf.validFrom).getTime()) /
        86_400_000;
      expect(Math.round(days)).toBe(6);

      // 链：叶 → 中间 CA → Pebble 这次运行的根。
      const chain = pemBlocks(material.cert).map(
        (pem) => new X509Certificate(pem),
      );
      expect(chain.length).toBeGreaterThanOrEqual(2);
      const root = new X509Certificate(
        await get(
          "https://127.0.0.1:15000/roots/0",
          readFileSync(minica as string, "utf8"),
        ),
      );
      const last = chain[chain.length - 1] as X509Certificate;
      expect(last.verify(root.publicKey)).toBe(true);
      for (let index = 0; index + 1 < chain.length; index += 1) {
        expect(
          (chain[index] as X509Certificate).verify(
            (chain[index + 1] as X509Certificate).publicKey,
          ),
        ).toBe(true);
      }

      const status = manager.status();
      expect(status.profile).toBe("shortlived");
      expect(status.failures).toBe(0);
      // 6 天的证书在第 4 天续。
      const renewAt = new Date(status.renewAt as string).getTime();
      const due =
        new Date(leaf.validFrom).getTime() +
        ((new Date(leaf.validTo).getTime() -
          new Date(leaf.validFrom).getTime()) *
          2) /
          3;
      expect(Math.abs(renewAt - due)).toBeLessThan(1000);

      let swapped = 0;
      manager.onRenewed(() => {
        swapped += 1;
      });
      expect(await manager.renew()).toBe(true);
      expect(swapped).toBe(1);
      const renewed = resolveTls({ dataDir, hosts: [], generated: "acme" });
      expect(renewed.fingerprint).not.toBe(material.fingerprint);
    } finally {
      await manager.close();
    }
  }, 120_000);

  it("目录地址不对：起不来，原因是 acme_failed", async () => {
    const dataDir = tempDir("armadra-acme-pebble-bad-");
    const config = acmeConfigFrom({
      email: "dev@armadra.test",
      publicOrigins: ["https://armadra.test"],
      env: {
        ARMADRA_ACME_DIRECTORY: "https://127.0.0.1:14000/no-such-directory",
        ARMADRA_ACME_CA_BUNDLE: minica,
        ARMADRA_ACME_HTTP_PORT: "0",
        ARMADRA_ACME_HTTP_HOST: "127.0.0.1",
      },
    });
    const manager = new AcmeManager(dataDir, config, { log: silent });
    await expect(manager.start()).rejects.toMatchObject({
      code: "acme_failed",
    });
  }, 120_000);
});

const validating =
  process.platform === "linux" ? undefined : pebbleRoot(scratch, "pebble-va");
/** Pebble 回连的名字：容器里解析到宿主。 */
const HOST_NAME = "host.docker.internal";
/** pebble-va 默认配置里的挑战端口。 */
const TLS_ALPN_PORT = 5001;
const HTTP_PORT = 5002;

function validatingConfig(challenge: "tls-alpn-01" | "http-01") {
  return acmeConfigFrom({
    email: "dev@armadra.test",
    publicOrigins: [`https://${HOST_NAME}:${TLS_ALPN_PORT}`],
    env: {
      ARMADRA_ACME_DIRECTORY: "https://127.0.0.1:14100/dir",
      ARMADRA_ACME_CA_BUNDLE: validating,
      ARMADRA_ACME_PROFILE: "shortlived",
      ARMADRA_ACME_CHALLENGE: challenge,
      ARMADRA_ACME_HTTP_PORT: String(HTTP_PORT),
      ARMADRA_ACME_HTTP_HOST: "127.0.0.1",
    },
    tlsListen: { host: "127.0.0.1", port: TLS_ALPN_PORT },
  });
}

describe.skipIf(validating === undefined)("ACME 对真验证的 Pebble", () => {
  it("tls-alpn-01：首签走临时监听，续期走 Gateway 的监听；不答挑战就签不出来", async () => {
    const dataDir = tempDir("armadra-acme-pebble-alpn-");
    const manager = new AcmeManager(dataDir, validatingConfig("tls-alpn-01"), {
      log: silent,
    });
    await manager.start();
    const gateway = createHttpsServer(
      resolveTls({ dataDir, hosts: [], generated: "acme" }),
      (_request, response) => response.end("page"),
    );
    try {
      const material = resolveTls({ dataDir, hosts: [], generated: "acme" });
      expect(material.names).toEqual([HOST_NAME]);
      expect(manager.status().challenge).toBe("tls-alpn-01");
      expect(manager.httpPort()).toBeUndefined();
      const leaf = new X509Certificate(material.cert);
      const root = new X509Certificate(
        await get(
          "https://127.0.0.1:15100/roots/0",
          readFileSync(validating as string, "utf8"),
        ),
      );
      const chain = pemBlocks(material.cert).map(
        (pem) => new X509Certificate(pem),
      );
      expect(
        (chain[chain.length - 1] as X509Certificate).verify(root.publicKey),
      ).toBe(true);

      // 续期：Pebble 的验证握手打到 Gateway 的 TLS 监听上。
      interceptAcmeTls(gateway, manager);
      await new Promise<void>((done) =>
        gateway.listen(TLS_ALPN_PORT, "127.0.0.1", done),
      );
      expect(await manager.renew()).toBe(true);
      const renewed = resolveTls({ dataDir, hosts: [], generated: "acme" });
      expect(renewed.fingerprint).not.toBe(material.fingerprint);
      expect(new X509Certificate(renewed.cert).serialNumber).not.toBe(
        leaf.serialNumber,
      );
    } finally {
      await new Promise<void>((done) => {
        gateway.close(() => done());
        gateway.closeAllConnections();
      });
      await manager.close();
    }

    // 对照：同一个端口上的 TLS 监听不答挑战，Pebble 验不过。
    const plain = createHttpsServer(
      resolveTls({ dataDir, hosts: [], generated: "acme" }),
    );
    await new Promise<void>((done) =>
      plain.listen(TLS_ALPN_PORT, "127.0.0.1", done),
    );
    const refused = new AcmeManager(
      tempDir("armadra-acme-pebble-alpn-refused-"),
      validatingConfig("tls-alpn-01"),
      { log: silent, listen: false },
    );
    try {
      await expect(refused.start()).rejects.toMatchObject({
        code: "acme_failed",
      });
    } finally {
      await new Promise<void>((done) => {
        plain.close(() => done());
        plain.closeAllConnections();
      });
      await refused.close();
    }
  }, 180_000);

  it("http-01：Pebble 真来取令牌", async () => {
    const dataDir = tempDir("armadra-acme-pebble-http-");
    const manager = new AcmeManager(dataDir, validatingConfig("http-01"), {
      log: silent,
    });
    await manager.start();
    try {
      expect(manager.httpPort()).toBe(HTTP_PORT);
      expect(manager.status().challenge).toBe("http-01");
      const material = resolveTls({ dataDir, hosts: [], generated: "acme" });
      expect(material.names).toEqual([HOST_NAME]);
    } finally {
      await manager.close();
    }
  }, 180_000);
});
