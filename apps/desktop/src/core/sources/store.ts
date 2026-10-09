/**
 * 客户端源表与远程服务的 SQL（迁移 0039、0044，契约 §33、§55）。
 *
 * 一个源可以有几条到达方式（`client_source_routes`，一条路一行）；`client_sources`
 * 上的地址列是首选路由的镜像（{@link SourcesStore.mirror}），旧读者照旧读它们。
 *
 * 这里只有行：凭据在 SecretStore（`secrets.ts`），这张表里没有一个令牌。
 */

import type { DatabaseSync } from "node:sqlite";

export type ClientSourceKind = "local" | "direct" | "relayed" | "hosted";
export type RemoteServiceKind = "personal" | "saas";

export interface SourceRow {
  readonly sourceId: string;
  readonly kind: ClientSourceKind;
  readonly label: string;
  readonly baseUrl: string;
  readonly relayOrigin: string;
  readonly fingerprint: string;
  readonly cloudIssuer: string;
  readonly principalHint: string;
  readonly addedAtMs: number;
  readonly lastOkAtMs: number;
  readonly orderIndex: number;
}

export interface RemoteRow {
  readonly serviceId: string;
  readonly kind: RemoteServiceKind;
  readonly issuer: string;
  readonly label: string;
  readonly accountHint: string;
  readonly fingerprint: string;
  readonly addedAtMs: number;
  readonly lastOkAtMs: number;
}

export type RouteVia = "direct" | "relayed";

/** 一条到达方式（契约 §55）。`origin` 也是这条路在 SecretStore 里的凭据键。 */
export interface RouteRow {
  readonly sourceId: string;
  readonly via: RouteVia;
  /** direct：Gateway 来源；relayed：中继来源。 */
  readonly origin: string;
  /** relayed：经哪个远程服务；direct 是空串。 */
  readonly cloudIssuer: string;
  /** direct 的信任锚指纹；relayed 是空串（沿用远程服务的）。 */
  readonly fingerprint: string;
  readonly preferred: boolean;
  readonly addedAtMs: number;
  readonly lastOkAtMs: number;
}

interface RouteRecord {
  source_id: string;
  via: RouteVia;
  origin: string;
  cloud_issuer: string;
  fingerprint: string;
  preferred: number;
  added_at_ms: number;
  last_ok_at_ms: number;
}

function routeOf(record: RouteRecord): RouteRow {
  return {
    sourceId: record.source_id,
    via: record.via,
    origin: record.origin,
    cloudIssuer: record.cloud_issuer,
    fingerprint: record.fingerprint,
    preferred: Number(record.preferred) === 1,
    addedAtMs: Number(record.added_at_ms),
    lastOkAtMs: Number(record.last_ok_at_ms),
  };
}

const ROUTE_COLUMNS =
  "source_id, via, origin, cloud_issuer, fingerprint, preferred, added_at_ms, last_ok_at_ms";
/** 首选在前，直连在中继前，再按最近成功、加入先后。 */
const ROUTE_ORDER =
  "ORDER BY preferred DESC, via = 'direct' DESC, last_ok_at_ms DESC, added_at_ms, origin";

interface SourceRecord {
  source_id: string;
  kind: ClientSourceKind;
  label: string;
  base_url: string;
  relay_origin: string;
  fingerprint: string;
  cloud_issuer: string;
  principal_hint: string;
  added_at_ms: number;
  last_ok_at_ms: number;
  order_index: number;
}

interface RemoteRecord {
  service_id: string;
  kind: RemoteServiceKind;
  issuer: string;
  label: string;
  account_hint: string;
  fingerprint: string;
  added_at_ms: number;
  last_ok_at_ms: number;
}

function sourceOf(record: SourceRecord): SourceRow {
  return {
    sourceId: record.source_id,
    kind: record.kind,
    label: record.label,
    baseUrl: record.base_url,
    relayOrigin: record.relay_origin,
    fingerprint: record.fingerprint,
    cloudIssuer: record.cloud_issuer,
    principalHint: record.principal_hint,
    addedAtMs: Number(record.added_at_ms),
    lastOkAtMs: Number(record.last_ok_at_ms),
    orderIndex: Number(record.order_index),
  };
}

