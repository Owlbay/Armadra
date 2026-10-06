/**
 * 用源访问断言换本机会话（`cloud/login`）与绑定（`cloud/bind`），平台规格 core
 * 包 §2.4，契约 §31。
 *
 * 外部身份 → principal 的映射就是 OAuth 那一种凭据（`identity_credentials`，
 * `kind = 'oauth'`）：`provider = "cloud:" + sha256(iss) 的前 16 位十六进制`、
 * `subject = sub`。于是「一个远程服务账号只对应一个 principal」由同一条唯一索引
 * 守着，账号页撤销映射也是同一个动作。
 *
 * 1. 验断言（`assertion.ts`）；按 `sub` 每分钟最多 5 次。
 * 2. 有映射 → 那个 principal（停用了答 `forbidden`）。
 * 3. 没有映射：带邀请令牌 → 建成员 + 映射 + 兑换邀请（一笔事务）→ `created`；
 *    不带 → `cloud_account_unlinked`。
 * 4. 新建的人带 `org` 声明且设了组织默认角色 → 对每块画布逐条授予。
 * 5. 建设备与会话（`method = "cloud"`），审计 `cloud.login`。
 */

import { createHash } from "node:crypto";

import type { AssertionClaims } from "@armadra/platform-protocol/assertion";

import { fail } from "../../http/errors";
import type { AccountsService } from "../accounts";
import { IdentityError } from "../errors";
import type { ShareRole } from "../roles";
import type { IdentityService, SessionCredentials } from "../service";
import type { IdentityStore } from "../store";
import { IpBuckets } from "../throttle";
import { newId, parseToken, validName } from "../tokens";
import type { AssertionVerifier } from "./assertion";
import type { CloudStore } from "./store";

/** 同一个 `sub` 每分钟最多换这么多次会话。 */
export const SUBJECT_LOGINS_PER_MINUTE = 5;

/** 映射凭据的 `provider`：`cloud:` + issuer 的 SHA-256 前 16 位十六进制。 */
export function cloudProvider(issuer: string): string {
  return `cloud:${createHash("sha256").update(issuer, "utf8").digest("hex").slice(0, 16)}`;
}

export interface CloudLoginResult {
  readonly credentials: SessionCredentials;
  readonly principal: {
    readonly principalId: string;
    readonly kind: "owner" | "member";
    readonly displayName: string;
  };
  readonly created: boolean;
}

export interface CloudLoginOptions {
  readonly store: IdentityStore;
  readonly service: IdentityService;
  readonly accounts: AccountsService;
  readonly cloud: CloudStore;
  readonly verifier: AssertionVerifier;
  /** 组织默认角色（设置 `cloud.orgDefaultRole`，A3-2）；缺省 `null` = 不授予。 */
  readonly orgDefaultRole?: () => ShareRole | null;
  readonly now?: () => number;
}

function clipName(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? "").trim().slice(0, 64).trim();
  return validName(trimmed) ? trimmed : fallback;
}

export class CloudLogin {
  private readonly now: () => number;
  private readonly subjects = new IpBuckets(SUBJECT_LOGINS_PER_MINUTE, 60_000);

  constructor(private readonly options: CloudLoginOptions) {
    this.now = options.now ?? Date.now;
  }

  /** 每个 `sub` 一个桶；空了答 `rate_limited`（`details.retryAfterMs`）。 */
  private admitSubject(claims: AssertionClaims): void {
    const verdict = this.subjects.take(
      `${claims.iss}\u0000${claims.sub}`,
      this.now(),
    );
    if (!verdict.ok) {
      throw fail("rate_limited", "这个账号登录得太频繁，请稍后重试", {
        retryAfterMs: verdict.retryAfterMs,
      });
    }
  }

