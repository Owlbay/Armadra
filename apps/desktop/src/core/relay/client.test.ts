import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  TEST_KEYS,
  readJsonFixture,
} from "@armadra/platform-protocol/fixtures";
import { challengeSigningInput } from "@armadra/platform-protocol/tunnel";

import { backoffDelay, tunnelUrl } from "./client";
import {
  LOOPBACK_ORIGIN,
  type RelayCore,
  relayCore,
  until,
} from "./core.fixture";
import { RELAY_NODE } from "./fake-relay.fixture";
import { orderNodes } from "./nodes";

/**
 * 隧道客户端（契约 §32，平台规格 core 包 §4.2）：握手、拒绝码、心跳超时、GOAWAY、
 * 退避与设置开关；中继不可达时 core 的回环 API 照常（旁路保证）。
 */

let world: RelayCore | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

describe("握手", () => {
  it("登记之后连上中继：hello 带本机 sourceId 与协议版本，签名被中继验过，状态 ready", async () => {
    world = await relayCore();
    await world.register();
    const tunnel = await world.relay.nextTunnel(0);
    expect(tunnel.hello.sourceId).toBe(world.store.hostId());
    expect(tunnel.hello.protocol).toEqual({ major: 1, minor: 1 });
    expect(tunnel.hello.tunnelToken).toBe("tunnel-token");
    const current = world;
    await until(
      () =>
        current.tunnels.status(current.cloud.registrations()[0]!.issuer)
          .state === "ready",
    );
    const status = (await world.cloud.status()).registrations[0]!.tunnel;
    expect(status).toMatchObject({
      state: "ready",
      node: RELAY_NODE,
      lastError: null,
    });
    // 隧道令牌取过一次，带的是源 JWS。
    const hint = world.world.requests.find((one) =>
      one.url.endsWith("/v1/sources/me/relay"),
    );
    expect(hint?.headers?.authorization).toMatch(/^Source ey/);
  });

  it("reject protocol_unsupported：停下、记错误、不再重连", async () => {
    world = await relayCore({ relay: { reject: "protocol_unsupported" } });
    await world.register();
    const current = world;
    const issuer = current.cloud.registrations()[0]!.issuer;
    await until(
      () =>
        current.tunnels.status(issuer).lastError !== null &&
        current.tunnels.status(issuer).state === "disabled",
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(world.relay.hellos).toHaveLength(1);
    expect(world.tunnels.status(issuer)).toMatchObject({
      state: "disabled",
      lastError: { code: "protocol_unsupported" },
    });
  });

  it("reject source_revoked：本机登记随之撤销", async () => {
    world = await relayCore({ relay: { reject: "source_revoked" } });
    await world.register();
    const current = world;
    await until(() => current.cloud.registrations().length === 0);
    expect(world.relay.hellos).toHaveLength(1);
  });

  it("取隧道令牌答 410 source_revoked：同样撤销，不去连中继", async () => {
    world = await relayCore();
    world.hint = {
      status: 410,
      body: { code: "source_revoked", message: "revoked" },
    };
    await world.register();
    const current = world;
    await until(() => current.cloud.registrations().length === 0);
    expect(world.relay.connections).toBe(0);
  });

  it("tunnel_token_expired：丢掉缓存的令牌，退避后重新取", async () => {
    world = await relayCore({ relay: { reject: "tunnel_token_expired" } });
    await world.register();
    const current = world;
    await until(() => current.relay.hellos.length >= 2);
    expect(world.hintFetches).toBeGreaterThanOrEqual(2);
  });
});

describe("心跳、GOAWAY 与退避", () => {
  it("中继不回 PONG：两次之后断开重连", async () => {
    world = await relayCore({ relay: { heartbeatMs: 40 } });
    await world.register();
    const first = await world.relay.nextTunnel(0);
    first.silent = true;
    // 中继自己照常发 PING：隧道不静默，断开只能来自「两次没有 PONG」。
    const chatter = setInterval(() => first.ping(), 10);
    try {
      const code = await first.closed;
      expect(code).toBe(1006);
    } finally {
      clearInterval(chatter);
    }
    // 中继侧数到的 PING 会因客户端 terminate 时的 RST 丢掉未读数据而偏少，
    // 不能当判据；改看客户端自己记的原因：走的是「两次没有 PONG」而不是静默看门狗。
    const current = world;
    const issuer = current.cloud.registrations()[0]!.issuer;
    await until(() => current.tunnels.status(issuer).lastError !== null);
    expect(first.pings).toBeGreaterThanOrEqual(1);
    expect(world.tunnels.status(issuer).lastError).toEqual({
      code: "heartbeat_timeout",
      message: "中继连续两次没有回 PONG",
    });
    await world.relay.nextTunnel(1);
  });

  it("中继被冻住（不发任何帧、连接不断）：两个心跳周期内判定断开、进退避", async () => {
    const heartbeatMs = 150;
    world = await relayCore({
      relay: { heartbeatMs },
      backoff: () => 60_000,
    });
    await world.register();
    const first = await world.relay.nextTunnel(0);
    const current = world;
    const issuer = current.cloud.registrations()[0]!.issuer;
    await until(() => current.tunnels.status(issuer).state === "ready");
    first.frozen = true;
    await until(
      () => current.tunnels.status(issuer).state === "backoff",
      5_000,
    );
    // 由静默看门狗（最后一帧起两个周期）判定，而不是等到第三拍的「两次没有 PONG」：
    // 用判定原因代替墙钟上限，CI 上事件循环卡顿不会误报。
    expect(world.tunnels.status(issuer).lastError).toEqual({
      code: "heartbeat_timeout",
      message: "中继超过两个心跳周期没有任何帧",
    });
    expect(world.tunnels.status(issuer).streams).toBe(0);
  });

  it("帧一直在来：静默看门狗不误判，隧道保持 ready", async () => {
    // 静默阈值是 2 × heartbeatMs；窗口太窄时 CI 机器上事件循环一卡就会误判断开。
    const heartbeatMs = 250;
    world = await relayCore({ relay: { heartbeatMs } });
    await world.register();
    const first = await world.relay.nextTunnel(0);
    const current = world;
    const issuer = current.cloud.registrations()[0]!.issuer;
    await until(() => current.tunnels.status(issuer).state === "ready");
    await new Promise((resolve) => setTimeout(resolve, 6 * heartbeatMs));
    expect(first.closeCode).toBeUndefined();
    expect(world.relay.connections).toBe(1);
    expect(world.tunnels.status(issuer)).toMatchObject({
      state: "ready",
      lastError: null,
    });
  });

  it("中继发的 PING 立即回 PONG", async () => {
    world = await relayCore();
    await world.register();
    const tunnel = await world.relay.nextTunnel(0);
    tunnel.ping();
    await until(() => tunnel.pongs === 1);
  });

  it("GOAWAY：不退避立即连新隧道，旧隧道排空后关", async () => {
    // 退避一分钟：只有「不退避」才可能在等待内连上第二条。
    world = await relayCore({ backoff: () => 60_000 });
    await world.register();
    const first = await world.relay.nextTunnel(0);
    first.goaway("shutdown", 5_000);
    const second = await world.relay.nextTunnel(1);
    expect(second).not.toBe(first);
    // 旧隧道上没有流：立刻排空关掉。
    expect(await first.closed).toBe(1000);
    const current = world;
    const issuer = current.cloud.registrations()[0]!.issuer;
    await until(() => current.tunnels.status(issuer).state === "ready");
  });

  it("退避：min(60 s, 1 s × 2^n) × (0.5 + random)", () => {
    expect(
      [0, 1, 2, 3, 6, 7, 30].map((n) => backoffDelay(n, () => 0.5)),
    ).toEqual([1_000, 2_000, 4_000, 8_000, 60_000, 60_000, 60_000]);
    expect(backoffDelay(0, () => 0)).toBe(500);
    expect(backoffDelay(10, () => 0.999)).toBe(89_940);
  });
});

describe("旁路保证", () => {
  it("中继不可达：登记与 start 立即返回，回环 API 照常，状态进退避", async () => {
    const port = await freePort();
    world = await relayCore({ nodeUrl: `ws://127.0.0.1:${port}/t/v1` });
    const started = Date.now();
    await world.register();
    expect(Date.now() - started).toBeLessThan(1_000);
    const current = world;
    const issuer = current.cloud.registrations()[0]!.issuer;
    await until(() => current.tunnels.status(issuer).state === "backoff");
    expect(world.tunnels.status(issuer).lastError?.code).toBe(
      "relay_unreachable",
    );
    const token = world.session(LOOPBACK_ORIGIN);
    for (const path of ["/health", "/api/workspaces"]) {
      const response = await fetch(`${world.base}${path}`, {
        headers: { origin: LOOPBACK_ORIGIN, authorization: `Bearer ${token}` },
      });
      expect(response.status, path).toBe(200);
    }
  });

  it("关掉 cloud.relay.enabled 即停，打开即按登记重连", async () => {
    world = await relayCore();
    await world.register();
    const first = await world.relay.nextTunnel(0);
    const current = world;
    const issuer = current.cloud.registrations()[0]!.issuer;
    world.settings = { enabled: false, preferredNode: "" };
    world.tunnels.stopAll();
    expect(await first.closed).toBe(1000);
    expect(world.tunnels.status(issuer).state).toBe("disabled");
    // 关着时登记一侧再叫 start 也不连。
    world.tunnels.start(issuer);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(world.relay.connections).toBe(1);
    world.settings = { enabled: true, preferredNode: "" };
    world.tunnels.startAll();
    await world.relay.nextTunnel(1);
  });

  it("撤销登记：隧道立即断开", async () => {
    world = await relayCore();
    await world.register();
    const tunnel = await world.relay.nextTunnel(0);
    const issuer = world.cloud.registrations()[0]!.issuer;
    world.cloud.revoke({ issuer });
    expect(await tunnel.closed).toBe(1000);
    expect(world.tunnels.status(issuer).state).toBe("disabled");
  });
});

describe("节点与握手输入", () => {
  it("偏好节点排最前，其余按权重", () => {
    const nodes = [
      { url: "wss://a/t/v1", weight: 1 },
      { url: "wss://b/t/v1", region: "eu", weight: 5 },
      { url: "wss://c/t/v1", weight: 3 },
    ];
    expect(orderNodes(nodes, "").map((node) => node.url)).toEqual([
      "wss://b/t/v1",
      "wss://c/t/v1",
      "wss://a/t/v1",
    ]);
    expect(orderNodes(nodes, "wss://a/t/v1")[0]?.url).toBe("wss://a/t/v1");
    expect(orderNodes(nodes, "eu")[0]?.url).toBe("wss://b/t/v1");
    expect(tunnelUrl("wss://relay.test").href).toBe("wss://relay.test/t/v1");
    expect(tunnelUrl("wss://relay.test/t/v1").href).toBe(
      "wss://relay.test/t/v1",
    );
  });

  it("auth 的签名输入与协议包黄金向量逐字相同", () => {
    const vector = readJsonFixture<{
      signingInput: string;
      hello: { sourceId: string; nonce: string };
      challenge: { nonce2: string; relayNode: string };
    }>("tunnel/handshake.json");
    const input = challengeSigningInput({
      sourceId: vector.hello.sourceId,
      nonce: vector.hello.nonce,
      nonce2: vector.challenge.nonce2,
      relayNode: vector.challenge.relayNode,
    });
    expect(Buffer.from(input).toString("utf8")).toBe(vector.signingInput);
    expect(TEST_KEYS.source.sourceId).toBe(vector.hello.sourceId);
  });
});
