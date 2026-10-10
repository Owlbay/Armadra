/**
 * 分享链接的管理（契约 §33.9，改备注 §33.10）：本机经一个个人中转发出的 `source_invite` 链接。
 *
 * 一条链接是两样东西拼起来的：远程服务那一侧的链接记录（`links.create`，答一次
 * 性的 `secret`），和本机这一侧的一张多次可用的邀请（`accounts.invitations`）。
 * 分享出去的是 `<url>#<secret>.<邀请令牌>`——两样秘密都只在创建时出现，所以整条
 * 链接存进 SecretStore（`armadra-share-links-<serviceId>`），之后才能随时再复制。
 *
 * **范围**（契约 §60）：整台 / 工作空间 / 会话，可选只读。范围落在本机邀请上
 * （`targetHost` / `targetWorkspaceId` / `targetSessionId`，只读压成 viewer），core 是
 * 判定点；远程服务报 `links.scope` 能力时再把范围交给它，访客的断言带 `scp`、只读的
 * 中继令牌带 `ro`（边缘的纵深防御）。撤链接时连同经它进来的访客一起停用。
 *
 * **凭据边界**：整条链接只在 SecretStore、`shareLinkCreate` 与 `shareLinkUrl` 的
 * 答案里；不进 SQLite、日志与列表。链接撤销、过期、用尽，或远程服务上已经没有
 * 它时，列表顺手把存着的那份删掉。
 */

import type { ShareLink, ShareLinkState, ShareTarget } from "@armadra/shared";

import { CoreFailure, fail } from "../http/errors";
import { IdentityError } from "../identity/errors";
import type {
  LinkScope,
  LinkSummary,
  RemoteClient,
  RemoteEndpoint,
} from "./remote-client";
import type { SavedShareLink, SourceSecrets } from "./secrets";

/** 中继给链接的最长有效期是 30 天；留一分钟余量，免得两边的钟差一点就被拒。 */
const LINK_TTL_MAX_MS = 30 * 24 * 60 * 60 * 1000 - 60_000;

/** 本机邀请的那一半（`AccountsService`，以当前请求的主体签发与作废）。 */
export interface ShareInvitations {
  issue(input: {
    role: string;
    targetWorkspaceId: string;
    targetSessionId?: string;
    targetHost?: boolean;
    ttlMs: number;
    maxUses: number;
  }): { invitationId: string; token: string; expiresAtMs: number };
  revoke(invitationId: string): void;
  /** 停用经这条链接进来的访客（契约 §60）；答停用了几个。 */
  disableGuests?(issuer: string, linkId: string): number;
}

/** 远程服务要知道范围才能签 `scp` / `ro` 的能力（协议 1.1）。 */
export const LINK_SCOPE_CAPABILITY = "links.scope";

/** 建链接时请求的范围，规范化之后。 */
interface ShareScope {
  readonly target: ShareTarget;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly readOnly: boolean;
  readonly role: string;
}

/**
 * 校验并规范化范围：整台不带工作空间，工作空间要有 id，会话要有工作空间与会话、
 * 角色总是 viewer、总是只读；只读把角色压成 viewer。不合规答 `bad_request`。
 */
export function shareScopeOf(input: {
  target?: ShareTarget | undefined;
  workspaceId: string;
  sessionId?: string | undefined;
  readOnly?: boolean | undefined;
  role: string;
}): ShareScope {
  const target = input.target ?? "workspace";
  const sessionId = input.sessionId ?? "";
  if (target === "host") {
    if (sessionId !== "") throw fail("bad_request", "整台分享不带会话");
    const readOnly = input.readOnly === true;
    return {
      target,
      workspaceId: "",
      sessionId: "",
      readOnly,
      role: readOnly ? "viewer" : input.role,
    };
  }
  if (input.workspaceId === "") {
    throw fail("bad_request", "要分享哪个工作空间");
  }
  if (target === "session") {
    if (sessionId === "") throw fail("bad_request", "要分享哪个会话");
    return {
      target,
      workspaceId: input.workspaceId,
      sessionId,
      readOnly: true,
      role: "viewer",
    };
  }
  if (sessionId !== "") throw fail("bad_request", "工作空间分享不带会话");
  const readOnly = input.readOnly === true;
  return {
    target,
    workspaceId: input.workspaceId,
    sessionId: "",
    readOnly,
    role: readOnly ? "viewer" : input.role,
  };
}

