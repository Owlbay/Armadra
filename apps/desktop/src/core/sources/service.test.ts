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
import { RemoteClient } from "./remote-client";
import { SourceSecrets } from "./secrets";
import { SourcesService, parsePairLink } from "./service";
import { SourceClient } from "./source-client";
import { SourcesStore } from "./store";

/**
 * 源服务对着假的个人中转与假的 core（`fake.fixture.ts`）：直连配对、指纹、远程
 * 服务登录、挂载全流程、刷新失败回退到断言，以及凭据只在 SecretStore。
 */

const HOST_ID = "f".repeat(32);

let opened: OpenedDatabase;
let world: FakeWorld;
let backend: ReturnType<typeof memoryBackend>;
let service: SourcesService;
let logs: string[];

function code(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "resolved",
    (error: unknown) =>
      error instanceof CoreFailure ? error.code : String(error),
  );
}

beforeEach(() => {
  const directory = tempDir("armadra-sources-");
  opened = openFreshDatabase(join(directory, "canvas.db"), migrationsDir());
  world = fakeWorld();
  backend = memoryBackend();
  logs = [];
  const log = (message: string, fields?: Record<string, unknown>) =>
    logs.push(`${message} ${JSON.stringify(fields ?? {})}`);
  service = new SourcesService({
    store: new SourcesStore(opened.database),
    secrets: new SourceSecrets(() => backend),
    remote: new RemoteClient(world.transport, {
      platform: "desktop",
      name: "test",
    }),
    peer: new SourceClient(world.transport),
    hostId: () => HOST_ID,
    hostLabel: () => "this-mac",
    log: { info: log, warn: log },
  });
  service.ensureLocal();
});

afterEach(() => {
  opened.close();
});

const pairLink = `${GATEWAY}/#pair=ticket-1&fp=${GATEWAY_FP}`;

async function addRemote() {
  return service.remoteAdd({
    kind: "personal",
    issuer: ISSUER,
    account: ACCOUNT,
    password: PASSWORD,
    fingerprint: RELAY_FP,
  });
}

describe("配对链接", () => {
  it("网页链接与深链都认", () => {
    expect(parsePairLink(pairLink)).toEqual({
      origin: GATEWAY,
      ticket: "ticket-1",
      fingerprint: GATEWAY_FP,
    });
    expect(
      parsePairLink(
        `armadra://pair?host=gw.test%3A8443&ticket=ticket-1&fp=${GATEWAY_FP}`,
      ),
    ).toEqual({ origin: GATEWAY, ticket: "ticket-1", fingerprint: GATEWAY_FP });
    expect(() => parsePairLink("https://gw.test/")).toThrow();
    expect(() => parsePairLink("http://192.168.1.2/#pair=x")).toThrow();
  });
});

