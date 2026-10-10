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
let issued: {
  invitationId: string;
  maxUses: number;
  ttlMs: number;
  role: string;
  targetWorkspaceId: string;
  targetSessionId?: string;
  targetHost?: boolean;
}[];
let revoked: string[];
let guestsDisabled: string[];
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
  guestsDisabled = [];
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
      issued.push({ ...input, invitationId });
      return {
        invitationId,
        token: `${invitationId}.INVITE${issued.length}`,
        expiresAtMs: Date.now() + input.ttlMs,
      };
    },
    revoke(invitationId) {
      revoked.push(invitationId);
    },
    disableGuests(issuer, linkId) {
      guestsDisabled.push(`${issuer} ${linkId}`);
      return 1;
    },
  };
  links = new ShareLinks({
    secrets,
    remote,
    access: (id) => service.remoteEndpoint(id),
    issuerOf: (id) => service.remoteIssuer(id),
    capabilities: (id, options) => service.remoteCapabilities(id, options),
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

describe("契约 §33.10：改链接备注", () => {
  it("只改远程服务上的备注（去首尾空白），答改过的链接；本机存着的整条链接不动", async () => {
    const created = await create();
    const answer = await links.updateLabel({
      serviceId,
      linkId: created.link.linkId,
      label: "  设计评审 ",
    });
    expect(answer.link).toMatchObject({
      linkId: created.link.linkId,
      label: "设计评审",
      workspaceId: "ws-1",
      state: "active",
      copyable: true,
    });
    expect(world.cloud.links.get(created.link.linkId)?.label).toBe("设计评审");
    const patch = world.requests.find((one) => one.method === "PATCH");
    expect(patch?.url).toBe(`${ISSUER}/v1/links/${created.link.linkId}`);
    expect(patch?.body).toEqual({ label: "设计评审" });
    expect(await links.url(serviceId, created.link.linkId)).toEqual({
      url: created.url,
    });
    // 撤销了的也能改，答历史状态、不可复制。
    await links.revoke(serviceId, created.link.linkId);
    const later = await links.updateLabel({
      serviceId,
      linkId: created.link.linkId,
      label: "",
    });
    expect(later.link).toMatchObject({
      label: "",
      state: "revoked",
      copyable: false,
    });
  });

  it("远程服务上没有答 not_found；未知远程服务答 not_found", async () => {
    expect(
      await code(
        links.updateLabel({ serviceId, linkId: "abcdef", label: "x" }),
      ),
    ).toBe("not_found");
    expect(
      await code(
        links.updateLabel({ serviceId: "nope", linkId: "a", label: "x" }),
      ),
    ).toBe("not_found");
  });

  it("远程服务不报 links.update：重问一次 platform.info，仍没有答 not_implemented、不发 PATCH；升级后就能改", async () => {
    const created = await create();
    world.cloud.capabilities = ["auth.password", "links.source-invite"];
    await service.remoteCapabilities(serviceId, { refresh: true });
    const infos = () =>
      world.requests.filter((one) =>
        one.url.endsWith("/.well-known/armadra-platform"),
      ).length;
    const before = infos();
    expect(
      await code(
        links.updateLabel({
          serviceId,
          linkId: created.link.linkId,
          label: "x",
        }),
      ),
    ).toBe("not_implemented");
    expect(infos()).toBe(before + 1);
    expect(world.requests.some((one) => one.method === "PATCH")).toBe(false);
    world.cloud.capabilities.push("links.update");
    expect(
      (
        await links.updateLabel({
          serviceId,
          linkId: created.link.linkId,
          label: "x",
        })
      ).link.label,
    ).toBe("x");
  });
});

describe("契约 §60：分享范围", () => {
  const sentScope = () =>
    [...world.requests]
      .reverse()
      .find((one) => one.method === "POST" && one.url.endsWith("/v1/links"));
  const bodyOf = (request: ReturnType<typeof sentScope>) =>
    (request?.body ?? {}) as Record<string, unknown>;

  it("工作空间只读：邀请压成 viewer，中继报 links.scope 时把范围交给它", async () => {
    const created = await create({ role: "editor", readOnly: true });
    expect(issued.at(-1)).toMatchObject({
      role: "viewer",
      targetWorkspaceId: "ws-1",
    });
    expect(bodyOf(sentScope()).scope).toEqual({
      workspaceId: "ws-1",
      readOnly: true,
    });
    expect(created.link).toMatchObject({
      role: "viewer",
      target: "workspace",
      readOnly: true,
    });
    const [listed] = (await links.list(serviceId)).links;
    expect(listed).toMatchObject({ target: "workspace", readOnly: true });
  });

  it("会话：邀请指向会话、总是只读；整台：邀请指向整台", async () => {
    const session = await create({
      target: "session",
      sessionId: "t1",
      role: "driver",
    });
    expect(issued.at(-1)).toMatchObject({
      role: "viewer",
      targetWorkspaceId: "ws-1",
      targetSessionId: "t1",
    });
    expect(bodyOf(sentScope()).scope).toEqual({
      workspaceId: "ws-1",
      sessionId: "t1",
      readOnly: true,
    });
    expect(session.link).toMatchObject({
      target: "session",
      sessionId: "t1",
      readOnly: true,
    });

    const host = await create({
      target: "host",
      workspaceId: "",
      role: "editor",
    });
    expect(issued.at(-1)).toMatchObject({
      role: "editor",
      targetWorkspaceId: "",
      targetHost: true,
    });
    // 整台可写没有范围可交：请求里不出现 scope（与旧版同形）。
    expect("scope" in bodyOf(sentScope())).toBe(false);
    expect(host.link).toMatchObject({ target: "host", workspaceId: "" });
  });

  it("中继不报 links.scope：不发 scope，范围照样落在本机邀请上", async () => {
    world.cloud.capabilities = ["auth.password", "links.source-invite"];
    await service.remoteCapabilities(serviceId, { refresh: true });
    const created = await create({ target: "session", sessionId: "t9" });
    expect("scope" in bodyOf(sentScope())).toBe(false);
    expect(issued.at(-1)).toMatchObject({ targetSessionId: "t9" });
    expect(created.link.target).toBe("session");
  });

  it("范围不合规答 bad_request，不签邀请", async () => {
    const before = issued.length;
    expect(await code(create({ target: "session" }))).toBe("bad_request");
    expect(await code(create({ workspaceId: "" }))).toBe("bad_request");
    expect(
      await code(create({ target: "host", workspaceId: "", sessionId: "t1" })),
    ).toBe("bad_request");
    expect(issued.length).toBe(before);
  });

  it("撤链接连同经它进来的访客一起停用", async () => {
    const created = await create();
    await links.revoke(serviceId, created.link.linkId);
    expect(guestsDisabled).toEqual([`${ISSUER} ${created.link.linkId}`]);
  });
});
