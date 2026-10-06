/**
 * 登记、撤销、状态与可信来源（平台规格 core 包 §2.5，契约 §31）。
 *
 * 登记的顺序：本地先判（地址、令牌、已登记）→ 读 `/.well-known/armadra-platform`
 * （协议 major 必须相同、自报的 issuer 必须就是填的地址）→ 源密钥对（没有就生成）
 * → `POST /v1/sources/register` → 取 JWKS → 写行 → 起隧道（不等）→ 审计。任何一步
 * 失败都不留行。只实现个人中转这一个签发方：`saas` 答 `not_implemented`，形状与
 * 流程不变，SaaS 服务端就绪后放开这一处即可（总计划 §12.2）。
 *
 * 撤销只停隧道、记撤销时刻；已经映射过的账号与授予是 owner 的事，在账号页逐个撤。
 */

import { hostname } from "node:os";

import type { Ed25519PublicJwk } from "@armadra/platform-protocol/assertion";
import type {
  CloudRegisterOutput,
  CloudStatusOutput,
  TunnelStatus,
} from "@armadra/platform-protocol/core-api";
import { PROTOCOL_VERSION } from "@armadra/platform-protocol";

import { fail } from "../../http/errors";
import { normalizeOrigin } from "../../sources/http-client";
import { audit } from "../audit";
import { canonicalOrigin } from "../origin";
import type { IdentityStore } from "../store";
import type { CloudClient } from "./cloud-client";
import { SOURCE_KEY_REF, type SourceKey } from "./source-key";
import type { CloudStore, RegistrationRow } from "./store";

/**
 * 隧道（A3-2 的 `RelayService`）在登记这一侧要的三件事。没装隧道时是
 * {@link IDLE_RELAY}：什么都不做，状态恒为 `disabled`。
 */
export interface CloudRelay {
  /** 起这个 issuer 的隧道；不等、不抛（失败记在它自己的状态里）。 */
  start(issuer: string): void;
  stop(issuer: string): void;
  status(issuer: string): TunnelStatus;
}

export const IDLE_TUNNEL: TunnelStatus = {
  state: "disabled",
  node: null,
  since: null,
  streams: 0,
  lastError: null,
};

export const IDLE_RELAY: CloudRelay = {
  start: () => undefined,
  stop: () => undefined,
  status: () => ({ ...IDLE_TUNNEL }),
};

/** 一份可信来源最多这么多条。 */
const MAX_ORIGINS = 32;

export interface CloudRegistryOptions {
  readonly cloud: CloudStore;
  readonly identity: IdentityStore;
  readonly client: CloudClient;
  readonly sourceKey: SourceKey;
  readonly hostId: () => string;
  readonly shell: "desktop" | "server";
  readonly coreVersion: string;
  /** 本机 hello 报的能力名，登记时交给远程服务。 */
  readonly capabilities: () => readonly string[];
  readonly relay: () => CloudRelay;
  readonly now?: () => number;
  readonly log?: {
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

/** 来源列表的规范拼法（只收 https，回环另收 http），去重、截断；不合法的丢掉。 */
function origins(values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const canonical = canonicalOrigin(value);
    if (canonical !== undefined) seen.add(canonical);
  }
  return [...seen].slice(0, MAX_ORIGINS);
}

/** 地址的规范拼法；不合法答 `bad_request`。 */
function issuerOf(value: string): string {
  return normalizeOrigin(value);
}

export class CloudRegistry {
  private readonly now: () => number;
  private readonly inflight = new Set<string>();

  constructor(private readonly options: CloudRegistryOptions) {
    this.now = options.now ?? Date.now;
  }

  /** 这个 issuer 有没有有效登记（`sources.remoteJson` 的 `registered`）。 */
  registered(issuer: string): boolean {
    return this.options.cloud.live(issuer) !== undefined;
  }

