import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openFreshDatabase } from "../db/fresh.fixture";
import type { OpenedDatabase } from "../db/open";
import { CoreFailure } from "../http/errors";
import { tempDir } from "../testing/temp-dir";
import { migrationsDir } from "../workspaces/fixture";
import {
  ACCOUNT,
  GATEWAY,
  GATEWAY_FP,
  ISSUER,
  PASSWORD,
  PEER_ID,
  RELAYED_ID,
  RELAY_FP,
  type FakeWorld,
  fakeWorld,
  memoryBackend,
} from "./fake.fixture";
import type { Transport } from "./http-client";
import { RemoteClient } from "./remote-client";
import { SourceSecrets } from "./secrets";
import { SourcesService } from "./service";
import { SourceClient } from "./source-client";
import { SourcesStore } from "./store";

/**
 * 一源多路（契约 §55）：同一台主机经两个个人中转（局域网的与公网的）挂上来。
 * 两个中继各是一个假的个人中转（`fake.fixture.ts`），各有自己的那台假 core——
 * core 的会话绑在登录它的中继来源上，拿一个中继的刷新令牌去另一个换票就是 401，
 * 与真的一样（§32.3）。
 */

const HOST_ID = "f".repeat(32);
const LAN = "https://lan-relay.test";

let opened: OpenedDatabase;
let pub: FakeWorld;
let lan: FakeWorld;
let backend: ReturnType<typeof memoryBackend>;
let service: SourcesService;

/** 公网中继就是 `ISSUER`；局域网中继是同一个假中继换了来源。 */
function twoRelays(): Transport {
  return async (request) => {
    if (!request.url.startsWith(LAN)) return pub.transport(request);
    const answer = await lan.transport({
      ...request,
      url: ISSUER + request.url.slice(LAN.length),
    });
    return {
      status: answer.status,
      body:
        answer.body === undefined
          ? undefined
          : (JSON.parse(
              JSON.stringify(answer.body).replaceAll(ISSUER, LAN),
            ) as unknown),
    };
  };
}

function code(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "resolved",
    (error: unknown) =>
      error instanceof CoreFailure ? error.code : String(error),
  );
}

beforeEach(() => {
  const directory = tempDir("armadra-multi-route-");
  opened = openFreshDatabase(join(directory, "canvas.db"), migrationsDir());
  pub = fakeWorld();
  lan = fakeWorld();
  backend = memoryBackend();
  const transport = twoRelays();
  service = new SourcesService({
    store: new SourcesStore(opened.database),
    secrets: new SourceSecrets(() => backend),
    remote: new RemoteClient(transport, { platform: "desktop", name: "test" }),
    peer: new SourceClient(transport),
    hostId: () => HOST_ID,
    hostLabel: () => "this-mac",
    log: { info: () => undefined, warn: () => undefined },
  });
  service.ensureLocal();
});

afterEach(() => {
  opened.close();
});

async function signIn(issuer: string) {
  return (
    await service.remoteAdd({
      kind: "personal",
      issuer,
      account: ACCOUNT,
      password: PASSWORD,
      fingerprint: RELAY_FP,
    })
  ).remote;
}

async function mountBoth() {
  const first = await signIn(ISSUER);
  const second = await signIn(LAN);
  await service.mount({ serviceId: first.serviceId, sourceId: RELAYED_ID });
  const mounted = await service.mount({
    serviceId: second.serviceId,
    sourceId: RELAYED_ID,
  });
  return { first, second, mounted };
}

function stored(sourceId: string): Record<string, { refreshToken: string }> {
  return (
    (
      JSON.parse(backend.values.get(`armadra-source-${sourceId}`) ?? "{}") as {
        byOrigin?: Record<string, { refreshToken: string }>;
      }
    ).byOrigin ?? {}
  );
}

const relayedCore = (world: FakeWorld) =>
  world.cores.get(`${ISSUER}/s/${RELAYED_ID}`)!;