function remoteOf(record: RemoteRecord): RemoteRow {
  return {
    serviceId: record.service_id,
    kind: record.kind,
    issuer: record.issuer,
    label: record.label,
    accountHint: record.account_hint,
    fingerprint: record.fingerprint,
    addedAtMs: Number(record.added_at_ms),
    lastOkAtMs: Number(record.last_ok_at_ms),
  };
}

const SOURCE_COLUMNS =
  "source_id, kind, label, base_url, relay_origin, fingerprint, cloud_issuer, " +
  "principal_hint, added_at_ms, last_ok_at_ms, order_index";
const REMOTE_COLUMNS =
  "service_id, kind, issuer, label, account_hint, fingerprint, added_at_ms, last_ok_at_ms";

export class SourcesStore {
  constructor(private readonly database: DatabaseSync) {}

  /** 按 `order_index`，同序按加入先后。`local` 永远排第一。 */
  list(): SourceRow[] {
    const rows = this.database
      .prepare(
        `SELECT ${SOURCE_COLUMNS} FROM client_sources ` +
          "ORDER BY kind = 'local' DESC, order_index, added_at_ms, source_id",
      )
      .all() as unknown as SourceRecord[];
    return rows.map(sourceOf);
  }

  get(sourceId: string): SourceRow | undefined {
    const row = this.database
      .prepare(
        `SELECT ${SOURCE_COLUMNS} FROM client_sources WHERE source_id = ?`,
      )
      .get(sourceId) as SourceRecord | undefined;
    return row === undefined ? undefined : sourceOf(row);
  }

  /** 插入或整行改写（`added_at_ms` 保留第一次的）。 */
  upsert(row: SourceRow): SourceRow {
    this.database
      .prepare(
        `INSERT INTO client_sources(${SOURCE_COLUMNS}) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ` +
          "ON CONFLICT(source_id) DO UPDATE SET kind = excluded.kind, label = excluded.label, " +
          "base_url = excluded.base_url, relay_origin = excluded.relay_origin, " +
          "fingerprint = excluded.fingerprint, cloud_issuer = excluded.cloud_issuer, " +
          "principal_hint = excluded.principal_hint, last_ok_at_ms = excluded.last_ok_at_ms, " +
          "order_index = excluded.order_index",
      )
      .run(
        row.sourceId,
        row.kind,
        row.label,
        row.baseUrl,
        row.relayOrigin,
        row.fingerprint,
        row.cloudIssuer,
        row.principalHint,
        row.addedAtMs,
        row.lastOkAtMs,
        row.orderIndex,
      );
    return this.get(row.sourceId) as SourceRow;
  }

  /** 下一个排序号：现有最大 + 1（`local` 是 0）。 */
  nextOrder(): number {
    const row = this.database
      .prepare("SELECT MAX(order_index) AS top FROM client_sources")
      .get() as { top: number | null };
    return row.top === null ? 0 : Number(row.top) + 1;
  }

  delete(sourceId: string): boolean {
    this.database
      .prepare(
        "DELETE FROM client_source_routes WHERE source_id = ? AND " +
          "source_id IN (SELECT source_id FROM client_sources WHERE kind <> 'local')",
      )
      .run(sourceId);
    const result = this.database
      .prepare(
        "DELETE FROM client_sources WHERE source_id = ? AND kind <> 'local'",
      )
      .run(sourceId);
    return Number(result.changes) > 0;
  }

  touchOk(sourceId: string, atMs: number): void {
    this.database
      .prepare(
        "UPDATE client_sources SET last_ok_at_ms = ? WHERE source_id = ?",
      )
      .run(atMs, sourceId);
  }

  /* ------------------------------ 到达方式 ------------------------------ */

  /** 这个源的路（{@link ROUTE_ORDER}）。 */
  routes(sourceId: string): RouteRow[] {
    const rows = this.database
      .prepare(
        `SELECT ${ROUTE_COLUMNS} FROM client_source_routes WHERE source_id = ? ${ROUTE_ORDER}`,
      )
      .all(sourceId) as unknown as RouteRecord[];
    return rows.map(routeOf);
  }