  /** 登记的那个人：请求的主体；没有请求主体（桌面壳的本机动作）时是 owner。 */
  private registrant(principalId: string | undefined): string {
    if (principalId !== undefined && principalId !== "") return principalId;
    const owner = this.options.identity.transaction((tx) => tx.owner());
    if (owner === undefined) {
      throw fail("forbidden", "这台机器还没有主人，不能登记");
    }
    return owner.principalId;
  }

  async register(
    input: { issuer: string; registrationToken: string; label?: string },
    principalId?: string,
  ): Promise<CloudRegisterOutput> {
    const issuer = issuerOf(input.issuer);
    const token = input.registrationToken.trim();
    if (token === "" || token.length > 1024) {
      throw fail("bad_request", "登记令牌不对");
    }
    const label = input.label?.trim();
    if (label !== undefined && (label.length < 1 || label.length > 128)) {
      throw fail("bad_request", "名称应为 1 到 128 个字符");
    }
    const registeredBy = this.registrant(principalId);
    if (
      this.options.cloud.live(issuer) !== undefined ||
      this.inflight.has(issuer)
    ) {
      throw fail("cloud_already_registered", "已经登记到这个远程服务");
    }
    this.inflight.add(issuer);
    try {
      return await this.registerOnce(issuer, token, label, registeredBy);
    } finally {
      this.inflight.delete(issuer);
    }
  }

  private async registerOnce(
    issuer: string,
    registrationToken: string,
    label: string | undefined,
    registeredBy: string,
  ): Promise<CloudRegisterOutput> {
    const { client, cloud, sourceKey } = this.options;
    const fingerprint = cloud.remoteFingerprint(issuer);
    const info = await client.info(issuer, fingerprint);
    if (info.protocol.major !== PROTOCOL_VERSION.major) {
      throw fail("protocol_unsupported", "远程服务的协议版本不兼容");
    }
    if (!this.sameIssuer(info.issuer, issuer)) {
      throw fail("cloud_issuer_mismatch", "远程服务自报的地址与填写的不一致");
    }
    if (info.mode !== "personal") {
      // SaaS 签发方只留接口（总计划 §12.2）：形状与流程相同，服务端就绪后放开。
      throw fail("not_implemented", "SaaS 远程服务尚未开放");
    }
    const sourceId = this.options.hostId();
    const publicKey: Ed25519PublicJwk = await sourceKey.publicJwk();
    const name = (label ?? (hostname().trim() || "Armadra")).slice(0, 128);
    const registration = await client.register(issuer, fingerprint, {
      registrationToken,
      sourceId,
      publicKey,
      name,
      kind: this.options.shell,
      coreVersion: this.options.coreVersion,
      capabilities: [...this.options.capabilities()],
      protocol: {
        major: PROTOCOL_VERSION.major,
        minor: PROTOCOL_VERSION.minor,
      },
    });
    if (!this.sameIssuer(registration.issuer, issuer)) {
      throw fail(
        "cloud_issuer_mismatch",
        "远程服务登记答案里的地址与填写的不一致",
      );
    }
    if (registration.sourceId !== sourceId) {
      throw fail("source_unreachable", "远程服务登记的不是这台机器");
    }
    // 公钥集只认同一个来源下的地址：登记答案不该把验签的钥指到别处。
    let jwksOrigin = "";
    try {
      jwksOrigin = new URL(registration.jwksUrl).origin;
    } catch {
      jwksOrigin = "";
    }
    if (jwksOrigin !== issuer) {
      throw fail("cloud_issuer_mismatch", "公钥集不在远程服务自己的地址下");
    }
    const jwks = await client.jwks(registration.jwksUrl, fingerprint);
    if (jwks.keys.length === 0) {
      throw fail("source_unreachable", "远程服务的公钥集是空的");
    }
    const at = this.now();
    const row: RegistrationRow = {
      issuer,
      sourceKeyRef: SOURCE_KEY_REF,
      jwksJson: JSON.stringify({ keys: jwks.keys }),
      jwksUrl: registration.jwksUrl,
      jwksFetchedAtMs: at,
      trustedOrigins: origins(registration.trustedOrigins),
      relayOrigins: origins(registration.relayOrigins),
      ownerAccountId: registration.ownerAccountId.slice(0, 256),
      label: label ?? "",
      mode: info.mode,
      registeredBy,
      registeredAtMs: at,
      revokedAtMs: 0,
    };
    cloud.put(row);
    this.startTunnel(issuer);
    audit({
      action: "cloud.register",
      target: issuer,
      principalId: registeredBy,
      detail: { issuer, mode: info.mode },
    });
    return {
      issuer,
      sourceId,
      relayOrigins: [...row.relayOrigins],
      trustedOrigins: [...row.trustedOrigins],
      tunnel: this.tunnel(issuer),
    };
  }

