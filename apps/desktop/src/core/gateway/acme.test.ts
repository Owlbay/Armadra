import { spawnSync } from "node:child_process";
import {
  X509Certificate,
  createPrivateKey,
  generateKeyPairSync,
} from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { OUTBOUND } from "../net/outbound";
import { tempDir } from "../testing/temp-dir";
import {
  ACME_ALERT_AFTER,
  AcmeError,
  type AcmeIssuer,
  AcmeManager,
  type AcmeConfig,
  type Timers,
  acmeConfigFrom,
  certificateRequest,
} from "./acme";
import {
  ACME_ACCOUNT_KEY,
  ACME_CERT,
  ACME_DIR,
  ACME_KEY,
  ACME_STATE,
  SELF_SIGNED_DIR,
  issueLeaf,
  localCa,
  resolveTls,
} from "./tls";

const posixOnly = it.skipIf(process.platform === "win32");
const DAY_MS = 24 * 60 * 60 * 1000;
const silent = { debug() {}, info() {}, warn() {}, error() {} };

function config(overrides: Partial<AcmeConfig> = {}): AcmeConfig {
  return {
    email: "ops@armadra.test",
    names: ["armadra.test"],
    directoryUrl: "https://ca.armadra.test/directory",
    httpPort: 0,
    httpHost: "127.0.0.1",
    redirectOrigin: "https://armadra.test",
    ...overrides,
  };
}

