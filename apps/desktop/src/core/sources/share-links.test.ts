import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openFreshDatabase } from "../db/fresh.fixture";
import type { OpenedDatabase } from "../db/open";
import { CoreFailure } from "../http/errors";
import { IdentityError } from "../identity/errors";
import { tempDir } from "../testing/temp-dir";
import { migrationsDir } from "../workspaces/fixture";
import {
  ACCOUNT,
  ISSUER,
  PASSWORD,
  RELAY_FP,
  type FakeWorld,
  fakeWorld,
  memoryBackend,
} from "./fake.fixture";
import { RemoteClient } from "./remote-client";
import { SourceSecrets, shareLinksSecretName } from "./secrets";
import { SourcesService } from "./service";
import { type ShareInvitations, ShareLinks } from "./share-links";
import { SourceClient } from "./source-client";
import { SourcesStore } from "./store";

/**
 * 分享链接的管理（契约 §33.9）对着假的个人中转：建、列、再取整条链接、撤销；
 * 整条链接只在 SecretStore，撤销、过期、用尽或远程服务上没了就删掉。
 */

const HOST_ID = "f".repeat(32);
const THIS_SOURCE = "9".repeat(32);
const DAY = 86_400_000;

let opened: OpenedDatabase;
let world: FakeWorld;
let backend: ReturnType<typeof memoryBackend>;
let service: SourcesService;
let links: ShareLinks;
let logs: string[];
let registered: boolean;
let issued: { invitationId: string; maxUses: number; ttlMs: number }[];
let revoked: string[];
let serviceId: string;

function code(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "resolved",
    (error: unknown) =>
      error instanceof CoreFailure ? error.code : String(error),
  );
}

beforeEach(async () => {
  const directory = tempDir("armadra-share-links-");
  opened = openFreshDatabase(join(directory, "canvas.db"), migrationsDir());
  world = fakeWorld();
  backend = memoryBackend();
  logs = [];
  registered = true;
  issued = [];
  revoked = [];
  const log = (message: string, fields?: Record<string, unknown>) =>
    logs.push(`${message} ${JSON.stringify(fields ?? {})}`);
  const secrets = new SourceSecrets(() => backend);
  const remote = new RemoteClient(world.transport, {
    platform: "desktop",
    name: "test",
  });
  service = new SourcesService({
    store: new SourcesStore(opened.database),
    secrets,
    remote,
    peer: new SourceClient(world.transport),
    hostId: () => HOST_ID,
    hostLabel: () => "this-mac",
    log: { info: log, warn: log },
  });
  service.ensureLocal();
  const invitations: ShareInvitations = {
    issue(input) {
      if (input.role === "nobody") throw new IdentityError("invalid");
      const invitationId = `inv${issued.length}`.padEnd(32, "0");
      issued.push({ invitationId, maxUses: input.maxUses, ttlMs: input.ttlMs });
      return {
        invitationId,
        token: `${invitationId}.INVITE${issued.length}`,
        expiresAtMs: Date.now() + input.ttlMs,
      };
    },
    revoke(invitationId) {
      revoked.push(invitationId);
    },
  };
  links = new ShareLinks({
    secrets,
    remote,
    access: (id) => service.remoteEndpoint(id),
    issuerOf: (id) => service.remoteIssuer(id),
    registrations: () => ({
      registered: (issuer) => registered && issuer === ISSUER,
      sourceId: async () => THIS_SOURCE,
    }),
    invitations: () => invitations,
    log: { info: log, warn: log },
  });
  const added = await service.remoteAdd({
    kind: "personal",
    issuer: ISSUER,
    account: ACCOUNT,
    password: PASSWORD,
    fingerprint: RELAY_FP,
  });
  serviceId = added.remote.serviceId;
});

afterEach(() => {
  opened.close();
});

function create(overrides: Partial<Parameters<ShareLinks["create"]>[0]> = {}) {
  return links.create({
    serviceId,
    workspaceId: "ws-1",
    role: "viewer",
    ttlMs: 7 * DAY,
    maxUses: 1000,
    label: "评审",
    ...overrides,
  });
}

