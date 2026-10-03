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
 */

import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { tempDir } from "../testing/temp-dir";
import { AcmeManager, acmeConfigFrom } from "./acme";
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
function pebbleRoot(directory: string): string | undefined {
  if (!enabled) return undefined;
  const running = compose(["ps", "-q", "pebble"]);
  if (running.status !== 0 || running.stdout.trim() === "") return undefined;
  const target = join(directory, "pebble.minica.pem");
  const copied = compose([
    "cp",
    "pebble:/test/certs/pebble.minica.pem",
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