/** 手动推进的时钟与计时器：到点由用例自己 `fire()`。 */
function clock(start: Date) {
  let now = start.getTime();
  const pending = new Map<number, { at: number; callback: () => void }>();
  let next = 1;
  const timers: Timers = {
    set: (callback, ms) => {
      const id = next++;
      pending.set(id, { at: now + ms, callback });
      return id;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    now: () => new Date(now),
    timers,
    pendingAt: () => [...pending.values()].map((entry) => entry.at),
    /** 把时钟拨到最近一个计时器并触发它。 */
    fire: () => {
      const [id, entry] = [...pending.entries()].sort(
        (a, b) => a[1].at - b[1].at,
      )[0] ?? [undefined, undefined];
      if (id === undefined || entry === undefined)
        throw new Error("没有计时器");
      pending.delete(id);
      now = Math.max(now, entry.at);
      entry.callback();
    },
  };
}

/** 假 CA：按请求的私钥与名字签一张 `days` 天的证书。 */
function fakeIssuer(
  dataDir: string,
  now: () => Date,
  days = 90,
): AcmeIssuer & { calls: number; accountKeys: string[]; fail: number } {
  const ca = localCa(join(dataDir, "fake-ca"), now());
  const issuer = (async (request) => {
    issuer.calls += 1;
    issuer.accountKeys.push(request.accountKey);
    if (issuer.fail > 0) {
      issuer.fail -= 1;
      throw new AcmeError("acme_failed", "CA 暂时不可用");
    }
    const at = now();
    return issueLeaf(ca, request.names, at, {
      privateKey: createPrivateKey(request.certificateKey),
      notBefore: at,
      notAfter: new Date(at.getTime() + days * DAY_MS),
    }).cert;
  }) as AcmeIssuer & { calls: number; accountKeys: string[]; fail: number };
  issuer.calls = 0;
  issuer.accountKeys = [];
  issuer.fail = 0;
  return issuer;
}

describe("ACME 配置", () => {
  const base = {
    email: "ops@armadra.test",
    publicOrigins: ["https://armadra.example.com"],
    env: {},
  };

  it("缺省目录是登记过的 Let's Encrypt，挑战端口 80，名字来自对外来源", () => {
    const parsed = acmeConfigFrom(base);
    expect(parsed.directoryUrl).toBe(OUTBOUND.acmeLetsEncrypt.url);
    expect(parsed.httpPort).toBe(80);
    expect(parsed.names).toEqual(["armadra.example.com"]);
    expect(parsed.profile).toBeUndefined();
    expect(parsed.redirectOrigin).toBe("https://armadra.example.com");
  });

  it("缺邮箱、缺来源、回环来源、错误取值都是 acme_misconfigured", () => {
    const code = (input: Parameters<typeof acmeConfigFrom>[0]) => {
      try {
        acmeConfigFrom(input);
        return "ok";
      } catch (error) {
        return (error as AcmeError).code;
      }
    };
    expect(code({ ...base, email: "" })).toBe("acme_misconfigured");
    expect(code({ ...base, publicOrigins: [] })).toBe("acme_misconfigured");
    expect(code({ ...base, publicOrigins: ["https://localhost:8443"] })).toBe(
      "acme_misconfigured",
    );
    expect(code({ ...base, publicOrigins: ["https://127.0.0.1"] })).toBe(
      "acme_misconfigured",
    );
    expect(code({ ...base, env: { ARMADRA_ACME_PROFILE: "forever" } })).toBe(
      "acme_misconfigured",
    );
    expect(code({ ...base, env: { ARMADRA_ACME_HTTP_PORT: "eighty" } })).toBe(
      "acme_misconfigured",
    );
    expect(
      code({ ...base, env: { ARMADRA_ACME_CA_BUNDLE: "/nonexistent.pem" } }),
    ).toBe("acme_misconfigured");
  });

  it("名字里有 IP 而没给 profile 时取 shortlived；环境变量覆盖目录、端口与根", () => {
    const dir = tempDir("armadra-acme-config-");
    const bundle = join(dir, "root.pem");
    writeFileSync(bundle, "PEM");
    const parsed = acmeConfigFrom({
      ...base,
      publicOrigins: ["https://203.0.113.7"],
      env: {
        ARMADRA_ACME_DIRECTORY: "https://127.0.0.1:14000/dir",
        ARMADRA_ACME_HTTP_PORT: "8080",
        ARMADRA_ACME_CA_BUNDLE: bundle,
      },
    });
    expect(parsed.profile).toBe("shortlived");
    expect(parsed.names).toEqual(["203.0.113.7"]);
    expect(parsed.directoryUrl).toBe("https://127.0.0.1:14000/dir");
    expect(parsed.httpPort).toBe(8080);
    expect(parsed.caBundle).toBe("PEM");
    expect(
      acmeConfigFrom({ ...base, env: { ARMADRA_ACME_PROFILE: "classic" } })
        .profile,
    ).toBe("classic");
  });
});

const openssl = spawnSync("openssl", ["version"]).status === 0;

describe("证书请求", () => {
  it.skipIf(!openssl)("openssl 验得过签名，SAN 里是域名与 IP", () => {
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const csr = certificateRequest(["armadra.test", "203.0.113.7"], key);
    const file = join(tempDir("armadra-acme-csr-"), "request.pem");
    writeFileSync(file, csr);
    const verified = spawnSync(
      "openssl",
      ["req", "-in", file, "-noout", "-verify", "-text"],
      { encoding: "utf8" },
    );
    expect(verified.status).toBe(0);
    expect(`${verified.stdout}${verified.stderr}`).toMatch(/verify OK/i);
    expect(verified.stdout).toContain("DNS:armadra.test");
    expect(verified.stdout).toContain("IP Address:203.0.113.7");
  });
});

describe("ACME 管理器", () => {
  it("首签写下 0600 的账户密钥、证书与私钥，Gateway 按 acme 来源读得出来", async () => {
    const dataDir = tempDir("armadra-acme-");
    const time = clock(new Date("2026-10-01T00:00:00Z"));
    const issuer = fakeIssuer(dataDir, time.now);
    const manager = new AcmeManager(dataDir, config(), {
      log: silent,
      issuer,
      now: time.now,
      timers: time.timers,
      listen: false,
    });
    await manager.start();
    expect(issuer.calls).toBe(1);
    const material = resolveTls({ dataDir, hosts: [], generated: "acme" });
    expect(material.source).toBe("acme");
    expect(material.names).toContain("armadra.test");
    expect(material.anchor).toBeUndefined();
    const status = manager.status();
    expect(status.failures).toBe(0);
    expect(status.lastError).toBeNull();
    // 90 天的证书在第 60 天续。
    expect(status.renewAt).toBe("2026-11-30T00:00:00.000Z");
    // 60 天超出 setTimeout 的上限：先等一段（约 24.8 天），到点再排剩下的。
    expect(time.pendingAt()).toEqual([
      new Date("2026-10-01T00:00:00Z").getTime() + 2 ** 31 - 1,
    ]);
    time.fire();
    expect(issuer.calls).toBe(1);
    expect(time.pendingAt()).toHaveLength(1);
    await manager.close();
  });

  posixOnly("目录 0700，每个文件 0600", async () => {
    const dataDir = tempDir("armadra-acme-mode-");
    const time = clock(new Date("2026-10-01T00:00:00Z"));
    const manager = new AcmeManager(dataDir, config(), {
      log: silent,
      issuer: fakeIssuer(dataDir, time.now),
      now: time.now,
      timers: time.timers,
      listen: false,
    });
    await manager.start();
    const directory = join(dataDir, SELF_SIGNED_DIR, ACME_DIR);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    for (const name of [ACME_ACCOUNT_KEY, ACME_CERT, ACME_KEY, ACME_STATE]) {
      expect(statSync(join(directory, name)).mode & 0o777).toBe(0o600);
    }
    await manager.close();
  });

  it("重启时手里那张可用就不签；换了目录地址或名字就重签", async () => {
    const dataDir = tempDir("armadra-acme-reuse-");
    const time = clock(new Date("2026-10-01T00:00:00Z"));
    const issuer = fakeIssuer(dataDir, time.now);
    const options = {
      log: silent,
      issuer,
      now: time.now,
      timers: time.timers,
      listen: false,
    };
    const first = new AcmeManager(dataDir, config(), options);
    await first.start();
    await first.close();
    const again = new AcmeManager(dataDir, config(), options);
    await again.start();
    await again.close();
    expect(issuer.calls).toBe(1);

    const moved = new AcmeManager(
      dataDir,
      config({ directoryUrl: "https://other-ca.armadra.test/dir" }),
      options,
    );
    await moved.start();
    await moved.close();
    expect(issuer.calls).toBe(2);

    const renamed = new AcmeManager(
      dataDir,
      config({
        directoryUrl: "https://other-ca.armadra.test/dir",
        names: ["armadra.test", "www.armadra.test"],
      }),
      options,
    );
    await renamed.start();
    await renamed.close();
    expect(issuer.calls).toBe(3);
    // 账户密钥一直是同一把。
    expect(new Set(issuer.accountKeys).size).toBe(1);
  });

  it("续期失败继续用旧证书，退避重试；连续 3 次通知一次，成功后清零并热换", async () => {
    const dataDir = tempDir("armadra-acme-renew-");
    const time = clock(new Date("2026-10-01T00:00:00Z"));
    const issuer = fakeIssuer(dataDir, time.now, 6);
    const onAlert = vi.fn();
    const renewed = vi.fn();
    const manager = new AcmeManager(dataDir, config(), {
      log: silent,
      issuer,
      now: time.now,
      timers: time.timers,
      onAlert,
      listen: false,
    });
    await manager.start();
    manager.onRenewed(renewed);
    const certFile = join(dataDir, SELF_SIGNED_DIR, ACME_DIR, ACME_CERT);
    const original = readFileSync(certFile, "utf8");
    // 6 天的短期证书在第 4 天续。
    expect(manager.status().renewAt).toBe("2026-10-05T00:00:00.000Z");

    issuer.fail = ACME_ALERT_AFTER;
    const retries: string[] = [];
    for (let attempt = 1; attempt <= ACME_ALERT_AFTER; attempt += 1) {
      time.fire();
      await vi.waitFor(() => expect(manager.status().failures).toBe(attempt));
      retries.push(manager.status().renewAt as string);
      expect(readFileSync(certFile, "utf8")).toBe(original);
    }
    expect(manager.status().lastError?.code).toBe("acme_failed");
    // 1、2、4 小时退避。
    expect(retries).toEqual([
      "2026-10-05T01:00:00.000Z",
      "2026-10-05T03:00:00.000Z",
      "2026-10-05T07:00:00.000Z",
    ]);
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert.mock.calls[0]?.[0].failures).toBe(ACME_ALERT_AFTER);
    expect(renewed).not.toHaveBeenCalled();

    time.fire();
    await vi.waitFor(() => expect(renewed).toHaveBeenCalledTimes(1));
    expect(manager.status().failures).toBe(0);
    expect(manager.status().lastError).toBeNull();
    const fresh = readFileSync(certFile, "utf8");
    expect(fresh).not.toBe(original);
    expect(new X509Certificate(fresh).validFrom).not.toBe(
      new X509Certificate(original).validFrom,
    );
    expect(onAlert).toHaveBeenCalledTimes(1);
    await manager.close();
  });

  it("首签失败就起不来，挑战监听也一并关掉", async () => {
    const dataDir = tempDir("armadra-acme-fail-");
    const time = clock(new Date("2026-10-01T00:00:00Z"));
    const issuer = fakeIssuer(dataDir, time.now);
    issuer.fail = 1;
    const manager = new AcmeManager(dataDir, config(), {
      log: silent,
      issuer,
      now: time.now,
      timers: time.timers,
    });
    await expect(manager.start()).rejects.toMatchObject({
      code: "acme_failed",
    });
    expect(manager.httpPort()).toBeUndefined();
    expect(
      existsSync(join(dataDir, SELF_SIGNED_DIR, ACME_DIR, ACME_CERT)),
    ).toBe(false);
  });

  it("http-01：挑战进行时按令牌答 key authorization，别的路径 308 到对外来源", async () => {
    const dataDir = tempDir("armadra-acme-http-");
    const time = clock(new Date("2026-10-01T00:00:00Z"));
    const issuer = fakeIssuer(dataDir, time.now);
    let seen: { status: number; body: string } | undefined;
    let manager: AcmeManager | undefined;
    const wrapped: AcmeIssuer = async (request) => {
      // 监听在签发之前就开好了：CA 回连时令牌已经在表里。
      request.challenges.set("token-1", "token-1.thumbprint");
      seen = await get(
        manager?.httpPort() as number,
        "/.well-known/acme-challenge/token-1",
      );
      request.challenges.delete("token-1");
      return issuer(request);
    };
    manager = new AcmeManager(dataDir, config(), {
      log: silent,
      issuer: wrapped,
      now: time.now,
      timers: time.timers,
    });
    await manager.start();
    const port = manager.httpPort() as number;
    expect(seen).toEqual({ status: 200, body: "token-1.thumbprint" });
    expect(
      (await get(port, "/.well-known/acme-challenge/token-1")).status,
    ).toBe(404);
    const redirect = await get(port, "/board?x=1");
    expect(redirect.status).toBe(308);
    expect(redirect.location).toBe("https://armadra.test/board?x=1");
    await manager.close();
  });
});

function get(
  port: number,
  path: string,
): Promise<{ status: number; body: string; location?: string }> {
  return new Promise((done, failed) => {
    const client = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET" },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          done({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            ...(response.headers.location === undefined
              ? {}
              : { location: response.headers.location }),
          }),
        );
      },
    );
    client.on("error", failed);
    client.end();
  });
}
