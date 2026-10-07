/**
 * 测试用：一台装了身份、云登录与隧道的临时 core，远程服务是 `identity/cloud` 的
 * 假个人中转（登记一侧）加上 {@link FakeTunnelRelay}（隧道一侧）。登记之后隧道
 * 自己连上假中继。
 *
 * 只有 `*.test.ts` import 它。
 */

import { createPublicKey } from "node:crypto";
import type { AddressInfo } from "node:net";

import { LIMITS } from "@armadra/platform-protocol/tunnel";

import { installContract } from "../http/rpc";
import { AccountsService } from "../identity/accounts";
import { Authorizer } from "../identity/authorize";
import {
  type FakeRelayWorld,
  ISSUER,
  REGISTRATION_TOKEN,
  fakeRelayWorld,
  memoryBackend,
} from "../identity/cloud/fake.fixture";
import { type CloudService, installCloud } from "../identity/cloud";
import { allScopes } from "../identity/scopes";
import { IdentityService } from "../identity/service";
import { IdentityStore } from "../identity/store";
import type { OutboundAnswer, Transport } from "../sources/http-client";
import { install as installEvents } from "../events";
import { install as installWorkspaces } from "../workspaces/routes";
import { type Fixture, fixture } from "../workspaces/fixture";
import { type FakeRelayOptions, FakeTunnelRelay } from "./fake-relay.fixture";
import { type RelayService, installRelay } from "./index";
import type { RelaySettings } from "./settings";

export { ISSUER };
export const INSTANCE = "0123456789abcdef0123456789abcdef";
export const LOOPBACK_ORIGIN = "http://127.0.0.1:1420";

export interface RelayCore {
  readonly core: Fixture;
  readonly world: FakeRelayWorld;
  readonly relay: FakeTunnelRelay;
  readonly cloud: CloudService;
  readonly tunnels: RelayService;
  readonly service: IdentityService;
  readonly store: IdentityStore;
  readonly accounts: AccountsService;
  /** 回环监听的地址。 */
  readonly base: string;
  /** `GET /v1/sources/me/relay` 的答案覆写（状态码 + 体），一直生效。 */
  hint: { status: number; body: Record<string, unknown> } | undefined;
  hintFetches: number;
  settings: RelaySettings;
  /** 登记（隧道随之起）。 */
  register(): Promise<void>;
  /** 一个绑在 `origin` 上的 owner 会话的访问令牌。 */
  session(origin: string): string;
  close(): Promise<void>;
}

export async function relayCore(
  options: {
    relay?: FakeRelayOptions;
    /** 节点地址（缺省假中继）。 */
    nodeUrl?: string;
    backoff?: (attempt: number) => number;
  } = {},
): Promise<RelayCore> {
  const world = fakeRelayWorld();
  const backend = memoryBackend();
  // 源公钥：core 装好之后才有，握手时现取。
  const holder: { publicJwk?: Record<string, unknown> } = {};
  const relay = await FakeTunnelRelay.start({
    sourceKey: () =>
      holder.publicJwk === undefined
        ? undefined
        : createPublicKey({ key: holder.publicJwk as never, format: "jwk" }),
    ...options.relay,
  });
  const state = {
    hint: undefined as RelayCore["hint"],
    hintFetches: 0,
    settings: { enabled: true, preferredNode: "" } as RelaySettings,
  };
  const transport: Transport = async (request): Promise<OutboundAnswer> => {
    const url = new URL(request.url);
    if (
      url.origin === ISSUER &&
      request.method === "GET" &&
      url.pathname === "/v1/sources/me/relay"
    ) {
      state.hintFetches += 1;
      world.requests.push(request);
      if (state.hint !== undefined) return state.hint;
      return {
        status: 200,
        body: {
          tunnelToken: "tunnel-token",
          expiresAtMs: Date.now() + 3_600_000,
          nodes: [{ url: options.nodeUrl ?? relay.url, weight: 1 }],
          limits: {
            maxStreams: LIMITS.maxStreams,
            streamWindow: LIMITS.streamWindow,
            tunnelWindow: LIMITS.tunnelWindow,
            maxFrameBytes: LIMITS.maxFrameBytes,
          },
        },
      };
    }
    return world.transport(request);
  };
  let store!: IdentityStore;
  let service!: IdentityService;
  let accounts!: AccountsService;
  let cloud!: CloudService;
  let tunnels: RelayService | undefined;
  const core = fixture([
    (context) => void installWorkspaces(context),
    (context) => void installEvents(context),
    (context) => {
      store = new IdentityStore(context.db.database);
      service = new IdentityService(store, INSTANCE);
      accounts = new AccountsService({ store });
      cloud = installCloud(context, {
        store,
        service,
        accounts,
        authorizer: new Authorizer(store),
        capabilities: () => ["identity.native-session.v1"],
        coreVersion: "0.0.0-test",
        transport,
        secrets: () => backend,
      });
      tunnels = installRelay(context, {
        cloud,
        identity: service,
        transport,
        settings: () => state.settings,
        backoff: options.backoff ?? (() => 20),
        allowInsecure: () => true,
      });
    },
  ]);
  installContract(core.server, {
    validateOutput: true,
    platform: core.platform,
  });
  const listener = core.server.createListener();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  // 本机先要有 owner：登记的那个人。
  const ownerToken = (origin: string) => {
    const ticket = service.issueBootstrap({
      hostId: store.hostId(),
      instanceId: INSTANCE,
      origin,
      deviceName: "测试设备",
      scopes: allScopes(),
    });
    return service.consumeBootstrap({
      ticket: ticket.ticket,
      hostId: store.hostId(),
      instanceId: INSTANCE,
      origin,
    }).accessToken;
  };
  ownerToken(LOOPBACK_ORIGIN);
  holder.publicJwk = (await cloud.status()).sourcePublicKey as Record<
    string,
    unknown
  >;
  const result: RelayCore = {
    core,
    world,
    relay,
    cloud,
    tunnels: tunnels as RelayService,
    service,
    store,
    accounts,
    base,
    get hint() {
      return state.hint;
    },
    set hint(value) {
      state.hint = value;
    },
    get hintFetches() {
      return state.hintFetches;
    },
    set hintFetches(value) {
      state.hintFetches = value;
    },
    get settings() {
      return state.settings;
    },
    set settings(value) {
      state.settings = value;
    },
    register: async () => {
      await cloud.register({
        issuer: ISSUER,
        registrationToken: REGISTRATION_TOKEN,
      });
    },
    session: ownerToken,
    close: async () => {
      tunnels?.close();
      await relay.close();
      await core.server.close();
      core.close();
    },
  };
  return result;
}

/** 等到条件成立（轮询，最多 `timeoutMs`）。 */
export async function until(
  condition: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
