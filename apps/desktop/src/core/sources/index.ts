/**
 * 客户端源表与远程服务域（契约 §33，迁移 0039，平台规格 core 包 §1）。
 *
 * `sources.*` 的 procedure 都在这里登记；它们的旧路径（`/api/sources/*`）
 * 由 RPC 门面挂回同一份实现，路由表里那几条 handler 是门面没装时的回落，调的
 * 也是同一份。全部 owner 专用：读 `settings:read`，写 `settings:write`
 * （`http/route-scopes.ts`）。
 *
 * 装配只做一件事：upsert 本机那一行。不联网、不读凭据——远程服务不可达不会让
 * core 起不来，也不会拖慢任何一条本机 API（旁路保证）。
 */

import { hostname } from "node:os";

import { contract } from "@armadra/shared";

import { AccountsService } from "../identity/accounts";
import { cloudDomain } from "../identity/cloud";
import { currentSubject } from "../identity/gate";
import { IdentityStore } from "../identity/store";
import { CoreFailure, fail } from "../http/errors";
import { type DomainHandlers, registerProcedures } from "../http/rpc";
import type { CoreRequest, HandlerResult, RouteMatch } from "../http/router";
import type { CoreContext } from "../main";
import { secretsFor } from "../secrets";
import {
  networkTransport,
  presentedAnchor,
  type Transport,
} from "./http-client";
import { RemoteClient } from "./remote-client";
import { SourceSecrets } from "./secrets";
import { SourcesService } from "./service";
import { ShareLinks } from "./share-links";
import { SourceClient } from "./source-client";
import { SourcesStore } from "./store";

export { SourcesService, parsePairLink } from "./service";
export { SourcesStore } from "./store";
export { SourceSecrets, sourceSecretName, remoteSecretName } from "./secrets";
export {
  networkTransport,
  normalizeFingerprint,
  normalizeOrigin,
} from "./http-client";
export type { Transport, OutboundRequest, OutboundAnswer } from "./http-client";

export interface SourcesInstallOptions {
  /** 换掉出站发送点（测试用假的远程服务与假 Gateway）。 */
  readonly transport?: Transport;
  readonly now?: () => number;
}

let assembled: SourcesService | undefined;

/** 这一轮 core 装好的源服务；A1-4 / A2-3 / A3-2 经它读源表。 */
export function sourcesDomain(): SourcesService | undefined {
  return assembled;
}

type Procedure = keyof typeof contract.sources;

interface StandardSchema {
  "~standard": {
    validate(
      value: unknown,
    ):
      | { value: unknown; issues?: undefined }
      | { issues: readonly { message: string }[] }
      | Promise<
          | { value: unknown; issues?: undefined }
          | { issues: readonly { message: string }[] }
        >;
  };
}

/** 回落 handler 的入参：路径参数 + JSON 体，按契约的入参 schema 校验。 */
async function inputOf(
  procedure: Procedure,
  match: RouteMatch,
  request: CoreRequest,
): Promise<unknown> {
  let body: unknown = {};
  if (request.body.byteLength > 0) {
    try {
      body = request.json();
    } catch {
      throw fail("bad_request", "请求体不是 JSON");
    }
  }
  const raw =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>), ...match.params }
      : body;
  const schema = (
    contract.sources[procedure] as unknown as {
      "~orpc": { inputSchema?: StandardSchema };
    }
  )["~orpc"].inputSchema;
  if (schema === undefined) return raw;
  const result = await schema["~standard"].validate(raw);
  if (result.issues !== undefined) {
    throw fail("bad_request", "Input validation failed");
  }
  return result.value;
}