describe("直连源", () => {
  it("addDirect：代页面配对，刷新令牌进 SecretStore，答案里没有", async () => {
    const added = await service.addDirect({ pairLink });
    expect(added).toMatchObject({
      sourceId: PEER_ID,
      kind: "direct",
      baseUrl: GATEWAY,
      fingerprint: GATEWAY_FP,
      hasCredentials: true,
    });
    const stored = JSON.parse(
      backend.values.get(`armadra-source-${PEER_ID}`) ?? "{}",
    ) as { byOrigin: Record<string, { refreshToken: string }> };
    expect(stored.byOrigin[GATEWAY]?.refreshToken).toMatch(/^refresh-/);
    expect(JSON.stringify(added)).not.toContain("refresh");
    // 行里也没有：表里一个令牌都不存。
    const row = opened.database
      .prepare("SELECT * FROM client_sources WHERE source_id = ?")
      .get(PEER_ID);
    expect(JSON.stringify(row)).not.toContain("secret");
  });

  it("地址加配对码：先换票再配对", async () => {
    const added = await service.addDirect({
      origin: GATEWAY,
      code: "ABCD-2345",
      fingerprint: GATEWAY_FP,
    });
    expect(added.sourceId).toBe(PEER_ID);
    expect(
      await code(
        service.addDirect({
          origin: GATEWAY,
          code: "WRONG-0000",
          fingerprint: GATEWAY_FP,
        }),
      ),
    ).toBe("source_unauthorized");
  });

  it("指纹不符拒绝：给定的与链接里的不一样，或对端不是那张证书", async () => {
    expect(
      await code(service.addDirect({ pairLink, fingerprint: "c".repeat(64) })),
    ).toBe("fingerprint_mismatch");
    expect(
      await code(
        service.addDirect({
          pairLink: `${GATEWAY}/#pair=ticket-1&fp=${"c".repeat(64)}`,
        }),
      ),
    ).toBe("fingerprint_mismatch");
    expect((await service.list()).sources).toHaveLength(1);
  });

  it("票不对是 source_unauthorized；配到本机是 conflict", async () => {
    expect(
      await code(
        service.addDirect({
          pairLink: `${GATEWAY}/#pair=nope&fp=${GATEWAY_FP}`,
        }),
      ),
    ).toBe("source_unauthorized");
    world.cores.get(GATEWAY)!.tickets.add("ticket-2");
    (world.cores.get(GATEWAY) as { hostId: string }).hostId = HOST_ID;
    expect(
      await code(
        service.addDirect({
          pairLink: `${GATEWAY}/#pair=ticket-2&fp=${GATEWAY_FP}`,
        }),
      ),
    ).toBe("conflict");
  });

  it("session：每次旋转刷新令牌并写回，last_ok 跟着走", async () => {
    await service.addDirect({ pairLink });
    const before = backend.values.get(`armadra-source-${PEER_ID}`);
    const first = await service.session(PEER_ID);
    expect(first).toMatchObject({
      via: "direct",
      httpBase: GATEWAY,
      wsBase: "wss://gw.test:8443",
    });
    expect(first.accessToken).toMatch(/^core-access-/);
    const after = backend.values.get(`armadra-source-${PEER_ID}`);
    expect(after).not.toBe(before);
    // 再换一次用的是新令牌：旧的再出现会撤销整台设备。
    expect((await service.session(PEER_ID)).via).toBe("direct");
    // 并发两次也不会把自己登出。
    const both = await Promise.all([
      service.session(PEER_ID),
      service.session(PEER_ID),
    ]);
    expect(both.map((one) => one.via)).toEqual(["direct", "direct"]);
  });

  it("forget 只删凭据；remove 删行；本机行两样都不行", async () => {
    await service.addDirect({ pairLink });
    await service.forget(PEER_ID);
    expect(backend.values.has(`armadra-source-${PEER_ID}`)).toBe(false);
    const listed = await service.list();
    expect(
      listed.sources.find((one) => one.sourceId === PEER_ID),
    ).toMatchObject({
      hasCredentials: false,
    });
    expect(await code(service.session(PEER_ID))).toBe("source_unauthorized");
    await service.remove(PEER_ID);
    expect(await code(service.remove(PEER_ID))).toBe("not_found");
    expect(await code(service.remove(HOST_ID))).toBe("conflict");
    expect(await code(service.forget(HOST_ID))).toBe("conflict");
    expect(await code(service.session(HOST_ID))).toBe("conflict");
  });

  it("update：改名、排序与地址；本机不收地址", async () => {
    await service.addDirect({ pairLink });
    const updated = await service.update({
      sourceId: PEER_ID,
      label: "laptop",
      orderIndex: 5,
    });
    expect(updated).toMatchObject({ label: "laptop", orderIndex: 5 });
    expect(
      await code(service.update({ sourceId: HOST_ID, baseUrl: GATEWAY })),
    ).toBe("bad_request");
    for (const label of ["", "   ", "x".repeat(129)]) {
      expect(await code(service.update({ sourceId: PEER_ID, label }))).toBe(
        "bad_request",
      );
    }
    expect(
      await code(service.update({ sourceId: "9".repeat(32), label: "x" })),
    ).toBe("not_found");
    expect(
      await code(
        service.update({ sourceId: PEER_ID, baseUrl: "http://192.168.1.2" }),
      ),
    ).toBe("bad_request");
  });
});

