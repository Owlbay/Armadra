import { readFileSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installRouteGuard, routeGuard } from "../identity/gate";
import { installContract } from "../http/rpc";
import { install as installSettings } from "../settings";
import { type Fixture, fixture } from "../workspaces/fixture";
import {
  ACCOUNT,
  ISSUER,
  PASSWORD,
  RELAY_FP,
  type FakeWorld,
  fakeWorld,
} from "./fake.fixture";
import { install } from "./index";

/**
 * 装配好的源域经 HTTP：procedure 与旧路径同一份实现、凭据只在 core 数据目录、
 * 成员（没有 `settings:*`）403、远程服务不可达时本机照常（旁路保证）。
 */

let core: Fixture;
let world: FakeWorld;
let base: string;

beforeEach(async () => {
  world = fakeWorld();
  core = fixture([
    installSettings,
    (context) => {
      install(context, { transport: world.transport });
    },
  ]);
  installContract(core.server, {
    validateOutput: true,
    platform: core.platform,
  });
  const listener = core.server.createListener();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await core.server.close();
  core.close();
});

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

async function legacy(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: JSON.parse(text) as Record<string, unknown>,
  };
}

const personal = {
  kind: "personal",
  issuer: ISSUER,
  account: ACCOUNT,
  password: PASSWORD,
  fingerprint: RELAY_FP,
};

describe("装配", () => {
  it("启动只写本机那一行，不联网", async () => {
    const listed = await rpc("sources.list");
    expect(listed.status).toBe(200);
    const json = listed.body.json as {
      sources: { kind: string }[];
      remotes: unknown[];
    };
    expect(json.sources.map((one) => one.kind)).toEqual(["local"]);
    expect(json.remotes).toEqual([]);
    expect(world.requests).toEqual([]);
  });

  it("procedure 与旧路径答同一份", async () => {
    const viaRpc = await rpc("sources.list");
    const viaLegacy = await legacy("GET", "/api/sources");
    expect(viaLegacy.status).toBe(200);
    expect(viaLegacy.body).toEqual(viaRpc.body.json);
    // 路由表里的回落 handler（门面没装时）也是同一份。
    const table = await core.call("GET", "/api/sources");
    expect(table.body).toEqual(viaRpc.body.json);
  });
});

describe("凭据边界", () => {
  it("remoteAdd：答案里没有口令与令牌，刷新令牌只在 core 数据目录的 SecretStore", async () => {
    const added = await rpc("sources.remoteAdd", personal);
    expect(added.status).toBe(200);
    expect(added.text).not.toContain(PASSWORD);
    expect(added.text).not.toMatch(/refresh|cloud-access|"password"/);
    const again = await legacy("POST", "/api/sources/remotes", personal);
    expect(again.status).toBe(200);
    expect(again.text).not.toMatch(/refresh-|horse|"password"/);

    const secrets = join(core.dataDir, "secrets");
    const files = readdirSync(secrets).filter((name) =>
      name.startsWith("armadra-remote-"),
    );
    expect(files).toHaveLength(1);
    const stored = readFileSync(join(secrets, files[0]!), "utf8");
    expect(stored).toContain("refresh-");
    expect(stored).not.toContain(PASSWORD);

    const session = await rpc("sources.remoteSession", {
      serviceId: (added.body.json as { remote: { serviceId: string } }).remote
        .serviceId,
    });
    expect(session.status).toBe(200);
    // 访问令牌是这一条的用途；刷新令牌仍然不出现。
    expect(session.text).toContain("cloud-access-");
    expect(session.text).not.toContain("refresh-");
  });

  it("口令错：401 credentials_invalid，原话不回显口令", async () => {
    const refused = await rpc("sources.remoteAdd", {
      ...personal,
      password: "wrong-pw",
    });
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe("credentials_invalid");
    expect(refused.text).not.toContain("wrong-pw");
  });

  it("入参校验失败不回显值（口令不进 details）", async () => {
    const refused = await rpc("sources.remoteAdd", {
      ...personal,
      issuer: 42,
    });
    expect(refused.status).toBe(400);
    expect(refused.text).not.toContain(PASSWORD);
  });

  it("SaaS 预留：501 not_implemented", async () => {
    const refused = await rpc("sources.remoteAdd", {
      kind: "saas",
      issuer: "https://cloud.test",
    });
    expect(refused.status).toBe(501);
    expect(refused.body.code).toBe("not_implemented");
  });
});

describe("授权", () => {
  let restore: ReturnType<typeof routeGuard>;
  beforeEach(() => {
    restore = routeGuard();
  });
  afterEach(() => installRouteGuard(restore));

  it("没有 settings:* 的成员 403，且不发任何外呼", async () => {
    installRouteGuard((_request, requirement) => ({
      allowed: !(requirement?.permission ?? "").startsWith("settings:"),
    }));
    for (const [procedure, input] of [
      ["sources.list", {}],
      ["sources.remoteAdd", personal],
      ["sources.session", { sourceId: "1".repeat(32) }],
    ] as const) {
      const refused = await rpc(procedure, input);
      expect(refused.status, procedure).toBe(403);
      expect(refused.body.code).toBe("forbidden");
    }
    expect((await legacy("GET", "/api/sources")).status).toBe(403);
    expect(world.requests).toEqual([]);
  });
});

describe("旁路保证", () => {
  it("远程服务不可达：那一次调用 502，本机行与别的域照常", async () => {
    world.down.add(ISSUER);
    const refused = await rpc("sources.remoteAdd", personal);
    expect(refused.status).toBe(502);
    expect(refused.body.code).toBe("source_unreachable");
    expect((await rpc("sources.list")).status).toBe(200);
    expect((await legacy("GET", "/api/settings")).status).toBe(200);
  });

  it("加过远程服务之后它掉线：列表不等它、不联网", async () => {
    await rpc("sources.remoteAdd", personal);
    world.down.add(ISSUER);
    const before = world.requests.length;
    const listed = await rpc("sources.list");
    expect(listed.status).toBe(200);
    expect((listed.body.json as { remotes: unknown[] }).remotes).toHaveLength(
      1,
    );
    expect(world.requests.length).toBe(before);
    const serviceId = (listed.body.json as { remotes: { serviceId: string }[] })
      .remotes[0]!.serviceId;
    // 删得掉：尽力登出失败不拦。
    expect(
      (await legacy("DELETE", `/api/sources/remotes/${serviceId}`)).status,
    ).toBe(200);
  });
});