describe("契约 §33.9：分享链接", () => {
  it("create：签邀请、建链接，整条链接带片段，存进 SecretStore", async () => {
    const created = await create();
    const [invitation] = issued;
    expect(invitation?.maxUses).toBe(1000);
    const relay = world.cloud.links.get(created.link.linkId);
    expect(relay).toMatchObject({
      sourceId: THIS_SOURCE,
      label: "评审",
      role: "viewer",
      maxUses: 1000,
      invitationId: invitation?.invitationId,
    });
    expect(created.url).toBe(
      `${ISSUER}/j/${created.link.linkId}#${relay?.secret}.${invitation?.invitationId}.INVITE1`,
    );
    expect(created.link).toMatchObject({
      state: "active",
      copyable: true,
      workspaceId: "ws-1",
      uses: 0,
      maxUses: 1000,
    });
    const stored = backend.values.get(shareLinksSecretName(serviceId)) ?? "";
    expect(stored).toContain(created.url);
    // 整条链接不进日志。
    expect(logs.join("\n")).not.toContain(relay?.secret ?? "?");
    expect(logs.join("\n")).not.toContain("INVITE1");
  });

  it("list：生效的可再复制，链接可多次使用；url 随时再取", async () => {
    const created = await create();
    const relay = world.cloud.links.get(created.link.linkId);
    if (relay === undefined) throw new Error("link");
    relay.uses = 2;
    const { links: listed } = await links.list(serviceId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      linkId: created.link.linkId,
      label: "评审",
      workspaceId: "ws-1",
      uses: 2,
      maxUses: 1000,
      state: "active",
      copyable: true,
    });
    // 列表里没有整条链接。
    expect(JSON.stringify(listed)).not.toContain(relay.secret);
    expect(await links.url(serviceId, created.link.linkId)).toEqual({
      url: created.url,
    });
    expect(await links.url(serviceId, created.link.linkId)).toEqual({
      url: created.url,
    });
  });

  it("过期、用尽、远程服务那边撤销或删掉了：列成历史，存着的整条链接删掉", async () => {
    const a = await create({ label: "a" });
    const b = await create({ label: "b" });
    const c = await create({ label: "c" });
    const d = await create({ label: "d" });
    const e = await create({ label: "e" });
    const set = (
      linkId: string,
      state: "expired" | "exhausted" | "revoked",
    ) => {
      const link = world.cloud.links.get(linkId);
      if (link) link.state = state;
    };
    set(a.link.linkId, "expired");
    set(b.link.linkId, "exhausted");
    set(c.link.linkId, "revoked");
    world.cloud.links.delete(d.link.linkId);
    const { links: listed } = await links.list(serviceId);
    const state = Object.fromEntries(
      listed.map((one) => [one.linkId, [one.state, one.copyable]]),
    );
    expect(state).toEqual({
      [a.link.linkId]: ["expired", false],
      [b.link.linkId]: ["exhausted", false],
      [c.link.linkId]: ["revoked", false],
      [e.link.linkId]: ["active", true],
    });
    // 远程服务那边撤销的：本机的邀请一并作废。
    expect(revoked).toEqual([issued[2]?.invitationId]);
    for (const gone of [a, b, c, d]) {
      expect(await code(links.url(serviceId, gone.link.linkId))).toBe(
        "not_found",
      );
    }
    const stored = backend.values.get(shareLinksSecretName(serviceId)) ?? "";
    expect(stored).toContain(e.url);
    expect(stored).not.toContain(a.url);
  });

  it("revoke：远程服务撤链接、邀请作废、整条链接删掉；再撤一次也成功", async () => {
    const created = await create();
    await links.revoke(serviceId, created.link.linkId);
    expect(world.cloud.links.get(created.link.linkId)?.state).toBe("revoked");
    expect(revoked).toEqual([issued[0]?.invitationId]);
    expect(await code(links.url(serviceId, created.link.linkId))).toBe(
      "not_found",
    );
    expect(backend.values.has(shareLinksSecretName(serviceId))).toBe(false);
    expect(await code(links.revoke(serviceId, created.link.linkId))).toBe(
      "resolved",
    );
  });

  it("没登记到这个远程服务：建答 cloud_not_registered，列表为空并清掉存着的", async () => {
    await create();
    registered = false;
    expect(await code(create())).toBe("cloud_not_registered");
    expect(await links.list(serviceId)).toEqual({ links: [] });
    expect(backend.values.has(shareLinksSecretName(serviceId))).toBe(false);
  });

  it("远程服务建链接失败：刚签的邀请作废；邀请参数不对答 bad_request", async () => {
    world.down.add(`${ISSUER}/v1/links`);
    expect(await code(create())).toBe("source_unreachable");
    expect(revoked).toEqual([issued[0]?.invitationId]);
    world.down.clear();
    expect(await code(create({ role: "nobody" }))).toBe("bad_request");
  });

  it("有效期超过 30 天按 30 天减一分钟签；未知远程服务答 not_found", async () => {
    await create({ ttlMs: 30 * DAY });
    expect(issued[0]?.ttlMs).toBe(30 * DAY - 60_000);
    expect(await code(links.list("nope"))).toBe("not_found");
    expect(await code(links.url("nope", "abc"))).toBe("not_found");
  });

  it("删远程服务：存着的整条链接一并删掉", async () => {
    await create();
    expect(backend.values.has(shareLinksSecretName(serviceId))).toBe(true);
    await service.remoteRemove(serviceId);
    expect(backend.values.has(shareLinksSecretName(serviceId))).toBe(false);
  });
});