/** 范围 → 远程服务的 `linkScope`（与协议包 `scopeClaims` 同一套语义）。整台可写答 undefined。 */
export function linkScopeOf(scope: ShareScope): LinkScope | undefined {
  if (scope.target === "host") {
    return scope.readOnly ? { readOnly: true } : undefined;
  }
  if (scope.target === "session") {
    return {
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      readOnly: true,
    };
  }
  return scope.readOnly
    ? { workspaceId: scope.workspaceId, readOnly: true }
    : { workspaceId: scope.workspaceId };
}

/** 本机到远程服务的登记（契约 §31）里这一模块要的两件事。 */
export interface ShareRegistrations {
  registered(issuer: string): boolean;
  /** 本机在远程服务上的 `sourceId`。 */
  sourceId(): Promise<string>;
}

export interface ShareLinksOptions {
  readonly secrets: SourceSecrets;
  readonly remote: RemoteClient;
  /** 远程服务的地址与访问令牌（`SourcesService.remoteEndpoint`）。 */
  readonly access: (serviceId: string) => Promise<{
    endpoint: RemoteEndpoint;
    accessToken: string;
    issuer: string;
  }>;
  /** 这一行远程服务在不在（不联网）。 */
  readonly issuerOf: (serviceId: string) => string;
  /** 远程服务报的能力；`refresh` 时重问 `platform.info`。缺省当作都有。 */
  readonly capabilities?: (
    serviceId: string,
    options?: { refresh?: boolean },
  ) => Promise<readonly string[]>;
  readonly registrations: () => ShareRegistrations | undefined;
  readonly invitations: () => ShareInvitations | undefined;
  readonly log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
  readonly now?: () => number;
}

/** 身份域的失败 → 契约的码。 */
function identity<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (!(error instanceof IdentityError)) throw error;
    switch (error.kind) {
      case "invalid":
        throw fail("bad_request", "邀请的参数不对");
      case "notFound":
        throw fail("not_found", "没有这张邀请");
      case "permission":
        throw fail("forbidden", "没有签发这张邀请的权限");
      default:
        throw fail("unauthenticated", "需要一个有效的会话");
    }
  }
}

export function shareLinkState(
  row: Pick<LinkSummary, "revokedAtMs" | "expiresAtMs" | "uses" | "maxUses">,
  now: number,
): ShareLinkState {
  if (row.revokedAtMs !== null) return "revoked";
  if (row.expiresAtMs <= now) return "expired";
  if (row.maxUses !== null && row.uses >= row.maxUses) return "exhausted";
  return "active";
}