  /** 全部源的路，按源分组（列表一次读完）。 */
  allRoutes(): Map<string, RouteRow[]> {
    const rows = this.database
      .prepare(
        `SELECT ${ROUTE_COLUMNS} FROM client_source_routes ${ROUTE_ORDER}`,
      )
      .all() as unknown as RouteRecord[];
    const grouped = new Map<string, RouteRow[]>();
    for (const record of rows) {
      const row = routeOf(record);
      const list = grouped.get(row.sourceId);
      if (list === undefined) grouped.set(row.sourceId, [row]);
      else list.push(row);
    }
    return grouped;
  }

  route(sourceId: string, via: RouteVia, origin: string): RouteRow | undefined {
    const row = this.database
      .prepare(
        `SELECT ${ROUTE_COLUMNS} FROM client_source_routes WHERE source_id = ? AND via = ? AND origin = ?`,
      )
      .get(sourceId, via, origin) as RouteRecord | undefined;
    return row === undefined ? undefined : routeOf(row);
  }

  /**
   * 插入或改写一条路（`added_at_ms` 保留第一次的）。`preferred` 为真时其余的路
   * 不再首选；这个源原来没有首选的路时这一条成为首选。之后重算镜像。
   */
  upsertRoute(
    route: Omit<RouteRow, "preferred"> & { preferred?: boolean },
  ): RouteRow {
    const hasPreferred =
      this.database
        .prepare(
          "SELECT 1 FROM client_source_routes WHERE source_id = ? AND preferred = 1 " +
            "AND NOT (via = ? AND origin = ?)",
        )
        .get(route.sourceId, route.via, route.origin) !== undefined;
    const current = this.route(route.sourceId, route.via, route.origin);
    const preferred =
      route.preferred === true ||
      (route.preferred === undefined && current?.preferred === true) ||
      !hasPreferred;
    if (preferred) {
      this.database
        .prepare(
          "UPDATE client_source_routes SET preferred = 0 WHERE source_id = ?",
        )
        .run(route.sourceId);
    }
    this.database
      .prepare(
        `INSERT INTO client_source_routes(${ROUTE_COLUMNS}) VALUES(?, ?, ?, ?, ?, ?, ?, ?) ` +
          "ON CONFLICT(source_id, via, origin) DO UPDATE SET cloud_issuer = excluded.cloud_issuer, " +
          "fingerprint = excluded.fingerprint, preferred = excluded.preferred, " +
          "last_ok_at_ms = excluded.last_ok_at_ms",
      )
      .run(
        route.sourceId,
        route.via,
        route.origin,
        route.cloudIssuer,
        route.fingerprint,
        preferred ? 1 : 0,
        route.addedAtMs,
        route.lastOkAtMs,
      );
    this.mirror(route.sourceId);
    return this.route(route.sourceId, route.via, route.origin) as RouteRow;
  }

  /** 设为首选；没有这条路答 `false`。 */
  preferRoute(sourceId: string, via: RouteVia, origin: string): boolean {
    if (this.route(sourceId, via, origin) === undefined) return false;
    this.database
      .prepare(
        "UPDATE client_source_routes SET preferred = CASE WHEN via = ? AND origin = ? THEN 1 ELSE 0 END " +
          "WHERE source_id = ?",
      )
      .run(via, origin, sourceId);
    this.mirror(sourceId);
    return true;
  }

  /** 删一条路；删掉的是首选时剩下的第一条接替。之后重算镜像。 */
  deleteRoute(sourceId: string, via: RouteVia, origin: string): boolean {
    const result = this.database
      .prepare(
        "DELETE FROM client_source_routes WHERE source_id = ? AND via = ? AND origin = ?",
      )
      .run(sourceId, via, origin);
    if (Number(result.changes) === 0) return false;
    const rest = this.routes(sourceId);
    if (rest.length > 0 && !rest.some((one) => one.preferred)) {
      const next = rest[0] as RouteRow;
      this.preferRoute(sourceId, next.via, next.origin);
    } else {
      this.mirror(sourceId);
    }
    return true;
  }

  touchRouteOk(
    sourceId: string,
    via: RouteVia,
    origin: string,
    atMs: number,
  ): void {
    this.database
      .prepare(
        "UPDATE client_source_routes SET last_ok_at_ms = ? WHERE source_id = ? AND via = ? AND origin = ?",
      )
      .run(atMs, sourceId, via, origin);
  }