  async login(input: {
    readonly assertion: string;
    readonly invitationToken?: string | undefined;
    /** 会话绑定的来源（规范拼法）。 */
    readonly origin: string;
    readonly remoteIp: string;
    readonly userAgent: string;
  }): Promise<CloudLoginResult> {
    const { claims, registration } = await this.options.verifier.verify(
      input.assertion,
    );
    this.admitSubject(claims);
    const provider = cloudProvider(registration.issuer);
    const { store, accounts, service } = this.options;

    const mapped = store.transaction((tx) => {
      const existing = tx.accounts.liveOAuth(provider, claims.sub);
      if (existing === undefined) return undefined;
      const principal = tx.accounts.principal(existing.principalId);
      if (principal === undefined || principal.disabledAtMs !== 0) {
        throw fail("forbidden", "这个账号在这台机器上已停用");
      }
      return principal;
    });

    let principalId: string;
    let created = false;
    let invitationId: string | undefined;
    if (mapped !== undefined) {
      principalId = mapped.principalId;
    } else {
      const token = input.invitationToken?.trim() ?? "";
      if (token === "") {
        throw fail("cloud_account_unlinked", "这个账号还没有关联到这台机器");
      }
      const parsed = parseToken(token);
      // 经链接来的断言带着它指向的那张邀请：令牌必须就是那一张。
      if (
        parsed === undefined ||
        (claims.link !== undefined && claims.link.invitationId !== parsed)
      ) {
        throw fail("invitation_invalid", "邀请无效或已用完");
      }
      const role = this.options.orgDefaultRole?.() ?? null;
      try {
        principalId = accounts.registerExternalWithInvitation({
          invitationId: parsed,
          token,
          displayName: clipName(claims.name, claims.sub.slice(0, 64)),
          provider,
          subject: claims.sub,
          createdVia: "cloud",
          ...(claims.org !== undefined && role !== null
            ? {
                defaultRole: {
                  role,
                  workspaceIds: this.options.cloud.workspaceIds(),
                },
              }
            : {}),
        }).principalId;
      } catch (error) {
        if (error instanceof IdentityError) {
          throw fail("invitation_invalid", "邀请无效或已用完");
        }
        throw error;
      }
      created = true;
      invitationId = parsed;
    }

    const credentials = (() => {
      try {
        return service.openSession({
          principalId,
          hostId: service.hostId(),
          origin: input.origin,
          deviceName: clipName(claims.device.name, "Armadra"),
          method: "cloud",
          remoteIp: input.remoteIp,
          userAgent: input.userAgent,
        });
      } catch (error) {
        if (error instanceof IdentityError) {
          throw fail("forbidden", "这个账号在这台机器上已停用");
        }
        throw error;
      }
    })();

    const principal = store.transaction((tx) => {
      const row = tx.accounts.principal(principalId);
      const at = this.now();
      tx.accounts.appendAudit({
        atMs: at,
        principalId,
        deviceId: credentials.principal.deviceId,
        action: "cloud.login",
        target: credentials.principal.sessionId,
        workspaceId: "",
        detailJson: JSON.stringify({
          iss: registration.issuer,
          sub: claims.sub,
          principalId,
          created,
          ...(claims.link === undefined ? {} : { link: claims.link.linkId }),
        }),
      });
      if (created && claims.link !== undefined) {
        tx.accounts.appendAudit({
          atMs: at,
          principalId,
          deviceId: credentials.principal.deviceId,
          action: "invitation.accept.link",
          target: invitationId ?? "",
          workspaceId: "",
          detailJson: JSON.stringify({
            iss: registration.issuer,
            linkId: claims.link.linkId,
          }),
        });
      }
      return row;
    });
    return {
      credentials,
      principal: {
        principalId,
        kind: principal?.kind === "owner" ? "owner" : "member",
        displayName: principal?.displayName ?? "",
      },
      created,
    };
  }

  /**
   * 把断言的 `sub` 映射到当前登录的人（契约 §31 `bind`）。已经映射给自己是幂等的；
   * 映射给了别人答 `conflict`（撤销那一条要在账号页由 owner 做）。
   */
  async bind(principalId: string, assertion: string): Promise<{ bound: true }> {
    const { claims, registration } =
      await this.options.verifier.verify(assertion);
    this.admitSubject(claims);
    const provider = cloudProvider(registration.issuer);
    this.options.store.transaction((tx) => {
      const principal = tx.accounts.principal(principalId);
      if (principal === undefined || principal.disabledAtMs !== 0) {
        throw fail("unauthenticated", "需要一个有效的会话");
      }
      const existing = tx.accounts.liveOAuth(provider, claims.sub);
      if (existing !== undefined) {
        if (existing.principalId === principalId) return;
        throw fail("conflict", "这个远程服务账号已经关联到别人");
      }
      const now = this.now();
      const credentialId = newId();
      tx.accounts.createCredential({
        credentialId,
        principalId,
        kind: "oauth",
        provider,
        subject: claims.sub,
        secretHash: Buffer.alloc(0),
        salt: Buffer.alloc(0),
        kdf: "",
        cost: 0,
        block: 0,
        parallel: 0,
        length: 0,
        createdAtMs: now,
        revokedAtMs: 0,
      });
      tx.accounts.appendAudit({
        atMs: now,
        principalId,
        deviceId: "",
        action: "cloud.bind",
        target: credentialId,
        workspaceId: "",
        detailJson: JSON.stringify({
          iss: registration.issuer,
          sub: claims.sub,
        }),
      });
    });
    return { bound: true };
  }
}
