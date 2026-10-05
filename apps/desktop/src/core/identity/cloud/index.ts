/**
 * 云登录与登记（契约 §31，迁移 0040，平台规格 core 包 §2）。
 *
 * 这台 core 登记到远程服务（目前只有个人中转），用它签的源访问断言换本机会话。
 * 由身份域装配（`identity/index.ts`），与它共用同一份会话、账号与加固服务：
 *
 *   * 旧路径 `/api/identity/cloud*`：原样路由（`http.ts`），`login` 匿名；
 *   * procedure `identity.cloud.*`：RPC 门面，`login` 不经 RPC（匿名面只经旧路径）。
 *
 * 装配不联网、不读 SecretStore：没有登记行时这一域什么都不做（旁路保证）。源私钥
 * 第一次登记或读状态时才生成。
 */

import { type DomainHandlers, registerProcedures } from "../../http/rpc";
import type { CoreContext } from "../../main";
import { type SecretBackend, secretsFor } from "../../secrets";
import { networkTransport, type Transport } from "../../sources/http-client";
import type { AccountsService } from "../accounts";
import type { IdentitySecurity } from "../accounts-http";
import type { Authorizer } from "../authorize";
import { requestIdentity } from "../gate";
import type { ShareRole } from "../roles";
import type { IdentityService } from "../service";
import type { IdentityStore } from "../store";
import { AssertionVerifier } from "./assertion";
import { CloudClient } from "./cloud-client";
import { CLOUD_PREFIX, CloudHttp } from "./http";
import { JwksCache } from "./jwks";
import { CloudLogin } from "./login";
import { CloudRegistry, IDLE_RELAY } from "./register";
import { CloudService } from "./service";
import { SourceKey } from "./source-key";
import { CloudStore } from "./store";

export { CloudService } from "./service";
export { CloudStore } from "./store";
export type { RegistrationRow } from "./store";
export { IDLE_RELAY, IDLE_TUNNEL } from "./register";
export type { CloudRelay } from "./register";
export { SOURCE_KEY_REF } from "./source-key";
export { cloudProvider } from "./login";
export { CLOUD_PREFIX } from "./http";

export interface CloudDeps {
  readonly store: IdentityStore;
  readonly service: IdentityService;
  readonly accounts: AccountsService;
  readonly authorizer: Authorizer;
  readonly security?: IdentitySecurity;
  /** 本机 hello 报的能力名（登记时交给远程服务）。 */
  readonly capabilities: () => readonly string[];
  readonly coreVersion: string;
  /** 以下给测试：出站发送点、SecretStore、时钟、组织默认角色。 */
  readonly transport?: Transport;
  readonly secrets?: () => SecretBackend;
  readonly now?: () => number;
  readonly orgDefaultRole?: () => ShareRole | null;
}

let assembled: CloudService | undefined;

/** 这一轮 core 装好的云登录域；源表（A1-3）、隧道（A3-2）、CLI（A4-4）经它。 */
export function cloudDomain(): CloudService | undefined {
  return assembled;
}

/** 测试用：卸下。 */
export function resetCloudDomain(): void {
  assembled = undefined;
}

export function installCloud(
  context: CoreContext,
  deps: CloudDeps,
): CloudService {
  const now = deps.now ?? Date.now;
  const cloud = new CloudStore(context.db.database);
  const client = new CloudClient(deps.transport ?? networkTransport);
  const hostId = () => deps.service.hostId();
  const sourceKey = new SourceKey(
    deps.secrets ?? (() => secretsFor(context).backend),
    hostId,
    now,
  );
  const jwks = new JwksCache(
    cloud,
    (row) => client.jwks(row.jwksUrl, cloud.remoteFingerprint(row.issuer)),
    now,
  );
  const verifier = new AssertionVerifier({ store: cloud, jwks, hostId, now });
  const logins = new CloudLogin({
    store: deps.store,
    service: deps.service,
    accounts: deps.accounts,
    cloud,
    verifier,
    now,
    ...(deps.orgDefaultRole === undefined
      ? {}
      : { orgDefaultRole: deps.orgDefaultRole }),
  });
  // 登记要问「现在挂着哪条隧道」，而隧道挂在门面上：门面建好之后才填上。
  const holder: { service?: CloudService } = {};
  const registry = new CloudRegistry({
    cloud,
    identity: deps.store,
    client,
    sourceKey,
    hostId,
    shell: context.platform.shell === "server" ? "server" : "desktop",
    coreVersion: deps.coreVersion,
    capabilities: deps.capabilities,
    relay: () => holder.service?.currentRelay() ?? IDLE_RELAY,
    now,
    log: context.log,
  });
  const ready = new CloudService(cloud, registry, logins, sourceKey);
  holder.service = ready;
  assembled = ready;

  const http = new CloudHttp({
    service: deps.service,
    authorizer: deps.authorizer,
    cloud: ready,
    ...(deps.security === undefined
      ? {}
      : { throttle: deps.security.throttle }),
  });
  context.server.raw(CLOUD_PREFIX, (request, response, cors) =>
    http.handle(request, response, cors),
  );

  // `login` 是匿名面，只经旧路径（契约 §31）：RPC 上不登记，答 501。
  const principalId = () => {
    const subject = requestIdentity()?.subject.principalId;
    return subject === undefined || subject === "" ? undefined : subject;
  };
  const handlers = {
    cloud: {
      register: (input) => ready.register(input, principalId()),
      revoke: (input) => ready.revoke(input, principalId()),
      status: () => ready.status(),
      bind: (input) => {
        const who = principalId() ?? ownerOf(deps.store);
        return ready.bind(who, input.assertion);
      },
      trustedOrigins: (input) => ready.trustedOrigins(input),
    },
  } satisfies {
    cloud: Omit<DomainHandlers<"identity">["cloud"], "login">;
  };
  registerProcedures(
    context.server,
    "identity",
    handlers as unknown as DomainHandlers<"identity">,
  );
  return ready;
}

/** 没有请求主体（桌面壳的本机动作）时，「本人」就是 owner。 */
function ownerOf(store: IdentityStore): string {
  return store.transaction((tx) => tx.owner()?.principalId ?? "");
}
