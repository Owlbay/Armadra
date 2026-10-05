/**
 * 对着一个真的个人中转（armadra-cloud 的 `pnpm relay:personal`，自签 TLS）跑一遍
 * `sources.remoteAdd` / `remoteSession` / `remoteSources` / `remoteRemove`：真 TLS、
 * 真指纹钉扎、真的旋转刷新令牌。
 *
 * `ARMADRA_PERSONAL_RELAY=1` 才跑；否则 skipped。其余从环境读：
 * `ARMADRA_PERSONAL_RELAY_URL`（缺省 `https://127.0.0.1:8102`）、
 * `ARMADRA_PERSONAL_RELAY_FP`（启动日志或 `personal status` 打印的 CA 指纹）、
 * `ARMADRA_PERSONAL_RELAY_ACCOUNT` / `ARMADRA_PERSONAL_RELAY_PASSWORD`（`dev.env`）。
 */

import { readFileSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installContract } from "../http/rpc";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install } from "./index";

const enabled = process.env.ARMADRA_PERSONAL_RELAY === "1";
const issuer =
  process.env.ARMADRA_PERSONAL_RELAY_URL?.trim() || "https://127.0.0.1:8102";
const fingerprint = process.env.ARMADRA_PERSONAL_RELAY_FP?.trim() ?? "";
const account = process.env.ARMADRA_PERSONAL_RELAY_ACCOUNT?.trim() || "dev";
const password = process.env.ARMADRA_PERSONAL_RELAY_PASSWORD ?? "";

let core: Fixture;
let base: string;

async function rpc(procedure: string, input: unknown = {}) {
  const response = await fetch(
    `${base}/api/rpc/${procedure.replace(".", "/")}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: input }),
    },
  );
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: JSON.parse(text) as Record<string, unknown>,
  };
}

describe.skipIf(!enabled)("个人中转联调（契约 §33）", () => {
  beforeAll(async () => {
    core = fixture([(context) => void install(context)]);
    installContract(core.server, {
      validateOutput: true,
      platform: core.platform,
    });
    const listener = core.server.createListener();
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await core.server.close();
    core.close();
  });

  const personal = () => ({
    kind: "personal",
    issuer,
    account,
    password,
    fingerprint,
  });

  it("指纹不匹配被拒，且什么都没记下", async () => {
    const refused = await rpc("sources.remoteAdd", {
      ...personal(),
      fingerprint: "0".repeat(64),
    });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("fingerprint_mismatch");
    const listed = await rpc("sources.list");
    expect((listed.body.json as { remotes: unknown[] }).remotes).toEqual([]);
  });

  it("口令错：credentials_invalid", async () => {
    const refused = await rpc("sources.remoteAdd", {
      ...personal(),
      password: `${password}-wrong`,
    });
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe("credentials_invalid");
    expect(refused.text).not.toContain(password);
  });

  let serviceId = "";

  it("remoteAdd 登录成功：凭据不在响应里，只在 core 数据目录的 SecretStore", async () => {
    const added = await rpc("sources.remoteAdd", personal());
    expect(added.status, added.text).toBe(200);
    const json = added.body.json as {
      remote: {
        serviceId: string;
        hasCredentials: boolean;
        fingerprint: string;
      };
      next: string;
    };
    expect(json.next).toBe("ready");
    expect(json.remote.hasCredentials).toBe(true);
    expect(json.remote.fingerprint).toBe(fingerprint.toLowerCase());
    expect(added.text).not.toContain(password);
    expect(added.text).not.toMatch(/refreshToken|"password"|accessToken/);
    serviceId = json.remote.serviceId;

    const secrets = join(core.dataDir, "secrets");
    const file = readdirSync(secrets).find(
      (name) => name === `armadra-remote-${serviceId}.token`,
    );
    expect(file).toBeDefined();
    const stored = JSON.parse(readFileSync(join(secrets, file!), "utf8")) as {
      refreshToken: string;
    };
    expect(stored.refreshToken.length).toBeGreaterThan(20);
    expect(added.text).not.toContain(stored.refreshToken);
  });

  it("remoteSession 与 remoteSources：刷新令牌旋转，答案里只有访问令牌", async () => {
    const secrets = join(
      core.dataDir,
      "secrets",
      `armadra-remote-${serviceId}.token`,
    );
    const before = readFileSync(secrets, "utf8");
    const session = await rpc("sources.remoteSession", { serviceId });
    expect(session.status, session.text).toBe(200);
    const json = session.body.json as {
      issuer: string;
      capabilities: string[];
    };
    expect(json.issuer).toBe(new URL(issuer).origin);
    expect(json.capabilities).toContain("auth.password");
    const stored = JSON.parse(before) as { refreshToken: string };
    expect(session.text).not.toContain(stored.refreshToken);

    const listed = await rpc("sources.remoteSources", { serviceId });
    expect(listed.status, listed.text).toBe(200);
    expect(
      Array.isArray((listed.body.json as { sources: unknown[] }).sources),
    ).toBe(true);
  });

  it("remoteRemove：登出、删行、删凭据", async () => {
    const removed = await rpc("sources.remoteRemove", { serviceId });
    expect(removed.status).toBe(200);
    expect(
      readdirSync(join(core.dataDir, "secrets")).filter((name) =>
        name.startsWith("armadra-remote-"),
      ),
    ).toEqual([]);
    const listed = await rpc("sources.list");
    expect((listed.body.json as { remotes: unknown[] }).remotes).toEqual([]);
  });
});