  /**
   * 把首选路由镜像回 `client_sources` 的地址列（契约 §55：§33 的形状不变）：
   *
   * - 首选是直连 → `base_url` / `fingerprint` 取它；首选是中继 → `relay_origin` /
   *   `cloud_issuer` 取它，`kind` 随首选；
   * - 另一种的列：现镜像的那条路还在就留着（挂第二个中继不改镜像），否则取
   *   直连里最近成功的、中继里最早加入的。
   *
   * 没有路的行（本机、还没回填的）不动。
   */
  mirror(sourceId: string): void {
    const row = this.get(sourceId);
    if (row === undefined || row.kind === "local" || row.kind === "hosted")
      return;
    const routes = this.routes(sourceId);
    if (routes.length === 0) return;
    const preferred =
      routes.find((one) => one.preferred) ?? (routes[0] as RouteRow);
    const directs = routes.filter((one) => one.via === "direct");
    const relays = routes
      .filter((one) => one.via === "relayed")
      .sort(
        (a, b) => a.addedAtMs - b.addedAtMs || a.origin.localeCompare(b.origin),
      );
    const direct =
      preferred.via === "direct"
        ? preferred
        : (directs.find((one) => one.origin === row.baseUrl) ?? directs[0]);
    const relay =
      preferred.via === "relayed"
        ? preferred
        : (relays.find(
            (one) =>
              one.origin === row.relayOrigin &&
              one.cloudIssuer === row.cloudIssuer,
          ) ?? relays[0]);
    this.database
      .prepare(
        "UPDATE client_sources SET kind = ?, base_url = ?, fingerprint = ?, relay_origin = ?, " +
          "cloud_issuer = ? WHERE source_id = ?",
      )
      .run(
        preferred.via,
        direct?.origin ?? "",
        direct?.fingerprint ?? "",
        relay?.origin ?? "",
        relay?.cloudIssuer ?? "",
        sourceId,
      );
  }

  remotes(): RemoteRow[] {
    const rows = this.database
      .prepare(
        `SELECT ${REMOTE_COLUMNS} FROM remote_services ORDER BY added_at_ms, service_id`,
      )
      .all() as unknown as RemoteRecord[];
    return rows.map(remoteOf);
  }

  remote(serviceId: string): RemoteRow | undefined {
    const row = this.database
      .prepare(
        `SELECT ${REMOTE_COLUMNS} FROM remote_services WHERE service_id = ?`,
      )
      .get(serviceId) as RemoteRecord | undefined;
    return row === undefined ? undefined : remoteOf(row);
  }

  remoteByIssuer(issuer: string): RemoteRow | undefined {
    const row = this.database
      .prepare(`SELECT ${REMOTE_COLUMNS} FROM remote_services WHERE issuer = ?`)
      .get(issuer) as RemoteRecord | undefined;
    return row === undefined ? undefined : remoteOf(row);
  }

  upsertRemote(row: RemoteRow): RemoteRow {
    this.database
      .prepare(
        `INSERT INTO remote_services(${REMOTE_COLUMNS}) VALUES(?, ?, ?, ?, ?, ?, ?, ?) ` +
          "ON CONFLICT(service_id) DO UPDATE SET kind = excluded.kind, issuer = excluded.issuer, " +
          "label = excluded.label, account_hint = excluded.account_hint, " +
          "fingerprint = excluded.fingerprint, last_ok_at_ms = excluded.last_ok_at_ms",
      )
      .run(
        row.serviceId,
        row.kind,
        row.issuer,
        row.label,
        row.accountHint,
        row.fingerprint,
        row.addedAtMs,
        row.lastOkAtMs,
      );
    return this.remote(row.serviceId) as RemoteRow;
  }

  deleteRemote(serviceId: string): boolean {
    const result = this.database
      .prepare("DELETE FROM remote_services WHERE service_id = ?")
      .run(serviceId);
    return Number(result.changes) > 0;
  }

  touchRemoteOk(serviceId: string, atMs: number): void {
    this.database
      .prepare(
        "UPDATE remote_services SET last_ok_at_ms = ? WHERE service_id = ?",
      )
      .run(atMs, serviceId);
  }
}