describe("远程服务（个人中转）", () => {
  it("remoteAdd：登录成功，刷新令牌进 SecretStore，口令哪儿都不留", async () => {
    const added = await addRemote();
    expect(added.next).toBe("ready");
    expect(added.remote).toMatchObject({
      kind: "personal",
      issuer: ISSUER,
      accountHint: ACCOUNT,
      fingerprint: RELAY_FP,
      registered: false,
      hasCredentials: true,
    });
    const stored = backend.values.get(
      `armadra-remote-${added.remote.serviceId}`,
    );
    expect(stored).toContain("refresh-");
    expect(stored).not.toContain(PASSWORD);
    const text = JSON.stringify([added, await service.list()]);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toMatch(/refresh-|cloud-access-/);
    expect(logs.join("\n")).not.toContain(PASSWORD);
    expect(logs.join("\n")).not.toMatch(/secret/);
    expect(
      JSON.stringify(
        opened.database.prepare("SELECT * FROM remote_services").all(),
      ),
    ).not.toMatch(/secret|horse/);
  });

  it("口令错、锁定、指纹不符、地址不通：各自的码", async () => {
    expect(
      await code(
        service.remoteAdd({
          kind: "personal",
          issuer: ISSUER,
          account: ACCOUNT,
          password: "wrong",
          fingerprint: RELAY_FP,
        }),
      ),
    ).toBe("credentials_invalid");
    world.cloud.locked = true;
    const locked = await service
      .remoteAdd({
        kind: "personal",
        issuer: ISSUER,
        account: ACCOUNT,
        password: PASSWORD,
        fingerprint: RELAY_FP,
      })
      .catch((error: unknown) => error);
    expect(locked).toBeInstanceOf(CoreFailure);
    expect((locked as CoreFailure).code).toBe("account_locked");
    expect((locked as CoreFailure).details).toEqual({ retryAfterMs: 60_000 });
    world.cloud.locked = false;
    expect(
      await code(
        service.remoteAdd({
          kind: "personal",
          issuer: ISSUER,
          account: ACCOUNT,
          password: PASSWORD,
          fingerprint: "c".repeat(64),
        }),
      ),
    ).toBe("fingerprint_mismatch");
    world.down.add(ISSUER);
    expect(await code(addRemote())).toBe("source_unreachable");
    expect((await service.list()).remotes).toEqual([]);
  });

  it("SaaS 只预留：加入与轮询答 not_implemented", async () => {
    expect(
      await code(
        service.remoteAdd({ kind: "saas", issuer: "https://cloud.test" }),
      ),
    ).toBe("not_implemented");
    const { remote } = await addRemote();
    expect(await code(service.remoteDevicePoll(remote.serviceId))).toBe(
      "not_implemented",
    );
    expect(await code(service.remoteDevicePoll("9".repeat(32)))).toBe(
      "not_found",
    );
  });

  it("同一个 issuer 再加一次是重新登录，不多一行", async () => {
    const one = await addRemote();
    const two = await addRemote();
    expect(two.remote.serviceId).toBe(one.remote.serviceId);
    expect((await service.list()).remotes).toHaveLength(1);
  });

  it("remoteSession：访问令牌与能力；缓存期内不再换", async () => {
    const { remote } = await addRemote();
    const session = await service.remoteSession(remote.serviceId);
    expect(session.issuer).toBe(ISSUER);
    expect(session.capabilities).toContain("links.source-invite");
    const refreshes = world.requests.filter((one) =>
      one.url.endsWith("/v1/auth/refresh"),
    ).length;
    await service.remoteSession(remote.serviceId);
    expect(
      world.requests.filter((one) => one.url.endsWith("/v1/auth/refresh")),
    ).toHaveLength(refreshes);
  });

  it("remoteRemove：远程服务不可达也删得掉（尽力登出）", async () => {
    const { remote } = await addRemote();
    world.down.add(ISSUER);
    await service.remoteRemove(remote.serviceId);
    expect((await service.list()).remotes).toEqual([]);
    expect(backend.values.has(`armadra-remote-${remote.serviceId}`)).toBe(
      false,
    );
  });
});

