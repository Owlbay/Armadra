import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openFreshDatabase } from "../db/fresh.fixture";
import type { OpenedDatabase } from "../db/open";
import { CoreFailure } from "../http/errors";
import { tempDir } from "../testing/temp-dir";
import { migrationsDir } from "../workspaces/fixture";
import {
  ACCOUNT,
  CHALLENGE_TOKEN,
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
    expect(
      await code(service.update({ sourceId: PEER_ID, label: "x".repeat(129) })),
    ).toBe("bad_request");
    // 空名不再是错误：恢复成缺省名（契约 §61，见 naming.test.ts）。
    expect(
      await service.update({ sourceId: PEER_ID, label: "   " }),
    ).toMatchObject({ label: new URL(GATEWAY).host });
    expect(
      await code(service.update({ sourceId: "9".repeat(32), label: "x" })),
    ).toBe("not_found");
    expect(
      await code(
        service.update({ sourceId: PEER_ID, baseUrl: "http://192.168.1.2" }),
      ),
    ).toBe("address_plaintext_loopback_only");
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

  describe("挑战令牌（契约 §62）", () => {
    const base = {
      kind: "personal" as const,
      issuer: ISSUER,
      account: ACCOUNT,
      password: PASSWORD,
      fingerprint: RELAY_FP,
    };

    it("中继不要求挑战：不带令牌照常登录，请求里也没有 challenge", async () => {
      await addRemote();
      const login = world.requests.find((one) =>
        one.url.endsWith("/v1/auth/login"),
      );
      expect(JSON.stringify(login)).not.toContain("challenge");
    });

    it("要求而没带：不发口令，challenge_required 带 siteKey", async () => {
      world.cloud.challenge = { siteKey: "0xSITE", scope: ["auth.login"] };
      const failure = await service
        .remoteAdd(base)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CoreFailure);
      expect((failure as CoreFailure).code).toBe("challenge_required");
      expect((failure as CoreFailure).details).toEqual({
        provider: "turnstile",
        siteKey: "0xSITE",
      });
      expect(
        world.requests.some((one) => one.url.endsWith("/v1/auth/login")),
      ).toBe(false);
      expect((await service.list()).remotes).toEqual([]);
    });

    it("带令牌：放进 auth.login 的 challenge，登录成功", async () => {
      world.cloud.challenge = { siteKey: "0xSITE", scope: ["auth.login"] };
      const added = await service.remoteAdd({
        ...base,
        challengeToken: CHALLENGE_TOKEN,
      });
      expect(added.next).toBe("ready");
      const login = world.requests.find((one) =>
        one.url.endsWith("/v1/auth/login"),
      );
      expect(JSON.stringify(login)).toContain(CHALLENGE_TOKEN);
      expect(logs.join("\n")).not.toContain(CHALLENGE_TOKEN);
    });

    it("令牌无效：对端的 challenge_invalid 原样映射", async () => {
      world.cloud.challenge = { siteKey: "0xSITE", scope: ["auth.login"] };
      expect(
        await code(service.remoteAdd({ ...base, challengeToken: "stale" })),
      ).toBe("challenge_invalid");
    });

    it("scope 不含 auth.login：不挑战", async () => {
      world.cloud.challenge = { siteKey: "0xSITE", scope: ["links.accept"] };
      expect((await service.remoteAdd(base)).next).toBe("ready");
    });
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

describe("本机登记到远程服务（契约 §31）", () => {
  it("registered 跟着登记表；删远程服务之前先撤销登记", async () => {
    const registered = new Set<string>();
    const revoked: string[] = [];
    const removed: unknown[] = [];
    const cloud = {
      registered: (issuer: string) => registered.has(issuer),
      // 真的云登录域在撤销里用这份会话删中继侧的源记录（§31.4）：删远程服务时
      // 它必须还在。
      revoke: async ({ issuer }: { issuer: string }) => {
        revoked.push(issuer);
        registered.delete(issuer);
        await service.removeRelaySource(issuer, RELAYED_ID);
        removed.push(world.cloud.sources.map((one) => one.sourceId));
        return {};
      },
    };
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
      log: { info: () => undefined, warn: () => undefined },
      cloud: () => cloud,
    });
    const { remote } = await addRemote();
    expect(remote.registered).toBe(false);
    registered.add(ISSUER);
    expect((await service.list()).remotes[0]?.registered).toBe(true);
    await service.remoteRemove(remote.serviceId);
    expect(revoked).toEqual([ISSUER]);
    expect(removed).toEqual([[PEER_ID]]);
    expect((await service.list()).remotes).toEqual([]);
  });

  it("removeRelaySource：owner 会话删中继侧的源；中继上已经没有也算删掉", async () => {
    await addRemote();
    await service.removeRelaySource(ISSUER, RELAYED_ID);
    expect(world.cloud.sources.map((one) => one.sourceId)).toEqual([PEER_ID]);
    const deletes = world.requests.filter((one) => one.method === "DELETE");
    expect(deletes.map((one) => one.url)).toEqual([
      `${ISSUER}/v1/sources/${RELAYED_ID}`,
    ]);
    expect(deletes[0]?.headers?.authorization).toMatch(/^Bearer /);
    await expect(
      service.removeRelaySource(ISSUER, RELAYED_ID),
    ).resolves.toBeUndefined();
  });

  it("removeRelaySource：没有远程服务、没有登录、连不上各答对应的码", async () => {
    await expect(
      service.removeRelaySource(ISSUER, RELAYED_ID),
    ).rejects.toMatchObject({ code: "source_unauthorized" });
    const { remote } = await addRemote();
    await service.remoteLogout(remote.serviceId);
    await expect(
      service.removeRelaySource(ISSUER, RELAYED_ID),
    ).rejects.toMatchObject({ code: "source_unauthorized" });
    await service.remoteRemove(remote.serviceId);
    await addRemote();
    // 访问令牌缓存着，连不上发生在删除这一步。
    world.down.add(ISSUER);
    await expect(
      service.removeRelaySource(ISSUER, RELAYED_ID),
    ).rejects.toMatchObject({ code: "source_unreachable" });
    expect(world.cloud.sources).toHaveLength(2);
  });

  it("没登记的远程服务：删的时候不碰登记", async () => {
    const { remote } = await addRemote();
    await service.remoteRemove(remote.serviceId);
    expect((await service.list()).remotes).toEqual([]);
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

describe("契约 §33.6：登出与首次指纹", () => {
  function withProbe(probe: (origin: string) => Promise<string | null>) {
    const probed: string[] = [];
    const next = new SourcesService({
      store: new SourcesStore(opened.database),
      secrets: new SourceSecrets(() => backend),
      remote: new RemoteClient(world.transport, {
        platform: "desktop",
        name: "test",
      }),
      peer: new SourceClient(world.transport),
      hostId: () => HOST_ID,
      hostLabel: () => "this-mac",
      log: { info: () => undefined, warn: () => undefined },
      anchorProbe: (origin) => {
        probed.push(origin);
        return probe(origin);
      },
    });
    return { service: next, probed };
  }

  it("没给指纹、系统不信任：答 fingerprint_mismatch 并带对端的指纹", async () => {
    const { service: probing, probed } = withProbe(async () => RELAY_FP);
    world.down.add(ISSUER);
    const refused = await probing
      .remoteAdd({
        kind: "personal",
        issuer: ISSUER,
        account: ACCOUNT,
        password: PASSWORD,
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CoreFailure);
    expect((refused as CoreFailure).code).toBe("fingerprint_mismatch");
    expect((refused as CoreFailure).details).toEqual({ fingerprint: RELAY_FP });
    expect(probed).toEqual([ISSUER]);
    // 口令没有因为这次探测多发一次。
    expect(
      world.requests.filter((one) => one.url.endsWith("/v1/auth/login")),
    ).toHaveLength(0);
    expect((await probing.list()).remotes).toEqual([]);
  });

  it("给了指纹、或系统信任（探不出锚）：原样透传，不改写", async () => {
    const { service: probing, probed } = withProbe(async () => null);
    world.down.add(ISSUER);
    expect(
      await code(
        probing.remoteAdd({
          kind: "personal",
          issuer: ISSUER,
          account: ACCOUNT,
          password: PASSWORD,
        }),
      ),
    ).toBe("source_unreachable");
    expect(
      await code(
        probing.remoteAdd({
          kind: "personal",
          issuer: ISSUER,
          account: ACCOUNT,
          password: PASSWORD,
          fingerprint: RELAY_FP,
        }),
      ),
    ).toBe("source_unreachable");
    expect(probed).toEqual([ISSUER]);
  });

  it("地址加配对码同样先问指纹", async () => {
    const { service: probing } = withProbe(async () => GATEWAY_FP);
    world.down.add(GATEWAY);
    const refused = await probing
      .addDirect({ origin: GATEWAY, code: "ABCD-2345" })
      .catch((error: unknown) => error);
    expect((refused as CoreFailure).code).toBe("fingerprint_mismatch");
    expect((refused as CoreFailure).details).toEqual({
      fingerprint: GATEWAY_FP,
    });
  });

  it("remoteLogout：登出、删凭据、留行；再输口令即重新登录", async () => {
    const { remote } = await addRemote();
    await service.remoteSession(remote.serviceId);
    await service.remoteLogout(remote.serviceId);
    expect(
      world.requests.some((one) => one.url.endsWith("/v1/auth/logout")),
    ).toBe(true);
    const listed = (await service.list()).remotes;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      serviceId: remote.serviceId,
      fingerprint: RELAY_FP,
      hasCredentials: false,
    });
    expect(backend.values.has(`armadra-remote-${remote.serviceId}`)).toBe(
      false,
    );
    expect(await code(service.remoteSession(remote.serviceId))).toBe(
      "source_unauthorized",
    );
    const again = await addRemote();
    expect(again.remote).toMatchObject({
      serviceId: remote.serviceId,
      hasCredentials: true,
    });
    expect(await code(service.remoteLogout("9".repeat(32)))).toBe("not_found");
  });
});

describe("契约 §33.7：按分享链接挂载", () => {
  const LINK_ID = "0123456789abcdef";
  const SECRET = "S".repeat(43);
  const INVITE = `${"c".repeat(32)}.${"I".repeat(43)}`;
  const url = `${ISSUER}/j/${LINK_ID}#${SECRET}.${INVITE}`;

  function share(state: "ok" | "expired" | "exhausted" | "revoked" = "ok") {
    world.cloud.links.set(LINK_ID, {
      secret: SECRET,
      sourceId: RELAYED_ID,
      state,
      uses: 0,
    });
  }

  it("accept → cloud/login 带邀请令牌 → 建访客远程服务与 relayed 行；凭据只在 SecretStore", async () => {
    share();
    const mounted = await service.mountByLink({ url, fingerprint: RELAY_FP });
    expect(mounted).toMatchObject({
      sourceId: RELAYED_ID,
      kind: "relayed",
      label: "studio",
      relayOrigin: ISSUER,
      cloudIssuer: ISSUER,
      hasCredentials: true,
    });
    const core = world.cores.get(`${ISSUER}/s/${RELAYED_ID}`)!;
    expect(core.lastInvitation).toBe(INVITE);
    const { remotes } = await service.list();
    expect(remotes).toHaveLength(1);
    expect(remotes[0]).toMatchObject({
      issuer: ISSUER,
      accountHint: "",
      fingerprint: RELAY_FP,
      hasCredentials: true,
    });
    // 之后换票走访客会话取断言，再经中继换源会话。
    const session = await service.session(RELAYED_ID, "relayed");
    expect(session.httpBase).toBe(`${ISSUER}/s/${RELAYED_ID}`);
    // 秘密与邀请令牌不进 SecretStore、不进日志、不进答案。
    const stored = [...backend.values.values()].join("\n");
    for (const secret of [SECRET, INVITE]) {
      expect(stored).not.toContain(secret);
      expect(logs.join("\n")).not.toContain(secret);
      expect(JSON.stringify(mounted)).not.toContain(secret);
    }
  });

  it("深链 armadra://join 同样认", async () => {
    share();
    const deep = `armadra://join?link=${LINK_ID}&issuer=${encodeURIComponent(ISSUER)}&s=${encodeURIComponent(`${SECRET}.${INVITE}`)}`;
    expect(
      (await service.mountByLink({ url: deep, fingerprint: RELAY_FP }))
        .sourceId,
    ).toBe(RELAYED_ID);
  });

  it("已用账号登录的远程服务：沿用它的指纹与凭据，访客会话登出", async () => {
    const { remote } = await addRemote();
    share();
    await service.mountByLink({ url });
    const { remotes } = await service.list();
    expect(remotes).toHaveLength(1);
    expect(remotes[0]).toMatchObject({
      serviceId: remote.serviceId,
      accountHint: ACCOUNT,
    });
    expect(
      world.requests.filter((one) => one.url.endsWith("/v1/auth/logout")),
    ).toHaveLength(1);
  });

  it("过期、用尽、撤销、秘密不对：各自的码，什么也不留", async () => {
    for (const [state, expected] of [
      ["expired", "link_expired"],
      ["exhausted", "link_exhausted"],
      ["revoked", "link_invalid"],
    ] as const) {
      share(state);
      expect(
        await code(service.mountByLink({ url, fingerprint: RELAY_FP })),
      ).toBe(expected);
    }
    share();
    const wrong = `${ISSUER}/j/${LINK_ID}#${"x".repeat(43)}.${INVITE}`;
    expect(
      await code(service.mountByLink({ url: wrong, fingerprint: RELAY_FP })),
    ).toBe("link_secret_invalid");
    const listed = await service.list();
    expect(listed.remotes).toEqual([]);
    expect(listed.sources.map((one) => one.kind)).toEqual(["local"]);
  });

  it("指纹不符、邀请被拒、不是链接、链到本机", async () => {
    share();
    expect(
      await code(service.mountByLink({ url, fingerprint: "d".repeat(64) })),
    ).toBe("fingerprint_mismatch");
    world.cores.get(`${ISSUER}/s/${RELAYED_ID}`)!.refuseCloudLogin =
      "invitation_invalid";
    expect(
      await code(service.mountByLink({ url, fingerprint: RELAY_FP })),
    ).toBe("invitation_invalid");
    expect(
      await code(service.mountByLink({ url: "https://relay.test/app/" })),
    ).toBe("bad_request");
    world.cloud.links.set(LINK_ID, {
      secret: SECRET,
      sourceId: HOST_ID,
      state: "ok",
      uses: 0,
    });
    expect(
      await code(service.mountByLink({ url, fingerprint: RELAY_FP })),
    ).toBe("conflict");
  });
});
