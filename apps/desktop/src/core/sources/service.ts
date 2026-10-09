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
import {
  type ClientSource,
  type ClientSourceRoute,
  type RemoteService,
  type RemoteSourceSummary,
  type SourceSession,
  parseJoinLink,
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
import type {
  RemoteRow,
  RouteRow,
  RouteVia,
  SourceRow,
  SourcesStore,
} from "./store";

/** D27：直连 hello 等多久就改走中继。 */
export const DIRECT_PROBE_MS = 1_500;
/** 选路时最多同时向几条中继要断言（契约 §55）。 */
export const RELAY_RACE = 3;
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
  /** 本机撤销，并尽力删中继侧的源记录（契约 §31.4）。 */
  revoke(input: { issuer: string }): Promise<unknown>;
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
  /**
   * 首次添加、没给指纹且系统不信任对端证书时，问出对端的信任锚指纹给人核对
   * （`http-client.ts` 的 `presentedAnchor`）。不给就不探（测试的假对端）。
   */
  readonly anchorProbe?: (origin: string) => Promise<string | null>;
  readonly now?: () => number;
  readonly newId?: () => string;
}

interface CachedAccess {
  readonly accessToken: string;
  readonly accessExpiresAtMs: number;
}

/** 经中继时，中继就是远程服务本身（个人中转）才沿用它的 CA 指纹。 */
function relayFingerprint(
  relayBaseUrl: string,
  remote: Pick<RemoteRow, "issuer" | "fingerprint">,
): string {
  try {
    return new URL(relayBaseUrl).origin === remote.issuer
      ? remote.fingerprint
      : "";
  } catch {
    return "";
  }
}

/**
 * 几个失败里挑最有用的：拒绝比不可达更有用——页面据此提示重新登录，而不是
 * 「连不上」。都不是就答 `source_unreachable`。
 */
