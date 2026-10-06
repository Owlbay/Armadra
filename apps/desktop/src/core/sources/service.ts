/**
 * 客户端源表与远程服务的业务（契约 §33，平台规格 core 包 §1）。
 *
 * 三样东西在这里会合：行（`store.ts`）、凭据（`secrets.ts`，SecretStore）、两种
 * 对端（`remote-client.ts` 对远程服务，`source-client.ts` 对别的 core）。
 *
 * **旁路保证**：这里的每一次外呼都由用户动作触发、带超时，失败只落在那一次
 * 调用上。core 启动只 upsert 本机那一行（纯 SQLite），不联网；远程服务不可达
 * 或出错时，列表、本机行与其余域照常工作。
 *
 * **凭据边界**：刷新令牌只在 SecretStore；访问令牌只在内存（远程服务的那一把
 * 缓存到到期前一分钟）；口令只经过一次 `auth.login` 请求，不存、不记。答案里
 * 只有 `hasCredentials`；日志只记标识与码。
 */

import { randomBytes } from "node:crypto";

import { CoreFailure, fail } from "../http/errors";
import type {
  ClientSource,
  RemoteService,
  RemoteSourceSummary,
  SourceSession,
} from "@armadra/shared";
import { normalizeFingerprint, normalizeOrigin } from "./http-client";
import type {
  CloudSession,
  RemoteClient,
  RemoteEndpoint,
  SourceAssertion,
} from "./remote-client";
import type { SourceSecrets, StoredCredential } from "./secrets";
import type {
  NativeCredentials,
  SourceAddress,
  SourceClient,
} from "./source-client";
import type { RemoteRow, SourceRow, SourcesStore } from "./store";

/** D27：直连 hello 等多久就改走中继。 */
export const DIRECT_PROBE_MS = 1_500;
/** 远程服务的访问令牌提前这么久换新的。 */
const ACCESS_SLACK_MS = 60_000;

export interface SourcesLog {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/**
 * 本机到远程服务的登记（契约 §31，`identity/cloud`）在源表这一侧要的两件事。
 * 没装（未统一的库、测试）时当作「没登记」。
 */
export interface CloudRegistrations {
  registered(issuer: string): boolean;
  revoke(input: { issuer: string }): unknown;
}

export interface SourcesServiceOptions {
  readonly store: SourcesStore;
  readonly secrets: SourceSecrets;
  readonly remote: RemoteClient;
  readonly peer: SourceClient;
  /** 本机 core 的 `hostId`，也是 `local` 行的 `sourceId`。 */
  readonly hostId: () => string;
  /** 本机行的显示名。 */
  readonly hostLabel: () => string;
  readonly log: SourcesLog;
  /** 云登录域（A2-3）；装好之后 `registered` 与删远程服务前的撤销经它。 */
  readonly cloud?: () => CloudRegistrations | undefined;
  readonly now?: () => number;
  readonly newId?: () => string;
}

interface CachedAccess {
  readonly accessToken: string;
  readonly accessExpiresAtMs: number;
}

/** 经中继时，中继就是远程服务本身（个人中转）才沿用它的 CA 指纹。 */
function relayFingerprint(relayBaseUrl: string, remote: RemoteRow): string {
  try {
    return new URL(relayBaseUrl).origin === remote.issuer
      ? remote.fingerprint
      : "";
  } catch {
    return "";
  }
}

function wsBaseOf(httpBase: string): string {
  return httpBase.replace(/^http/, "ws");
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** 显示名：1–128 个字符（表的约束）；不给就是 `undefined`。 */
function checkLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 128) {
    throw fail("bad_request", "名称应为 1 到 128 个字符");
  }
  return trimmed;
}