describe("同一台主机经两个中继", () => {
  it("挂第二个中继：一行两条路，镜像不变，凭据各一槽", async () => {
    const { mounted } = await mountBoth();
    const { sources } = await service.list();
    expect(sources.filter((one) => one.sourceId === RELAYED_ID)).toHaveLength(
      1,
    );
    expect(mounted).toMatchObject({
      kind: "relayed",
      relayOrigin: ISSUER,
      cloudIssuer: ISSUER,
    });
    expect(
      mounted.routes.map(({ via, origin, cloudIssuer, preferred }) => ({
        via,
        origin,
        cloudIssuer,
        preferred,
      })),
    ).toEqual([
      { via: "relayed", origin: ISSUER, cloudIssuer: ISSUER, preferred: true },
      { via: "relayed", origin: LAN, cloudIssuer: LAN, preferred: false },
    ]);
    const slots = stored(RELAYED_ID);
    expect(Object.keys(slots).sort()).toEqual([LAN, ISSUER].sort());
    expect(slots[ISSUER]?.refreshToken).not.toBe(slots[LAN]?.refreshToken);
  });

  it("来回切换不再 cloud/login：每条路用自己的刷新令牌", async () => {
    await mountBoth();
    expect(relayedCore(pub).cloudLogins).toBe(1);
    expect(relayedCore(lan).cloudLogins).toBe(1);
    for (let round = 0; round < 3; round += 1) {
      const viaLan = await service.session(RELAYED_ID, undefined, {
        via: "relayed",
        origin: LAN,
      });
      expect(viaLan.httpBase).toBe(`${LAN}/s/${RELAYED_ID}`);
      const viaPub = await service.session(RELAYED_ID, undefined, {
        via: "relayed",
        origin: ISSUER,
      });
      expect(viaPub.httpBase).toBe(`${ISSUER}/s/${RELAYED_ID}`);
    }
    // 切换六次，core 上没有多一台设备。
    expect(relayedCore(pub).cloudLogins).toBe(1);
    expect(relayedCore(lan).cloudLogins).toBe(1);
  });

  it("不指定路：首选的中继不通时用另一条", async () => {
    await mountBoth();
    const first = await service.session(RELAYED_ID);
    expect(first.httpBase).toBe(`${ISSUER}/s/${RELAYED_ID}`);
    pub.down.add(ISSUER);
    const fallback = await service.session(RELAYED_ID);
    expect(fallback).toMatchObject({
      via: "relayed",
      httpBase: `${LAN}/s/${RELAYED_ID}`,
    });
    expect(relayedCore(lan).cloudLogins).toBe(1);
    lan.down.add(ISSUER);
    expect(await code(service.session(RELAYED_ID))).toBe("source_unreachable");
  });

  it("首选不在线时另一条在线就用它", async () => {
    await mountBoth();
    pub.cloud.online = false;
    expect((await service.session(RELAYED_ID)).httpBase).toBe(
      `${LAN}/s/${RELAYED_ID}`,
    );
    lan.cloud.online = false;
    expect(await code(service.session(RELAYED_ID))).toBe("source_offline");
  });

  it("remoteSources 的 mounted：经这个服务有路才算", async () => {
    const first = await signIn(ISSUER);
    const second = await signIn(LAN);
    await service.mount({ serviceId: first.serviceId, sourceId: RELAYED_ID });
    const viaFirst = await service.remoteSources(first.serviceId);
    const viaSecond = await service.remoteSources(second.serviceId);
    const mountedIn = (list: typeof viaFirst) =>
      list.sources.find((one) => one.sourceId === RELAYED_ID)?.mounted;
    expect(mountedIn(viaFirst)).toBe(true);
    expect(mountedIn(viaSecond)).toBe(false);
    await service.mount({ serviceId: second.serviceId, sourceId: RELAYED_ID });
    expect(mountedIn(await service.remoteSources(second.serviceId))).toBe(true);
  });

  it("routePrefer 改镜像；routeRemove 删路连同凭据，最后一条答 conflict", async () => {
    await mountBoth();
    const preferred = await service.routePrefer({
      sourceId: RELAYED_ID,
      via: "relayed",
      origin: LAN,
    });
    expect(preferred).toMatchObject({ relayOrigin: LAN, cloudIssuer: LAN });
    expect((await service.session(RELAYED_ID)).httpBase).toBe(
      `${LAN}/s/${RELAYED_ID}`,
    );

    const removed = await service.routeRemove({
      sourceId: RELAYED_ID,
      via: "relayed",
      origin: ISSUER,
    });
    expect(removed.routes.map((one) => one.origin)).toEqual([LAN]);
    expect(Object.keys(stored(RELAYED_ID))).toEqual([LAN]);
    expect(
      await code(
        service.routeRemove({
          sourceId: RELAYED_ID,
          via: "relayed",
          origin: LAN,
        }),
      ),
    ).toBe("conflict");
    expect(
      await code(
        service.routePrefer({
          sourceId: RELAYED_ID,
          via: "relayed",
          origin: ISSUER,
        }),
      ),
    ).toBe("not_found");
    expect(
      await code(
        service.routePrefer({
          sourceId: HOST_ID,
          via: "direct",
          origin: GATEWAY,
        }),
      ),
    ).toBe("conflict");
  });

  it("删掉首选的路：剩下的接替首选与镜像", async () => {
    await mountBoth();
    const after = await service.routeRemove({
      sourceId: RELAYED_ID,
      via: "relayed",
      origin: ISSUER,
    });
    expect(after).toMatchObject({ relayOrigin: LAN, cloudIssuer: LAN });
    expect(after.routes[0]).toMatchObject({ origin: LAN, preferred: true });
  });

  it("答案里没有凭据", async () => {
    await mountBoth();
    const answer = JSON.stringify(await service.list());
    for (const value of backend.values.values()) {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      const tokens = JSON.stringify(parsed).match(/refresh-[^"]+/g) ?? [];
      expect(tokens.length).toBeGreaterThan(0);
      for (const token of tokens) expect(answer).not.toContain(token);
    }
    const rows = opened.database
      .prepare("SELECT * FROM client_source_routes")
      .all();
    expect(JSON.stringify(rows)).not.toContain("secret");
  });
});

describe("直连与中继同一台主机", () => {
  it("先配对再经中继挂上：直连首选，两条路都在", async () => {
    await service.addDirect({
      pairLink: `${GATEWAY}/#pair=ticket-1&fp=${GATEWAY_FP}`,
    });
    const first = await signIn(ISSUER);
    const mounted = await service.mount({
      serviceId: first.serviceId,
      sourceId: PEER_ID,
    });
    expect(mounted).toMatchObject({
      kind: "direct",
      baseUrl: GATEWAY,
      relayOrigin: ISSUER,
      cloudIssuer: ISSUER,
    });
    expect(
      mounted.routes.map(({ via, preferred }) => ({ via, preferred })),
    ).toEqual([
      { via: "direct", preferred: true },
      { via: "relayed", preferred: false },
    ]);
    expect((await service.session(PEER_ID)).via).toBe("direct");
    pub.down.add(GATEWAY);
    expect((await service.session(PEER_ID)).via).toBe("relayed");
    expect((await service.session(PEER_ID, "relayed")).httpBase).toBe(
      `${ISSUER}/s/${PEER_ID}`,
    );
  });

  it("update 改直连地址：那条路换来源，旧来源的凭据删掉", async () => {
    await service.addDirect({
      pairLink: `${GATEWAY}/#pair=ticket-1&fp=${GATEWAY_FP}`,
    });
    const updated = await service.update({
      sourceId: PEER_ID,
      baseUrl: "https://gw2.test:8443",
    });
    expect(updated.baseUrl).toBe("https://gw2.test:8443");
    expect(updated.routes.map((one) => one.origin)).toEqual([
      "https://gw2.test:8443",
    ]);
    expect(stored(PEER_ID)[GATEWAY]).toBeUndefined();
  });

  it("删源连同全部路", async () => {
    await mountBoth();
    await service.remove(RELAYED_ID);
    expect(
      opened.database
        .prepare("SELECT COUNT(*) AS n FROM client_source_routes")
        .get(),
    ).toEqual({ n: 0 });
  });
});