function failure(error: unknown): HandlerResult {
  if (error instanceof CoreFailure) {
    return {
      status: error.status,
      body: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }
  return { status: 500, body: { code: "internal", message: "内部错误" } };
}

export function install(
  context: CoreContext,
  options: SourcesInstallOptions = {},
): SourcesService | undefined {
  if (!context.db.unified) {
    context.log.info("源表域未装配：统一库迁移尚未应用");
    return undefined;
  }
  const transport = options.transport ?? networkTransport;
  const identity = new IdentityStore(context.db.database);
  const device = {
    platform: context.platform.shell === "server" ? "server" : "desktop",
    name: (hostname().trim() || "Armadra").slice(0, 128),
  } as const;
  const secrets = new SourceSecrets(() => secretsFor(context).backend);
  const remote = new RemoteClient(transport, device);
  const service = new SourcesService({
    store: new SourcesStore(context.db.database),
    secrets,
    remote,
    peer: new SourceClient(transport),
    hostId: () => identity.hostId(),
    hostLabel: () => hostname(),
    log: context.log,
    cloud: () => cloudDomain(),
    // 只有真网络才探信任锚；测试的假对端不探。
    ...(transport === networkTransport
      ? { anchorProbe: (origin: string) => presentedAnchor(origin) }
      : {}),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  service.ensureLocal();
  assembled = service;
  // 云登录域撤销登记时删中继侧的源记录要远程服务的会话，会话在这一域：挂过去
  // （契约 §31.4）。身份域在 DOMAINS 里排在前面，这里已经装好。
  cloudDomain()?.attachRelayCleaner((issuer, sourceId) =>
    service.removeRelaySource(issuer, sourceId),
  );

  // 分享链接（契约 §33.9）：本机邀请以当前请求的主体签发、作废（与
  // `accounts.invitations.*` 同一套权限）。
  const accounts = new AccountsService({ store: identity });
  const shareLinks = new ShareLinks({
    secrets,
    remote,
    access: (serviceId) => service.remoteEndpoint(serviceId),
    issuerOf: (serviceId) => service.remoteIssuer(serviceId),
    capabilities: (serviceId, options) =>
      service.remoteCapabilities(serviceId, options),
    registrations: () => {
      const cloud = cloudDomain();
      return cloud === undefined
        ? undefined
        : {
            registered: (issuer) => cloud.registered(issuer),
            sourceId: async () => (await cloud.status()).sourceId,
          };
    },
    invitations: () => ({
      issue: (input) => accounts.issueInvitation(currentSubject(), input),
      revoke: (invitationId) =>
        accounts.revokeInvitation(currentSubject(), invitationId),
    }),
    log: context.log,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const handlers = {
    list: () => service.list(),
    addDirect: (input) => service.addDirect(input),
    update: (input) => service.update(input),
    remove: (input) => service.remove(input.sourceId),
    forget: (input) => service.forget(input.sourceId),
    session: (input) => service.session(input.sourceId, input.via),
    remoteAdd: (input) => service.remoteAdd(input),
    remoteDevicePoll: (input) => service.remoteDevicePoll(input.serviceId),
    remoteRemove: (input) => service.remoteRemove(input.serviceId),
    remoteSources: (input) => service.remoteSources(input.serviceId),
    mount: (input) => service.mount(input),
    remoteSession: (input) => service.remoteSession(input.serviceId),
    remoteLogout: (input) => service.remoteLogout(input.serviceId),
    mountByLink: (input) => service.mountByLink(input),
    shareLinks: (input) => shareLinks.list(input.serviceId),
    shareLinkCreate: (input) => shareLinks.create(input),
    shareLinkUrl: (input) => shareLinks.url(input.serviceId, input.linkId),
    shareLinkUpdate: (input) => shareLinks.updateLabel(input),
    shareLinkRevoke: (input) =>
      shareLinks.revoke(input.serviceId, input.linkId),
  } satisfies DomainHandlers<"sources">;
  registerProcedures(context.server, "sources", handlers);

  // 路由表里的同一批路径：RPC 门面没装时的回落，调的是同一份实现。
  const { router } = context.server;
  for (const [verb, procedure] of Object.entries(contract.sources)) {
    const legacy = (
      procedure as unknown as {
        "~orpc": { meta: { legacy?: { method: string; path: string } } };
      }
    )["~orpc"].meta.legacy;
    if (legacy === undefined) continue;
    const name = verb as Procedure;
    router.handle(legacy.method, legacy.path, async (match, request) => {
      try {
        const input = await inputOf(name, match, request);
        const handler = handlers[name] as (value: unknown) => Promise<unknown>;
        return { status: 200, body: await handler(input) };
      } catch (error) {
        return failure(error);
      }
    });
  }
  return service;
}