export class ShareLinks {
  private readonly now: () => number;
  /** 同一个远程服务的那份 SecretStore 条目，读改写排队。 */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly options: ShareLinksOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  private serial<T>(serviceId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(serviceId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    this.queues.set(serviceId, settled);
    void settled.then(() => {
      if (this.queues.get(serviceId) === settled) this.queues.delete(serviceId);
    });
    return next;
  }

  private async update(
    serviceId: string,
    change: (
      links: Record<string, SavedShareLink>,
    ) => Record<string, SavedShareLink> | undefined,
  ): Promise<void> {
    await this.serial(serviceId, async () => {
      const current = { ...(await this.options.secrets.shareLinks(serviceId)) };
      const next = change(current);
      if (next !== undefined) {
        await this.options.secrets.putShareLinks(serviceId, next);
      }
    });
  }

  /** 远程服务报没报这条能力；没给能力表时当作有。记着的没有就重问一次。 */
  private async capable(serviceId: string, name: string): Promise<boolean> {
    const capable = this.options.capabilities;
    if (capable === undefined) return true;
    try {
      return (
        (await capable(serviceId, { refresh: false })).includes(name) ||
        (await capable(serviceId, { refresh: true })).includes(name)
      );
    } catch {
      return false;
    }
  }

  /** 撤链接连同访客（契约 §60）：尽力，失败只记一笔——链接已撤、邀请已作废。 */
  private disableGuests(issuer: string, linkId: string): void {
    try {
      const count =
        this.options.invitations()?.disableGuests?.(issuer, linkId) ?? 0;
      if (count > 0) {
        this.options.log.info("disabled guests of a share link", {
          linkId,
          count,
        });
      }
    } catch (error) {
      this.options.log.warn("could not disable guests of a share link", {
        linkId,
        code: error instanceof IdentityError ? error.kind : "unknown",
      });
    }
  }

  private revokeInvitation(invitationId: string): void {
    if (invitationId === "") return;
    try {
      this.options.invitations()?.revoke(invitationId);
    } catch {
      // 尽力：链接已经撤了，邀请没有链接指向就无从兑换（还要秘密）。
    }
  }

  async list(serviceId: string): Promise<{ links: ShareLink[] }> {
    const issuer = this.options.issuerOf(serviceId);
    const registrations = this.options.registrations();
    if (registrations?.registered(issuer) !== true) {
      await this.options.secrets
        .clearShareLinks(serviceId)
        .catch(() => undefined);
      return { links: [] };
    }
    const sourceId = await registrations.sourceId();
    const { endpoint, accessToken } = await this.options.access(serviceId);
    const rows = (
      await this.options.remote.listLinks(endpoint, accessToken, sourceId)
    ).filter(
      (row) => row.kind === "source_invite" && row.sourceId === sourceId,
    );
    const now = this.now();
    const saved = await this.options.secrets.shareLinks(serviceId);
    const states = new Map(
      rows.map((row) => [row.linkId, shareLinkState(row, now)]),
    );
    const stale = Object.keys(saved).filter(
      (linkId) => states.get(linkId) !== "active",
    );
    if (stale.length > 0) {
      for (const linkId of stale) {
        // 远程服务那边被撤销（例如另一台设备上撤的）：本机的邀请一并作废。
        if (states.get(linkId) === "revoked") {
          this.revokeInvitation(saved[linkId]?.invitationId ?? "");
        }
      }
      await this.update(serviceId, (links) => {
        for (const linkId of stale) delete links[linkId];
        return links;
      });
    }
    const links = rows
      .map((row) => shareLinkOf(row, states.get(row.linkId) ?? "active", saved))
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
    return { links };
  }

  /**
   * 改备注（契约 §33.10）：远程服务 `links.update`。它记着的能力里没有
   * `links.update` 时先重问一次（可能升过级），还没有答 `not_implemented`。
   */
  async updateLabel(input: {
    serviceId: string;
    linkId: string;
    label: string;
  }): Promise<{ link: ShareLink }> {
    this.options.issuerOf(input.serviceId);
    const capable = this.options.capabilities;
    if (capable !== undefined) {
      const has = async (refresh: boolean) =>
        (await capable(input.serviceId, { refresh })).includes("links.update");
      if (!(await has(false)) && !(await has(true))) {
        throw fail("not_implemented", "远程服务不支持改链接备注");
      }
    }
    const { endpoint, accessToken } = await this.options.access(
      input.serviceId,
    );
    const row = await this.options.remote.updateLink(
      endpoint,
      accessToken,
      input.linkId,
      input.label.trim().slice(0, 128),
    );
    const saved = await this.options.secrets.shareLinks(input.serviceId);
    this.options.log.info("renamed a share link", {
      serviceId: input.serviceId,
      linkId: input.linkId,
    });
    return {
      link: shareLinkOf(row, shareLinkState(row, this.now()), saved),
    };
  }

  async create(input: {
    serviceId: string;
    workspaceId: string;
    target?: ShareTarget | undefined;
    sessionId?: string | undefined;
    readOnly?: boolean | undefined;
    role: string;
    ttlMs: number;
    maxUses: number;
    label?: string | undefined;
  }): Promise<{ link: ShareLink; url: string }> {
    const issuer = this.options.issuerOf(input.serviceId);
    const scope = shareScopeOf(input);
    const registrations = this.options.registrations();
    if (registrations?.registered(issuer) !== true) {
      throw fail("cloud_not_registered", "本机还没有分享到这个远程服务");
    }
    const invitations = this.options.invitations();
    if (invitations === undefined) {
      throw fail("not_implemented", "身份域未装配");
    }
    const sourceId = await registrations.sourceId();
    const { endpoint, accessToken } = await this.options.access(
      input.serviceId,
    );
    // 只有远程服务报了 `links.scope` 才把范围交给它：旧中继会拒认不得的字段。
    // 范围本身总落在本机邀请上，交不过去也照样由 core 判定。
    const linkScope = linkScopeOf(scope);
    const scoped =
      linkScope !== undefined &&
      (await this.capable(input.serviceId, LINK_SCOPE_CAPABILITY));
    const invitation = identity(() =>
      invitations.issue({
        role: scope.role,
        targetWorkspaceId: scope.workspaceId,
        ...(scope.sessionId === "" ? {} : { targetSessionId: scope.sessionId }),
        ...(scope.target === "host" ? { targetHost: true } : {}),
        ttlMs: Math.min(input.ttlMs, LINK_TTL_MAX_MS),
        maxUses: input.maxUses,
      }),
    );
    const label = (input.label ?? "").trim().slice(0, 128);
    let created;
    try {
      created = await this.options.remote.createLink(endpoint, accessToken, {
        sourceId,
        invitationId: invitation.invitationId,
        label,
        role: scope.role,
        expiresAtMs: invitation.expiresAtMs,
        maxUses: input.maxUses,
        ...(scoped && linkScope !== undefined ? { scope: linkScope } : {}),
      });
      if (!sameOrigin(created.url, issuer)) {
        await this.options.remote
          .revokeLink(endpoint, accessToken, created.linkId)
          .catch(() => undefined);
        throw fail("source_unreachable", "远程服务给的链接不在它自己的地址上");
      }
    } catch (error) {
      // 链接没建成，邀请也不留：没有链接指向的邀请只是一枚多余的令牌。
      this.revokeInvitation(invitation.invitationId);
      throw error;
    }
    const fragment =
      created.secret === ""
        ? invitation.token
        : `${created.secret}.${invitation.token}`;
    const url = `${created.url}#${fragment}`;
    try {
      await this.update(input.serviceId, (links) => ({
        ...links,
        [created.linkId]: {
          url,
          invitationId: invitation.invitationId,
          workspaceId: scope.workspaceId,
          ...savedScope(scope),
        },
      }));
    } catch (error) {
      // 存不下就没法再复制：这一次照样把链接交出去，只记一笔。
      this.options.log.warn("could not save a share link", {
        serviceId: input.serviceId,
        linkId: created.linkId,
        code: error instanceof CoreFailure ? error.code : "secret_unavailable",
      });
    }
    this.options.log.info("created a share link", {
      serviceId: input.serviceId,
      linkId: created.linkId,
    });
    const expiresAtMs = Math.min(created.expiresAtMs, invitation.expiresAtMs);
    return {
      url,
      link: {
        linkId: created.linkId,
        label,
        role: scope.role,
        workspaceId: scope.workspaceId,
        ...linkScopeFields(scope.target, scope.sessionId, scope.readOnly),
        createdAtMs: this.now(),
        expiresAtMs,
        uses: 0,
        maxUses: input.maxUses,
        revokedAtMs: null,
        state: "active",
        copyable: true,
      },
    };
  }

  async url(serviceId: string, linkId: string): Promise<{ url: string }> {
    this.options.issuerOf(serviceId);
    const saved = (await this.options.secrets.shareLinks(serviceId))[linkId];
    if (saved === undefined) throw fail("not_found", "本机没有存着这条链接");
    return { url: saved.url };
  }

  async revoke(
    serviceId: string,
    linkId: string,
  ): Promise<Record<string, never>> {
    const { endpoint, accessToken } = await this.options.access(serviceId);
    try {
      await this.options.remote.revokeLink(endpoint, accessToken, linkId);
    } catch (error) {
      // 远程服务上已经没有它：照样收拾本机这一侧。
      if (!(error instanceof CoreFailure && error.code === "not_found")) {
        throw error;
      }
    }
    const saved = (await this.options.secrets.shareLinks(serviceId))[linkId];
    if (saved !== undefined) this.revokeInvitation(saved.invitationId);
    this.disableGuests(this.options.issuerOf(serviceId), linkId);
    await this.update(serviceId, (links) => {
      if (!(linkId in links)) return undefined;
      delete links[linkId];
      return links;
    });
    this.options.log.info("revoked a share link", { serviceId, linkId });
    return {};
  }
}

function savedScope(scope: ShareScope): Partial<SavedShareLink> {
  return {
    ...(scope.target === "workspace" ? {} : { target: scope.target }),
    ...(scope.sessionId === "" ? {} : { sessionId: scope.sessionId }),
    ...(scope.readOnly ? { readOnly: true } : {}),
  };
}

/** 契约 §60 的三个字段：会话分享带会话 id，只读才写 `readOnly`。 */
function linkScopeFields(
  target: ShareTarget,
  sessionId: string,
  readOnly: boolean,
): Pick<ShareLink, "target" | "sessionId" | "readOnly"> {
  return {
    target,
    ...(sessionId === "" ? {} : { sessionId }),
    ...(readOnly ? { readOnly: true } : {}),
  };
}

/** 一行链接的范围：本机存着的优先，其次远程服务记着的，都没有不写。 */
function rowScope(
  row: LinkSummary,
  saved: SavedShareLink | undefined,
): Pick<ShareLink, "target" | "sessionId" | "readOnly"> {
  if (saved !== undefined) {
    return linkScopeFields(
      saved.target ?? "workspace",
      saved.sessionId ?? "",
      saved.readOnly === true,
    );
  }
  const scope = row.scope;
  if (scope === undefined) return {};
  const target: ShareTarget =
    scope.sessionId !== undefined
      ? "session"
      : scope.workspaceId !== undefined
        ? "workspace"
        : "host";
  return linkScopeFields(
    target,
    scope.sessionId ?? "",
    scope.readOnly === true,
  );
}

/** 远程服务的一行 + 本机存着的那份 → 契约的链接摘要。 */
function shareLinkOf(
  row: LinkSummary,
  state: ShareLinkState,
  saved: Readonly<Record<string, SavedShareLink>>,
): ShareLink {
  const entry = state === "active" ? saved[row.linkId] : undefined;
  return {
    linkId: row.linkId,
    label: row.label,
    role: row.role,
    workspaceId: saved[row.linkId]?.workspaceId ?? row.scope?.workspaceId ?? "",
    ...rowScope(row, saved[row.linkId]),
    createdAtMs: row.createdAtMs,
    expiresAtMs: row.expiresAtMs,
    uses: row.uses,
    maxUses: row.maxUses,
    revokedAtMs: row.revokedAtMs,
    state,
    copyable: entry !== undefined,
  };
}

function sameOrigin(url: string, issuer: string): boolean {
  try {
    return new URL(url).origin === new URL(issuer).origin;
  } catch {
    return false;
  }
}
