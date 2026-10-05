/**
 * 客户端源表与远程服务的 SQL（迁移 0039，契约 §33）。
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