function telling(failures: readonly unknown[], message: string): CoreFailure {
  const useful = failures.find(
    (error): error is CoreFailure =>
      error instanceof CoreFailure &&
      (error.code === "source_unauthorized" ||
        error.code === "source_offline" ||
        error.code === "fingerprint_mismatch"),
  );
  return useful ?? fail("source_unreachable", message);
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

/** 一条路在答案里的样子（契约 §55）：没有凭据，只有地址与时刻。 */
function routeJson(route: RouteRow): ClientSourceRoute {
  return {
    via: route.via,
    origin: route.origin,
    cloudIssuer: route.cloudIssuer,
    fingerprint: route.fingerprint,
    preferred: route.preferred,
    lastOkAtMs: route.lastOkAtMs,
  };
}

/** 一条中继的来源：断言给的 `relayOrigin`，没有就是 `relayBaseUrl` 的来源。 */
function relayOriginOf(assertion: {
  relayOrigin?: string;
  relayBaseUrl: string;
}): string {
  return assertion.relayOrigin || new URL(assertion.relayBaseUrl).origin;
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

  private async sourceJson(
    row: SourceRow,
    routes: readonly RouteRow[] = this.store.routes(row.sourceId),
  ): Promise<ClientSource> {
    return {
      ...row,
      routes: routes.map(routeJson),
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
    const routes = this.store.allRoutes();
    const sources = await Promise.all(
      this.store
        .list()
        .map((row) => this.sourceJson(row, routes.get(row.sourceId) ?? [])),
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

  /**
   * 没给指纹时的第一次外呼：系统不信任对端证书（自签的个人中转、Gateway 的本地
   * CA）就答 `fingerprint_mismatch`，`details.fingerprint` 是对端的信任锚指纹，
   * 页面请人核对后带着它重调（契约 §33.6）。系统信任它、或给了指纹，原样透传。
   */
  private async withAnchor<T>(
    origin: string,
    fingerprint: string,
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const probe = this.options.anchorProbe;
      if (
        probe === undefined ||
        fingerprint !== "" ||
        !origin.startsWith("https:") ||
        !(error instanceof CoreFailure) ||
        error.code !== "source_unreachable"
      ) {
        throw error;
      }
      const anchor = await probe(origin).catch(() => null);
      if (anchor === null) throw error;
      throw fail("fingerprint_mismatch", "对端证书不受系统信任，请核对指纹", {
        fingerprint: anchor,
      });
    }
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
      const code = input.code;
      const exchanged = await this.withAnchor(origin, fingerprint, () =>
        this.peer.exchangeCode({ base: origin, fingerprint }, code),
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
    this.store.upsert({
      sourceId,
      kind: existing?.kind ?? "direct",
      label: label ?? existing?.label ?? clip(new URL(origin).host, 128),
      baseUrl: existing?.baseUrl ?? origin,
      relayOrigin: existing?.relayOrigin ?? "",
      fingerprint: existing?.fingerprint ?? fingerprint,
      cloudIssuer: existing?.cloudIssuer ?? "",
      principalHint: credentials.principalHint,
      addedAtMs: existing?.addedAtMs ?? at,
      lastOkAtMs: at,
      orderIndex: existing?.orderIndex ?? this.store.nextOrder(),
    });
    // 新的直连地址顶替原来首选的直连地址；首选是中继时不抢（选路照样先探直连）。
    const current = this.store.routes(sourceId).find((one) => one.preferred);
    this.store.upsertRoute({
      sourceId,
      via: "direct",
      origin,
      cloudIssuer: "",
      fingerprint,
      addedAtMs: at,
      lastOkAtMs: at,
      ...(current === undefined || current.via === "direct"
        ? { preferred: true }
        : {}),
    });
    this.options.log.info("added a direct source", { sourceId });
    return this.sourceJson(this.row(sourceId));
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
    this.store.upsert({
      ...row,
      label: label ?? row.label,
      orderIndex: input.orderIndex ?? row.orderIndex,
    });
    // 旧的地址字段改的是镜像的那条路（契约 §55）：换掉它的来源，凭据键随之换。
    if (baseUrl !== row.baseUrl) {
      await this.replaceRoute(row, "direct", row.baseUrl, baseUrl, {
        cloudIssuer: "",
        fingerprint: row.fingerprint,
      });
    }
    if (relayOrigin !== row.relayOrigin) {
      await this.replaceRoute(row, "relayed", row.relayOrigin, relayOrigin, {
        cloudIssuer: row.cloudIssuer,
        fingerprint: "",
      });
    }
    return this.sourceJson(this.row(input.sourceId));
  }

  /** `update` 改地址：旧的那条路删掉（连同它的凭据），新的一条接替它是否首选。 */
  private async replaceRoute(
    row: SourceRow,
    via: RouteVia,
    from: string,
    to: string,
    keep: { cloudIssuer: string; fingerprint: string },
  ): Promise<void> {
    const old =
      from === "" ? undefined : this.store.route(row.sourceId, via, from);
    if (to !== "") {
      this.store.upsertRoute({
        sourceId: row.sourceId,
        via,
        origin: to,
        cloudIssuer: old?.cloudIssuer ?? keep.cloudIssuer,
        fingerprint: old?.fingerprint ?? keep.fingerprint,
        addedAtMs: old?.addedAtMs ?? this.now(),
        lastOkAtMs: 0,
        ...(old?.preferred === true ? { preferred: true } : {}),
      });
    }
    if (old !== undefined) {
      this.store.deleteRoute(row.sourceId, via, from);
      await this.secrets.putSource(row.sourceId, from, undefined);
    }
    if (this.store.routes(row.sourceId).length === 0) {
      // 地址全清空了：镜像也清空（没有路可镜像）。
      this.store.upsert({
        ...this.row(row.sourceId),
        baseUrl: "",
        relayOrigin: "",
        cloudIssuer:
          via === "relayed" ? "" : this.row(row.sourceId).cloudIssuer,
      });
    }
  }

  async remove(sourceId: string): Promise<Record<string, never>> {
    const row = this.row(sourceId);
    if (row.kind === "local") throw fail("conflict", "本机这一行不能删");
    await this.secrets.clearSource(sourceId);
    this.store.delete(sourceId);
    this.options.log.info("removed a source", { sourceId });
    return {};
  }

  /** 设为首选的路（契约 §55）。 */
  async routePrefer(input: {
    sourceId: string;
    via: RouteVia;
    origin: string;
  }): Promise<ClientSource> {
    const row = this.row(input.sourceId);
    if (row.kind === "local") throw fail("conflict", "本机没有路可选");
    if (!this.store.preferRoute(input.sourceId, input.via, input.origin)) {
      throw fail("not_found", "这个源没有这条路");
    }
    return this.sourceJson(this.row(input.sourceId));
  }

  /**
   * 删一条路与它的凭据（契约 §55）。最后一条路不在这里删——那等于删源，答
   * `conflict`，由 `sources.remove` 来。
   */
  async routeRemove(input: {
    sourceId: string;
    via: RouteVia;
    origin: string;
  }): Promise<ClientSource> {
    const row = this.row(input.sourceId);
    if (row.kind === "local") throw fail("conflict", "本机没有路可删");
    const routes = this.store.routes(input.sourceId);
    if (
      !routes.some(
        (one) => one.via === input.via && one.origin === input.origin,
      )
    ) {
      throw fail("not_found", "这个源没有这条路");
    }
    if (routes.length === 1) {
      throw fail("conflict", "这是最后一条路，要删就删掉这个源");
    }
    this.store.deleteRoute(input.sourceId, input.via, input.origin);
    await this.secrets.putSource(input.sourceId, input.origin, undefined);
    this.options.log.info("removed a source route", {
      sourceId: input.sourceId,
      via: input.via,
    });
    return this.sourceJson(this.row(input.sourceId));
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

  private ok(row: SourceRow, route: RouteRow): void {
    const at = this.now();
    this.store.touchOk(row.sourceId, at);
    this.store.touchRouteOk(row.sourceId, route.via, route.origin, at);
  }

  private async direct(
    row: SourceRow,
    route: RouteRow,
  ): Promise<SourceSession> {
    const fresh = await this.refreshAt(row.sourceId, route.origin, {
      base: route.origin,
      fingerprint: route.fingerprint,
    });
    this.ok(row, route);
    return {
      accessToken: fresh.accessToken,
      accessExpiresAtMs: fresh.accessExpiresAtMs,
      httpBase: route.origin,
      wsBase: wsBaseOf(route.origin),
      via: "direct",
    };
  }

  /**
   * 经中继：先用这条路存着的刷新令牌，401 时用断言重新 `cloud/login`。凭据键是
   * 这条路的来源——每个中继各一份，换一个中继进来不碰另一个的（契约 §55）。
   */
  private async relayed(
    row: SourceRow,
    route: RouteRow,
    remote: RemoteRow,
    assertion: SourceAssertion,
  ): Promise<SourceSession> {
    if (!assertion.online) throw fail("source_offline", "这台机器当前不在线");
    const address: SourceAddress = {
      base: assertion.relayBaseUrl,
      fingerprint: relayFingerprint(assertion.relayBaseUrl, remote),
      relayToken: assertion.relayToken,
    };
    const key = route.origin;
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
    this.ok(row, route);
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

  /** 中继的路配上它的远程服务；远程服务删掉了的路不可走。 */
  private relayCandidates(
    routes: readonly RouteRow[],
  ): { route: RouteRow; remote: RemoteRow }[] {
    return routes
      .filter((one) => one.via === "relayed" && one.cloudIssuer !== "")
      .flatMap((route) => {
        const remote = this.store.remoteByIssuer(route.cloudIssuer);
        return remote === undefined ? [] : [{ route, remote }];
      });
  }

  /**
   * 中继里选一条（契约 §55）：首选的、其余按最近成功，最多 {@link RELAY_RACE} 条
   * 同时要断言，第一条答「在线」的用。全不行时抛最有用的那个失败。
   */
  private async pickRelay(
    row: SourceRow,
    candidates: readonly { route: RouteRow; remote: RemoteRow }[],
  ): Promise<SourceSession> {
    if (candidates.length === 0) {
      throw fail("source_unreachable", "这个源没有可用的远程服务");
    }
    return (await this.pickRelayLater(row, candidates))();
  }

  /**
   * `sources.session`（规格 §1.5、D27，契约 §55）：
   *
   * - 给了 `route`：只走那一条；
   * - 只给 `via`：那一类里按首选、最近成功选；
   * - 都省略：并行问直连的 hello（1.5 秒）与中继的断言；直连通且 `hostId` 就是
   *   这个源 → 直连换票，否则走中继；都不行 → `source_unreachable`。
   */
  async session(
    sourceId: string,
    via?: "direct" | "relayed",
    target?: { via: RouteVia; origin: string },
  ): Promise<SourceSession> {
    const row = this.row(sourceId);
    if (row.kind === "local") throw fail("conflict", "本机不需要换票");
    const routes = this.store.routes(sourceId);
    const credentials = await this.secrets.source(sourceId);
    const directs = routes.filter((one) => one.via === "direct");
    const relays = this.relayCandidates(routes);

    if (target !== undefined) {
      const route = routes.find(
        (one) => one.via === target.via && one.origin === target.origin,
      );
      if (route === undefined) throw fail("not_found", "这个源没有这条路");
      if (route.via === "direct") return this.direct(row, route);
      const relay = relays.find((one) => one.route === route);
      if (relay === undefined) {
        throw fail("source_unreachable", "这条路的远程服务已不在");
      }
      return this.pickRelay(row, [relay]);
    }
    if (via === "direct") {
      const route =
        directs.find((one) => credentials.byOrigin[one.origin] !== undefined) ??
        directs[0];
      if (route === undefined)
        throw fail("source_unreachable", "这个源没有直连地址");
      return this.direct(row, route);
    }
    if (via === "relayed") return this.pickRelay(row, relays);

    const direct = directs.find(
      (one) => credentials.byOrigin[one.origin] !== undefined,
    );
    if (direct === undefined && relays.length === 0) {
      throw fail(
        routes.length === 0 ? "source_unreachable" : "source_unauthorized",
        "这个源没有保存的登录",
      );
    }

    const relayed =
      relays.length === 0
        ? Promise.reject(fail("source_unreachable", "没有中继"))
        : this.pickRelayLater(row, relays);
    relayed.catch(() => undefined);
    const failures: unknown[] = [];
    if (direct !== undefined) {
      try {
        const hello = await this.peer.hello(
          { base: direct.origin, fingerprint: direct.fingerprint },
          DIRECT_PROBE_MS,
        );
        if (hello.hostId === sourceId) return await this.direct(row, direct);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      return await (
        await relayed
      )();
    } catch (error) {
      failures.push(error);
    }
    throw telling(failures, "直连与中继都连不上这个源");
  }

  /**
   * 中继那一侧先把断言要来（与直连探测并行），换票等直连没成再做——直连成了，
   * 这一份断言就丢掉，不在中继上多换一次票。
   */
  private async pickRelayLater(
    row: SourceRow,
    candidates: readonly { route: RouteRow; remote: RemoteRow }[],
  ): Promise<() => Promise<SourceSession>> {
    const racing = candidates.slice(0, RELAY_RACE);
    const winner = await Promise.any(
      racing.map(async (candidate) => {
        const assertion = await this.assertionFor(
          candidate.remote,
          row.sourceId,
        );
        if (!assertion.online)
          throw fail("source_offline", "这台机器当前不在线");
        return { ...candidate, assertion };
      }),
    ).catch((error: unknown) => {
      const errors = error instanceof AggregateError ? error.errors : [error];
      // 只有一条路：它的失败原样交出去。
      throw errors.length === 1
        ? errors[0]
        : telling(errors, "几条中继都连不上这个源");
    });
    return () =>
      this.relayed(row, winner.route, winner.remote, winner.assertion);
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
    const info = await this.withAnchor(issuer, fingerprint, () =>
      this.remote.info(endpoint),
    );
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

  /**
   * 删中继侧的源记录（契约 §31.4，云登录域撤销登记时经 `attachRelayCleaner` 调）：
   * 用这个 issuer 的远程服务会话调 `sources.revoke`。中继上本来就没有算删掉了；
   * 没有这个远程服务、没有保存的登录或会话不是 owner 答 `source_unauthorized`，
   * 连不上答 `source_unreachable`——由调用方记为待清理。
   */
  async removeRelaySource(issuer: string, sourceId: string): Promise<void> {
    const row = this.store.remoteByIssuer(issuer);
    if (row === undefined) {
      throw fail("source_unauthorized", "没有这个远程服务的登录");
    }
    if (row.kind === "saas") {
      throw fail("not_implemented", "SaaS 远程服务尚未开放");
    }
    const token = await this.remoteAccess(row);
    try {
      await this.remote.revokeSource(
        this.endpoint(row),
        token.accessToken,
        sourceId,
      );
    } catch (error) {
      if (error instanceof CoreFailure && error.code === "not_found") return;
      throw error;
    }
    this.options.log.info("removed this machine from a remote service", {
      serviceId: row.serviceId,
    });
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
    // 撤销要在登出、删凭据之前：删中继侧的源记录用的就是这份 owner 会话。
    const cloud = this.options.cloud?.();
    if (cloud?.registered(row.issuer) === true) {
      await cloud.revoke({ issuer: row.issuer });
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
    // 经它发出的分享链接随登记一起失效（中继侧的源已删），存着的整条链接也删。
    await this.secrets.clearShareLinks(serviceId).catch(() => undefined);
    this.store.deleteRemote(serviceId);
    this.options.log.info("removed a remote service", { serviceId });
    return {};
  }

  /**
   * 登出远程服务（契约 §33.6）：尽力 `auth.logout`，删凭据，**留行**——行上的
   * 指纹与账号留着，重新登录只要再输口令。本机对它的登记不动（隧道用的是源钥，
   * 不是这份会话）。
   */
  async remoteLogout(serviceId: string): Promise<Record<string, never>> {
    const row = this.remoteRow(serviceId);
    const cached = this.access.get(serviceId);
    if (cached !== undefined && cached.accessExpiresAtMs > this.now()) {
      await this.remote
        .logout(this.endpoint(row), cached.accessToken)
        .catch(() => undefined);
    }
    this.access.delete(serviceId);
    this.capabilities.delete(serviceId);
    await this.secrets.clearRemote(serviceId);
    this.options.log.info("signed out of a remote service", { serviceId });
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
    // 「挂上了」= 这台主机经这个服务有一条路（契约 §55）；经别的服务挂上的不算。
    const routes = this.store.allRoutes();
    return {
      sources: listed.map((source) => ({
        ...source,
        mounted: (routes.get(source.sourceId) ?? []).some(
          (route) =>
            route.via === "relayed" && route.cloudIssuer === row.issuer,
        ),
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
    // 凭据键是**这一次**的中继来源（契约 §55）：经第二个中继挂上同一台主机，
    // 不覆盖第一个中继那一份。
    const relayOrigin = relayOriginOf(assertion);
    await this.secrets.putSource(input.sourceId, relayOrigin, {
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
    const row = this.saveRelayRoute({
      sourceId: input.sourceId,
      existing,
      label:
        label ?? existing?.label ?? (name.trim() || input.sourceId.slice(0, 8)),
      relayOrigin,
      issuer: remote.issuer,
      principalHint: credentials.principalHint,
    });
    this.options.log.info("mounted a relayed source", {
      sourceId: input.sourceId,
      serviceId: remote.serviceId,
    });
    return this.sourceJson(row);
  }

  /**
   * 挂载的落库：源行建或留（显示名、主体提示），中继这条路 upsert 一行；镜像由
   * 首选路由决定，挂第二个中继不改原来的首选（契约 §55）。
   */
  private saveRelayRoute(input: {
    sourceId: string;
    existing: SourceRow | undefined;
    label: string;
    relayOrigin: string;
    issuer: string;
    principalHint: string;
  }): SourceRow {
    const at = this.now();
    const { existing } = input;
    this.store.upsert({
      sourceId: input.sourceId,
      kind: existing?.kind ?? "relayed",
      label: clip(input.label, 128),
      baseUrl: existing?.baseUrl ?? "",
      relayOrigin: existing?.relayOrigin || input.relayOrigin,
      fingerprint: existing?.fingerprint ?? "",
      cloudIssuer: existing?.relayOrigin ? existing.cloudIssuer : input.issuer,
      principalHint: input.principalHint,
      addedAtMs: existing?.addedAtMs ?? at,
      lastOkAtMs: at,
      orderIndex: existing?.orderIndex ?? this.store.nextOrder(),
    });
    this.store.upsertRoute({
      sourceId: input.sourceId,
      via: "relayed",
      origin: input.relayOrigin,
      cloudIssuer: input.issuer,
      fingerprint: "",
      addedAtMs: at,
      lastOkAtMs: at,
    });
    return this.row(input.sourceId);
  }

  /**
   * 按分享链接挂载（契约 §33.7，客户端包 §6.2）：
   *
   * 1. 解析链接（网页链接或 `armadra://join`），签发方没登记过、系统又不信任它的
   *    证书时答 `fingerprint_mismatch` + `details.fingerprint`，页面请人核对后重调；
   * 2. `links.accept { secret }`（匿名）→ 访客会话、断言、中继令牌；
   * 3. 经 `relayBaseUrl` `cloud/login { assertion, invitationToken }` → 原生会话；
   * 4. 远程服务没有这一行就建一行（访客，`accountHint` 空），存访客的刷新令牌——
   *    之后换票要它取断言；已有一行且登录着的不动它的凭据，访客会话尽力登出；
   * 5. 存源的刷新令牌，建或合并 `relayed` 行。
   *
   * 链接的秘密与邀请令牌只在这一次调用里，不存、不记日志。
   */
  async mountByLink(input: {
    url: string;
    fingerprint?: string | undefined;
    label?: string | undefined;
  }): Promise<ClientSource> {
    const link = parseJoinLink(input.url);
    if (link === null) throw fail("bad_request", "这不是一条分享链接");
    const label = checkLabel(input.label);
    const issuer = normalizeOrigin(link.issuer);
    const known = this.store.remoteByIssuer(issuer);
    if (known?.kind === "saas") {
      throw fail("not_implemented", "SaaS 远程服务尚未开放");
    }
    const given = normalizeFingerprint(input.fingerprint);
    if (
      known !== undefined &&
      known.fingerprint !== "" &&
      given !== "" &&
      given !== known.fingerprint
    ) {
      throw fail("fingerprint_mismatch", "给定的指纹与已登记的远程服务不一致");
    }
    const fingerprint = known?.fingerprint || given;
    const endpoint: RemoteEndpoint = { issuer, fingerprint };
    const info = await this.withAnchor(issuer, fingerprint, () =>
      this.remote.info(endpoint),
    );
    if (info.mode !== "personal") {
      throw fail("not_implemented", "只支持个人中转的分享链接");
    }
    const accepted = await this.remote.acceptLink(
      endpoint,
      link.linkId,
      link.secret,
    );
    if (accepted.sourceId === this.options.hostId()) {
      await this.remote
        .logout(endpoint, accepted.guest.accessToken)
        .catch(() => undefined);
      throw fail("conflict", "这就是本机");
    }
    const address: SourceAddress = {
      base: accepted.relayBaseUrl,
      fingerprint: relayFingerprint(accepted.relayBaseUrl, endpoint),
      relayToken: accepted.relayToken,
    };
    const credentials = await this.peer.cloudLogin(
      address,
      accepted.assertion,
      link.invitationToken,
    );
    if (credentials.hostId !== "" && credentials.hostId !== accepted.sourceId) {
      throw fail("source_unauthorized", "中继另一端不是这个源");
    }

    const at = this.now();
    const signedIn =
      known !== undefined &&
      (await this.secrets.remote(known.serviceId)) !== undefined;
    let serviceId: string;
    if (known !== undefined && signedIn) {
      // 已经用账号登录着：账号的会话能取这个源的断言，访客那一份用不上。
      serviceId = known.serviceId;
      await this.remote
        .logout(endpoint, accepted.guest.accessToken)
        .catch(() => undefined);
    } else {
      serviceId = known?.serviceId ?? this.newId();
      await this.secrets.putRemote(serviceId, {
        refreshToken: accepted.guest.refreshToken,
        deviceId: accepted.guest.deviceId,
      });
      this.store.upsertRemote({
        serviceId,
        kind: "personal",
        issuer,
        label: known?.label ?? clip(new URL(issuer).host, 128),
        // 空的账号提示 = 访客（分享链接来的）：页面据此不给「分享本机」。
        accountHint: "",
        fingerprint,
        addedAtMs: known?.addedAtMs ?? at,
        lastOkAtMs: at,
      });
      this.remember(serviceId, accepted.guest);
      this.capabilities.set(serviceId, info.capabilities);
    }

    const existing = this.store.get(accepted.sourceId);
    const relayOrigin = relayOriginOf(accepted);
    await this.secrets.putSource(accepted.sourceId, relayOrigin, {
      refreshToken: credentials.refreshToken,
      deviceId: credentials.deviceId,
    });
    let name = "";
    if (label === undefined && existing === undefined) {
      // 显示名取远程服务目录里的那个（访客只看得到这一个源）；拿不到不拦挂载。
      const token = this.access.get(serviceId);
      if (token !== undefined) {
        name = await this.remote
          .sources(endpoint, token.accessToken)
          .then(
            (rows) =>
              rows.find((one) => one.sourceId === accepted.sourceId)?.name ??
              "",
          )
          .catch(() => "");
      }
    }
    const row = this.saveRelayRoute({
      sourceId: accepted.sourceId,
      existing,
      label:
        label ??
        existing?.label ??
        (name.trim() || accepted.sourceId.slice(0, 8)),
      relayOrigin,
      issuer,
      principalHint: credentials.principalHint,
    });
    this.options.log.info("mounted a source by share link", {
      sourceId: accepted.sourceId,
      serviceId,
    });
    return this.sourceJson(row);
  }

  /**
   * 远程服务的地址与一把新鲜的访问令牌，给同一域里另调 `/v1/*` 的模块（分享链接，
   * 契约 §33.9）。令牌只在内存里，不出 core。
   */
  async remoteEndpoint(serviceId: string): Promise<{
    endpoint: RemoteEndpoint;
    accessToken: string;
    issuer: string;
  }> {
    const row = this.remoteRow(serviceId);
    if (row.kind === "saas")
      throw fail("not_implemented", "SaaS 远程服务尚未开放");
    const token = await this.remoteAccess(row);
    return {
      endpoint: this.endpoint(row),
      accessToken: token.accessToken,
      issuer: row.issuer,
    };
  }

  /**
   * 远程服务报的能力（`platform.info`）。记着的那份缺了要找的能力时，`refresh`
   * 再问一次——远程服务可能升过级。
   */
  async remoteCapabilities(
    serviceId: string,
    options: { refresh?: boolean } = {},
  ): Promise<readonly string[]> {
    const row = this.remoteRow(serviceId);
    let capabilities = options.refresh
      ? undefined
      : this.capabilities.get(serviceId);
    if (capabilities === undefined) {
      capabilities = (await this.remote.info(this.endpoint(row))).capabilities;
      this.capabilities.set(serviceId, capabilities);
    }
    return capabilities;
  }

  /** 这一行远程服务在不在（不联网）；不在答 `not_found`。 */
  remoteIssuer(serviceId: string): string {
    return this.remoteRow(serviceId).issuer;
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