  private sameIssuer(reported: string, issuer: string): boolean {
    try {
      return normalizeOrigin(reported) === issuer;
    } catch {
      return false;
    }
  }

  private startTunnel(issuer: string): void {
    try {
      this.options.relay().start(issuer);
    } catch (error) {
      // 隧道起不来不影响登记：它有自己的状态与重试（A3-2）。
      this.options.log?.warn("cloud tunnel did not start", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private tunnel(issuer: string): TunnelStatus {
    try {
      return this.options.relay().status(issuer);
    } catch {
      return { ...IDLE_TUNNEL };
    }
  }

  /** 撤销：停隧道，记撤销时刻；没有有效登记答 `not_found`。 */
  revoke(
    input: { issuer: string },
    principalId?: string,
  ): Record<string, never> {
    let issuer = input.issuer;
    try {
      issuer = issuerOf(input.issuer);
    } catch {
      // 不是合法地址就按原样找：找不到答 not_found。
    }
    if (!this.options.cloud.revoke(issuer, this.now())) {
      throw fail("not_found", "没有登记到这个远程服务");
    }
    try {
      this.options.relay().stop(issuer);
    } catch {
      // 停不掉的隧道在下一次握手时会被中继拒绝；登记已经撤了。
    }
    audit({
      action: "cloud.revoke",
      target: issuer,
      ...(principalId === undefined ? {} : { principalId }),
      detail: { issuer },
    });
    return {};
  }

  async status(): Promise<CloudStatusOutput> {
    const registrations = this.options.cloud.list().map((row) => ({
      issuer: row.issuer,
      mode: row.mode,
      ...(row.label === "" ? {} : { label: row.label }),
      jwksFetchedAtMs: row.jwksFetchedAtMs,
      trustedOrigins: [...row.trustedOrigins],
      relayOrigins: [...row.relayOrigins],
      registeredAtMs: row.registeredAtMs,
      tunnel: this.tunnel(row.issuer),
    }));
    return {
      registrations,
      sourcePublicKey: await this.options.sourceKey.publicJwk(),
      sourceId: this.options.hostId(),
    };
  }

  trustedOrigins(input: { issuer: string; origins: string[] }): {
    origins: string[];
  } {
    let issuer = input.issuer;
    try {
      issuer = issuerOf(input.issuer);
    } catch {
      // 同 revoke：按原样找。
    }
    if (this.options.cloud.live(issuer) === undefined) {
      throw fail("not_found", "没有登记到这个远程服务");
    }
    if (input.origins.length > MAX_ORIGINS) {
      throw fail("bad_request", `可信来源最多 ${MAX_ORIGINS} 条`);
    }
    const next: string[] = [];
    for (const value of input.origins) {
      const canonical = canonicalOrigin(value.trim());
      if (canonical === undefined) {
        throw fail("bad_request", "可信来源应为 https 来源（回环另收 http）");
      }
      if (!next.includes(canonical)) next.push(canonical);
    }
    this.options.cloud.setTrustedOrigins(issuer, next);
    return { origins: next };
  }
}