describe("挂载（经中继）", () => {
  it("remoteSources → mount → session 全流程", async () => {
    const { remote } = await addRemote();
    const listed = await service.remoteSources(remote.serviceId);
    expect(listed.sources.map((one) => [one.sourceId, one.mounted])).toEqual([
      [RELAYED_ID, false],
      [PEER_ID, false],
    ]);
    const mounted = await service.mount({
      serviceId: remote.serviceId,
      sourceId: RELAYED_ID,
    });
    expect(mounted).toMatchObject({
      sourceId: RELAYED_ID,
      kind: "relayed",
      label: "studio",
      cloudIssuer: ISSUER,
      relayOrigin: ISSUER,
      principalHint: ACCOUNT,
      hasCredentials: true,
    });
    expect(
      (await service.remoteSources(remote.serviceId)).sources.find(
        (one) => one.sourceId === RELAYED_ID,
      )?.mounted,
    ).toBe(true);
    const session = await service.session(RELAYED_ID);
    expect(session).toMatchObject({
      via: "relayed",
      httpBase: `${ISSUER}/s/${RELAYED_ID}`,
      wsBase: `wss://relay.test/s/${RELAYED_ID}`,
    });
    expect(session.relayToken).toMatch(/^relay-/);
    expect(session.relayTokenExpiresAtMs).toBeGreaterThan(Date.now());
    // 换票用的是存着的刷新令牌，不是又一次 cloud/login。
    expect(world.cores.get(`${ISSUER}/s/${RELAYED_ID}`)?.cloudLogins).toBe(1);
  });

  it("刷新失败（401）回退到断言重新 cloud/login，写回新令牌", async () => {
    const { remote } = await addRemote();
    await service.mount({ serviceId: remote.serviceId, sourceId: RELAYED_ID });
    const core = world.cores.get(`${ISSUER}/s/${RELAYED_ID}`)!;
    core.sessions.revokeAll();
    const before = backend.values.get(`armadra-source-${RELAYED_ID}`);
    const session = await service.session(RELAYED_ID);
    expect(session.via).toBe("relayed");
    expect(core.cloudLogins).toBe(2);
    expect(backend.values.get(`armadra-source-${RELAYED_ID}`)).not.toBe(before);
  });

  it("远程服务的会话也失效 → source_unauthorized，凭据清掉", async () => {
    const { remote } = await addRemote();
    await service.mount({ serviceId: remote.serviceId, sourceId: RELAYED_ID });
    // 新开一个服务实例（内存里的访问令牌没了），远程服务的刷新令牌被撤销。
    world.cloud.sessions.revokeAll();
    const fresh = new SourcesService({
      store: new SourcesStore(opened.database),
      secrets: new SourceSecrets(() => backend),
      remote: new RemoteClient(world.transport, {
        platform: "desktop",
        name: "t",
      }),
      peer: new SourceClient(world.transport),
      hostId: () => HOST_ID,
      hostLabel: () => "this-mac",
      log: { info: () => undefined, warn: () => undefined },
    });
    world.cores.get(`${ISSUER}/s/${RELAYED_ID}`)!.sessions.revokeAll();
    expect(await code(fresh.session(RELAYED_ID))).toBe("source_unauthorized");
    expect(backend.values.has(`armadra-remote-${remote.serviceId}`)).toBe(
      false,
    );
  });

  it("源不在线 → source_offline；源拒绝映射凭据 → 透传 cloud_account_unlinked", async () => {
    const { remote } = await addRemote();
    world.cloud.online = false;
    expect(
      await code(
        service.mount({ serviceId: remote.serviceId, sourceId: RELAYED_ID }),
      ),
    ).toBe("source_offline");
    world.cloud.online = true;
    world.cores.get(`${ISSUER}/s/${RELAYED_ID}`)!.refuseCloudLogin =
      "cloud_account_unlinked";
    expect(
      await code(
        service.mount({ serviceId: remote.serviceId, sourceId: RELAYED_ID }),
      ),
    ).toBe("cloud_account_unlinked");
    expect(
      await code(
        service.mount({ serviceId: remote.serviceId, sourceId: HOST_ID }),
      ),
    ).toBe("conflict");
  });
});

describe("凭据不出现在任何答案里", () => {
  it("把每一个答案的 JSON 扫一遍：没有 refreshToken / password 键，没有令牌值", async () => {
    const answers: unknown[] = [];
    const keep = async <T>(work: Promise<T>) => {
      const value = await work;
      answers.push(value);
      return value;
    };
    await keep(service.addDirect({ pairLink }));
    const { remote } = await keep(addRemote());
    await keep(service.remoteSources(remote.serviceId));
    await keep(
      service.mount({ serviceId: remote.serviceId, sourceId: RELAYED_ID }),
    );
    await keep(service.list());
    await keep(service.update({ sourceId: PEER_ID, label: "renamed" }));

    const text = JSON.stringify(answers);
    expect(text).not.toMatch(/"refreshToken"|"password"/);
    expect(text).not.toContain(PASSWORD);
    // 存着的每一个刷新令牌都不在答案里。
    for (const value of backend.values.values()) {
      for (const refresh of value.match(/refresh-[\w-]+/g) ?? []) {
        expect(text).not.toContain(refresh);
      }
    }
    expect(logs.join("\n")).not.toMatch(/refresh-|secret|horse/);
  });
});