/** `#pair=<票>&fp=<指纹>` 的网页链接，或 `armadra://pair?host=…&ticket=…&fp=…`。 */
export function parsePairLink(link: string): {
  origin: string;
  ticket: string;
  fingerprint: string;
} {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw fail("bad_request", "配对链接不是一个合法的地址");
  }
  if (url.protocol === "armadra:") {
    const host = url.searchParams.get("host") ?? "";
    const ticket = url.searchParams.get("ticket") ?? "";
    if (host === "" || ticket === "") {
      throw fail("bad_request", "配对链接缺少地址或票");
    }
    return {
      origin: normalizeOrigin(`https://${host}`),
      ticket,
      fingerprint: url.searchParams.get("fp") ?? "",
    };
  }
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const ticket = fragment.get("pair") ?? "";
  if (ticket === "") throw fail("bad_request", "配对链接里没有票");
  return {
    origin: normalizeOrigin(url.origin),
    ticket,
    fingerprint: fragment.get("fp") ?? "",
  };
}

export class SourcesService {
  private readonly store: SourcesStore;
  private readonly secrets: SourceSecrets;
  private readonly remote: RemoteClient;
  private readonly peer: SourceClient;
  private readonly now: () => number;
  private readonly newId: () => string;
  /** 远程服务的访问令牌：只在内存。 */
  private readonly access = new Map<string, CachedAccess>();
  private readonly capabilities = new Map<string, readonly string[]>();
  /**
   * 同一把刷新令牌一次只换一次：个人中转与 core 都对旧令牌再出现判为盗用、撤销
   * 整台设备，并发的两次换票会把自己登出。
   */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly options: SourcesServiceOptions) {
    this.store = options.store;
    this.secrets = options.secrets;
    this.remote = options.remote;
    this.peer = options.peer;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => randomBytes(16).toString("hex"));
  }

  /** 本机那一行：启动时 upsert，不可删。只碰 SQLite。 */
  ensureLocal(): void {
    const sourceId = this.options.hostId();
    const existing = this.store.get(sourceId);
    const label = clip(this.options.hostLabel().trim(), 128) || "local";
    this.store.upsert({
      sourceId,
      kind: "local",
      label: existing?.kind === "local" ? existing.label : label,
      baseUrl: "",
      relayOrigin: "",
      fingerprint: "",
      cloudIssuer: "",
      principalHint: "",
      addedAtMs: existing?.addedAtMs ?? this.now(),
      lastOkAtMs: existing?.lastOkAtMs ?? 0,
      orderIndex: existing?.orderIndex ?? 0,
    });
  }

  private async serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.inflight.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.inflight.set(key, next);
    try {
      return await next;
    } finally {
      if (this.inflight.get(key) === next) this.inflight.delete(key);
    }
  }

  /* ------------------------------ 出参 ------------------------------ */

  private async sourceJson(row: SourceRow): Promise<ClientSource> {
    return {
      ...row,
      // 本机不要凭据，永远连得上。
      hasCredentials:
        row.kind === "local"
          ? true
          : await this.secrets.hasSource(row.sourceId),
    };
  }

  private async remoteJson(row: RemoteRow): Promise<RemoteService> {
    return {
      ...row,
      // 本机是否登记到它（契约 §31 的登记表，迁移 0040）。
      registered: this.options.cloud?.()?.registered(row.issuer) ?? false,
      hasCredentials: (await this.secrets.remote(row.serviceId)) !== undefined,
    };
  }

  async list(): Promise<{ sources: ClientSource[]; remotes: RemoteService[] }> {
    const sources = await Promise.all(
      this.store.list().map((row) => this.sourceJson(row)),
    );
    const remotes = await Promise.all(
      this.store.remotes().map((row) => this.remoteJson(row)),
    );
    return { sources, remotes };
  }

  private row(sourceId: string): SourceRow {
    const row = this.store.get(sourceId);
    if (row === undefined) throw fail("not_found", "没有这个源");
    return row;
  }

  private remoteRow(serviceId: string): RemoteRow {
    const row = this.store.remote(serviceId);
    if (row === undefined) throw fail("not_found", "没有这个远程服务");
    return row;
  }

  /* ---------------------------- 直连源 ----------------------------- */

  async addDirect(input: {
    pairLink?: string | undefined;
    origin?: string | undefined;
    code?: string | undefined;
    fingerprint?: string | undefined;
    label?: string | undefined;
  }): Promise<ClientSource> {
    const label = checkLabel(input.label);
    let origin: string;
    let ticket: string;
    let fingerprint: string;
    if (input.pairLink !== undefined && input.pairLink !== "") {
      const parsed = parsePairLink(input.pairLink);
      origin = parsed.origin;
      ticket = parsed.ticket;
      fingerprint = normalizeFingerprint(
        input.fingerprint ?? parsed.fingerprint,
      );
      if (
        input.fingerprint !== undefined &&
        parsed.fingerprint !== "" &&
        normalizeFingerprint(parsed.fingerprint) !== fingerprint
      ) {
        throw fail("fingerprint_mismatch", "链接里的指纹与给定的不一致");
      }
    } else if (
      input.origin !== undefined &&
      input.origin !== "" &&
      input.code !== undefined &&
      input.code !== ""
    ) {
      origin = normalizeOrigin(input.origin);
      fingerprint = normalizeFingerprint(input.fingerprint);
      const exchanged = await this.peer.exchangeCode(
        { base: origin, fingerprint },
        input.code,
      );
      if (exchanged.ticket === "") {
        throw fail("source_unauthorized", "配对码无效或已过期");
      }
      // 票绑在签发它的来源上；对端说的来源与我们连的不是同一个，就按它的连。
      if (
        exchanged.origin !== "" &&
        normalizeOrigin(exchanged.origin) !== origin
      ) {
        origin = normalizeOrigin(exchanged.origin);
      }
      if (
        fingerprint !== "" &&
        exchanged.fingerprint !== "" &&
        normalizeFingerprint(exchanged.fingerprint) !== fingerprint
      ) {
        throw fail("fingerprint_mismatch", "对端报的指纹与给定的不一致");
      }
      ticket = exchanged.ticket;
    } else {
      throw fail("bad_request", "要给配对链接，或地址加配对码");
    }

    const address: SourceAddress = { base: origin, fingerprint };
    const hello = await this.peer.hello(address, 10_000);
    if (hello.hostId === this.options.hostId()) {
      throw fail("conflict", "这就是本机");
    }
    const credentials = await this.peer.pair(address, ticket);
    if (credentials.hostId !== "" && credentials.hostId !== hello.hostId) {
      throw fail("source_unauthorized", "配对答案与对端身份不一致");
    }
    const sourceId = hello.hostId;
    await this.secrets.putSource(sourceId, origin, {
      refreshToken: credentials.refreshToken,
      deviceId: credentials.deviceId,
    });
    const existing = this.store.get(sourceId);
    const at = this.now();
    const row = this.store.upsert({
      sourceId,
      kind: existing?.kind === "relayed" ? "relayed" : "direct",
      label: label ?? existing?.label ?? clip(new URL(origin).host, 128),
      baseUrl: origin,
      relayOrigin: existing?.relayOrigin ?? "",
      fingerprint,
      cloudIssuer: existing?.cloudIssuer ?? "",
      principalHint: credentials.principalHint,
      addedAtMs: existing?.addedAtMs ?? at,
      lastOkAtMs: at,
      orderIndex: existing?.orderIndex ?? this.store.nextOrder(),
    });
    this.options.log.info("added a direct source", { sourceId });
    return this.sourceJson(row);
  }

  async update(input: {
    sourceId: string;
    label?: string | undefined;
    orderIndex?: number | undefined;
    baseUrl?: string | undefined;
    relayOrigin?: string | undefined;
  }): Promise<ClientSource> {
    const row = this.row(input.sourceId);
    const label = checkLabel(input.label);
    if (
      row.kind === "local" &&
      (input.baseUrl !== undefined || input.relayOrigin !== undefined)
    ) {
      throw fail("bad_request", "本机没有地址可改");
    }
    const baseUrl =
      input.baseUrl === undefined
        ? row.baseUrl
        : input.baseUrl === ""
          ? ""
          : normalizeOrigin(input.baseUrl);
    const relayOrigin =
      input.relayOrigin === undefined
        ? row.relayOrigin
        : input.relayOrigin === ""
          ? ""
          : normalizeOrigin(input.relayOrigin);
    const updated = this.store.upsert({
      ...row,
      label: label ?? row.label,
      orderIndex: input.orderIndex ?? row.orderIndex,
      baseUrl,
      relayOrigin,
    });
    return this.sourceJson(updated);
  }

  async remove(sourceId: string): Promise<Record<string, never>> {
    const row = this.row(sourceId);
    if (row.kind === "local") throw fail("conflict", "本机这一行不能删");
    await this.secrets.clearSource(sourceId);
    this.store.delete(sourceId);
    this.options.log.info("removed a source", { sourceId });
    return {};
  }

  async forget(sourceId: string): Promise<Record<string, never>> {
    const row = this.row(sourceId);
    if (row.kind === "local") throw fail("conflict", "本机没有凭据可断开");
    await this.secrets.clearSource(sourceId);
    return {};
  }

  /* ----------------------------- 换票 ------------------------------ */

  private async refreshAt(
    sourceId: string,
    key: string,
    address: SourceAddress,
  ): Promise<NativeCredentials> {
    return this.serial(`source ${sourceId} ${key}`, async () => {
      const stored = (await this.secrets.source(sourceId)).byOrigin[key];
      if (stored === undefined) {
        throw fail("source_unauthorized", "这个源没有保存的登录");
      }
      let fresh: NativeCredentials;
      try {
        fresh = await this.peer.refresh(address, stored.refreshToken);
      } catch (error) {
        if (
          error instanceof CoreFailure &&
          error.code === "source_unauthorized"
        ) {
          // 刷新令牌死了：留着它只会让下一次再撞一次。
          await this.secrets.putSource(sourceId, key, undefined);
        }
        throw error;
      }
      await this.secrets.putSource(sourceId, key, {
        refreshToken: fresh.refreshToken,
        deviceId: fresh.deviceId || stored.deviceId,
      });
      return fresh;
    });
  }

  private ok(sourceId: string): void {
    this.store.touchOk(sourceId, this.now());
  }

  private async direct(row: SourceRow): Promise<SourceSession> {
    const fresh = await this.refreshAt(row.sourceId, row.baseUrl, {
      base: row.baseUrl,
      fingerprint: row.fingerprint,
    });
    this.ok(row.sourceId);
    return {
      accessToken: fresh.accessToken,
      accessExpiresAtMs: fresh.accessExpiresAtMs,
      httpBase: row.baseUrl,
      wsBase: wsBaseOf(row.baseUrl),
      via: "direct",
    };
  }

  private relayKey(row: SourceRow, assertion: SourceAssertion): string {
    return row.relayOrigin !== ""
      ? row.relayOrigin
      : assertion.relayOrigin || assertion.relayBaseUrl;
  }

  /** 经中继：先用存着的刷新令牌，401 时用断言重新 `cloud/login`。 */
  private async relayed(
    row: SourceRow,
    remote: RemoteRow,
    assertion: SourceAssertion,
  ): Promise<SourceSession> {
    if (!assertion.online) throw fail("source_offline", "这台机器当前不在线");
    const address: SourceAddress = {
      base: assertion.relayBaseUrl,
      fingerprint: relayFingerprint(assertion.relayBaseUrl, remote),
      relayToken: assertion.relayToken,
    };
    const key = this.relayKey(row, assertion);
    let fresh: NativeCredentials;
    try {
      fresh = await this.refreshAt(row.sourceId, key, address);
    } catch (error) {
      if (
        !(error instanceof CoreFailure) ||
        error.code !== "source_unauthorized"
      ) {
        throw error;
      }
      fresh = await this.serial(`source ${row.sourceId} ${key}`, async () => {
        const logged = await this.peer.cloudLogin(address, assertion.assertion);
        await this.secrets.putSource(row.sourceId, key, {
          refreshToken: logged.refreshToken,
          deviceId: logged.deviceId,
        });
        return logged;
      });
    }
    this.ok(row.sourceId);
    return {
      accessToken: fresh.accessToken,
      accessExpiresAtMs: fresh.accessExpiresAtMs,
      httpBase: assertion.relayBaseUrl,
      wsBase: wsBaseOf(assertion.relayBaseUrl),
      via: "relayed",
      relayToken: assertion.relayToken,
      relayTokenExpiresAtMs: assertion.relayTokenExpiresAtMs,
    };
  }

  private async assertionFor(
    remote: RemoteRow,
    sourceId: string,
  ): Promise<SourceAssertion> {
    if (remote.kind === "saas") {
      throw fail("not_implemented", "SaaS 远程服务尚未开放");
    }
    const token = await this.remoteAccess(remote);
    return this.remote.assertion(
      this.endpoint(remote),
      token.accessToken,
      sourceId,
    );
  }

  /**
   * `sources.session`（规格 §1.5、D27）：`via` 省略时并行问直连的 hello（1.5 秒）
   * 与远程服务的断言；直连通且 `hostId` 就是这个源 → 直连换票，否则走中继；都
   * 不行 → `source_unreachable`。
   */
  async session(
    sourceId: string,
    via?: "direct" | "relayed",
  ): Promise<SourceSession> {
    const row = this.row(sourceId);
    if (row.kind === "local") throw fail("conflict", "本机不需要换票");
    const credentials = await this.secrets.source(sourceId);
    const canDirect =
      row.baseUrl !== "" && credentials.byOrigin[row.baseUrl] !== undefined;
    const remote =
      row.cloudIssuer === ""
        ? undefined
        : this.store.remoteByIssuer(row.cloudIssuer);
    const canRelay = remote !== undefined;

    if (via === "direct") {
      if (row.baseUrl === "")
        throw fail("source_unreachable", "这个源没有直连地址");
      return this.direct(row);
    }
    if (via === "relayed") {
      if (remote === undefined) {
        throw fail("source_unreachable", "这个源没有可用的远程服务");
      }
      return this.relayed(
        row,
        remote,
        await this.assertionFor(remote, sourceId),
      );
    }
    if (!canDirect && !canRelay) {
      throw fail(
        row.baseUrl === "" && row.cloudIssuer === ""
          ? "source_unreachable"
          : "source_unauthorized",
        "这个源没有保存的登录",
      );
    }

    const [hello, assertion] = await Promise.allSettled([
      canDirect
        ? this.peer.hello(
            { base: row.baseUrl, fingerprint: row.fingerprint },
            DIRECT_PROBE_MS,
          )
        : Promise.reject(fail("source_unreachable", "没有直连")),
      canRelay
        ? this.assertionFor(remote, sourceId)
        : Promise.reject(fail("source_unreachable", "没有中继")),
    ]);
    const failures: unknown[] = [];
    if (hello.status === "fulfilled" && hello.value.hostId === sourceId) {
      try {
        return await this.direct(row);
      } catch (error) {
        failures.push(error);
      }
    } else if (hello.status === "rejected") {
      failures.push(hello.reason);
    }
    if (assertion.status === "fulfilled" && remote !== undefined) {
      return this.relayed(row, remote, assertion.value);
    }
    if (assertion.status === "rejected") failures.push(assertion.reason);
    // 拒绝比不可达更有用：页面据此提示重新登录，而不是「连不上」。
    const telling = failures.find(
      (error) =>
        error instanceof CoreFailure &&
        (error.code === "source_unauthorized" ||
          error.code === "source_offline" ||
          error.code === "fingerprint_mismatch"),
    );
    if (telling !== undefined) throw telling;
    throw fail("source_unreachable", "直连与中继都连不上这个源");
  }

  /* --------------------------- 远程服务 ---------------------------- */

  private endpoint(row: RemoteRow): RemoteEndpoint {
    return { issuer: row.issuer, fingerprint: row.fingerprint };
  }

  private remember(serviceId: string, session: CloudSession): CachedAccess {
    const cached = {
      accessToken: session.accessToken,
      accessExpiresAtMs: session.accessExpiresAtMs,
    };
    this.access.set(serviceId, cached);
    return cached;
  }

  /** 远程服务的访问令牌：缓存够新就用，否则用刷新令牌换（旋转写回）。 */
  private async remoteAccess(row: RemoteRow): Promise<CachedAccess> {
    const cached = this.access.get(row.serviceId);
    if (
      cached !== undefined &&
      cached.accessExpiresAtMs - ACCESS_SLACK_MS > this.now()
    ) {
      return cached;
    }
    return this.serial(`remote ${row.serviceId}`, async () => {
      const again = this.access.get(row.serviceId);
      if (
        again !== undefined &&
        again.accessExpiresAtMs - ACCESS_SLACK_MS > this.now()
      ) {
        return again;
      }
      const stored = await this.secrets.remote(row.serviceId);
      if (stored === undefined) {
        throw fail("source_unauthorized", "远程服务没有保存的登录");
      }
      let session: CloudSession;
      try {
        session = await this.remote.refresh(
          this.endpoint(row),
          stored.refreshToken,
        );
      } catch (error) {
        if (
          error instanceof CoreFailure &&
          error.code === "source_unauthorized"
        ) {
          await this.secrets.clearRemote(row.serviceId);
          this.access.delete(row.serviceId);
        }
        throw error;
      }
      await this.secrets.putRemote(row.serviceId, {
        refreshToken: session.refreshToken,
        deviceId: session.deviceId || stored.deviceId,
      });
      this.store.touchRemoteOk(row.serviceId, this.now());
      return this.remember(row.serviceId, session);
    });
  }

  async remoteAdd(
    input:
      | {
          kind: "personal";
          issuer: string;
          account: string;
          password: string;
          label?: string | undefined;
          fingerprint?: string | undefined;
        }
      | { kind: "saas"; issuer: string; label?: string | undefined },
  ): Promise<{ remote: RemoteService; next: "ready" }> {
    if (input.kind === "saas") {
      // SaaS 服务端预留（总计划 §12.2）：类型保留，能力就绪前答明确的 501。
      throw fail("not_implemented", "SaaS 远程服务尚未开放");
    }
    const issuer = normalizeOrigin(input.issuer);
    const fingerprint = normalizeFingerprint(input.fingerprint);
    const label = checkLabel(input.label);
    const endpoint: RemoteEndpoint = { issuer, fingerprint };
    const info = await this.remote.info(endpoint);
    if (info.mode !== "personal") {
      throw fail("bad_request", "这个地址不是个人中转");
    }
    const session = await this.remote.login(
      endpoint,
      input.account,
      input.password,
    );
    const existing = this.store.remoteByIssuer(issuer);
    const serviceId = existing?.serviceId ?? this.newId();
    const at = this.now();
    await this.secrets.putRemote(serviceId, {
      refreshToken: session.refreshToken,
      deviceId: session.deviceId,
    });
    const row = this.store.upsertRemote({
      serviceId,
      kind: "personal",
      issuer,
      label: label ?? existing?.label ?? clip(new URL(issuer).host, 128),
      accountHint: clip(input.account, 256),
      fingerprint,
      addedAtMs: existing?.addedAtMs ?? at,
      lastOkAtMs: at,
    });
    this.remember(serviceId, session);
    this.capabilities.set(serviceId, info.capabilities);
    this.options.log.info("signed in to a remote service", { serviceId });
    return { remote: await this.remoteJson(row), next: "ready" };
  }

  async remoteDevicePoll(serviceId: string): Promise<never> {
    this.remoteRow(serviceId);
    // 只有 SaaS 的设备码登录要轮询；个人中转加入即就绪。
    throw fail("not_implemented", "设备码登录尚未开放");
  }

  async remoteRemove(serviceId: string): Promise<Record<string, never>> {
    const row = this.remoteRow(serviceId);
    // 本机登记到它的，先撤销登记（停隧道、不再认它签的断言）：删掉远程服务却
    // 留着对它的信任，等于留一扇没人看着的门。
    const cloud = this.options.cloud?.();
    if (cloud?.registered(row.issuer) === true) {
      cloud.revoke({ issuer: row.issuer });
    }
    // 尽力登出：远程服务不可达不拦删除（旁路保证）。
    const cached = this.access.get(serviceId);
    if (cached !== undefined && cached.accessExpiresAtMs > this.now()) {
      await this.remote
        .logout(this.endpoint(row), cached.accessToken)
        .catch(() => undefined);
    }
    this.access.delete(serviceId);
    this.capabilities.delete(serviceId);
    await this.secrets.clearRemote(serviceId);
    this.store.deleteRemote(serviceId);
    this.options.log.info("removed a remote service", { serviceId });
    return {};
  }

  async remoteSources(
    serviceId: string,
  ): Promise<{ sources: RemoteSourceSummary[] }> {
    const row = this.remoteRow(serviceId);
    if (row.kind === "saas")
      throw fail("not_implemented", "SaaS 远程服务尚未开放");
    const token = await this.remoteAccess(row);
    const listed = await this.remote.sources(
      this.endpoint(row),
      token.accessToken,
    );
    return {
      sources: listed.map((source) => ({
        ...source,
        mounted: this.store.get(source.sourceId) !== undefined,
      })),
    };
  }

  async mount(input: {
    serviceId: string;
    sourceId: string;
    label?: string | undefined;
  }): Promise<ClientSource> {
    const remote = this.remoteRow(input.serviceId);
    const label = checkLabel(input.label);
    if (input.sourceId === this.options.hostId()) {
      throw fail("conflict", "这就是本机");
    }
    const assertion = await this.assertionFor(remote, input.sourceId);
    if (!assertion.online) throw fail("source_offline", "这台机器当前不在线");
    const address: SourceAddress = {
      base: assertion.relayBaseUrl,
      fingerprint: relayFingerprint(assertion.relayBaseUrl, remote),
      relayToken: assertion.relayToken,
    };
    const credentials = await this.peer.cloudLogin(
      address,
      assertion.assertion,
    );
    if (credentials.hostId !== "" && credentials.hostId !== input.sourceId) {
      throw fail("source_unauthorized", "中继另一端不是这个源");
    }
    const existing = this.store.get(input.sourceId);
    const relayOrigin =
      assertion.relayOrigin || new URL(assertion.relayBaseUrl).origin;
    const key = existing?.relayOrigin || relayOrigin;
    await this.secrets.putSource(input.sourceId, key, {
      refreshToken: credentials.refreshToken,
      deviceId: credentials.deviceId,
    });
    let name = "";
    if (label === undefined && existing === undefined) {
      // 显示名取远程服务目录里的那个；拿不到不拦挂载。
      const token = this.access.get(remote.serviceId);
      if (token !== undefined) {
        name = await this.remote
          .sources(this.endpoint(remote), token.accessToken)
          .then(
            (rows) =>
              rows.find((one) => one.sourceId === input.sourceId)?.name ?? "",
          )
          .catch(() => "");
      }
    }
    const at = this.now();
    const row = this.store.upsert({
      sourceId: input.sourceId,
      kind: existing?.kind === "direct" ? "direct" : "relayed",
      label: clip(
        label ?? existing?.label ?? (name.trim() || input.sourceId.slice(0, 8)),
        128,
      ),
      baseUrl: existing?.baseUrl ?? "",
      relayOrigin: key,
      fingerprint: existing?.fingerprint ?? "",
      cloudIssuer: remote.issuer,
      principalHint: credentials.principalHint,
      addedAtMs: existing?.addedAtMs ?? at,
      lastOkAtMs: at,
      orderIndex: existing?.orderIndex ?? this.store.nextOrder(),
    });
    this.options.log.info("mounted a relayed source", {
      sourceId: input.sourceId,
      serviceId: remote.serviceId,
    });
    return this.sourceJson(row);
  }

  async remoteSession(serviceId: string): Promise<{
    accessToken: string;
    accessExpiresAtMs: number;
    issuer: string;
    capabilities: string[];
  }> {
    const row = this.remoteRow(serviceId);
    if (row.kind === "saas")
      throw fail("not_implemented", "SaaS 远程服务尚未开放");
    const token = await this.remoteAccess(row);
    let capabilities = this.capabilities.get(serviceId);
    if (capabilities === undefined) {
      capabilities = (await this.remote.info(this.endpoint(row))).capabilities;
      this.capabilities.set(serviceId, capabilities);
    }
    return {
      accessToken: token.accessToken,
      accessExpiresAtMs: token.accessExpiresAtMs,
      issuer: row.issuer,
      capabilities: [...capabilities],
    };
  }
}

export type { StoredCredential };
