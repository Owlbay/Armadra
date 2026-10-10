/**
 * 云登录与登记的 SQL（迁移 0040、0041，契约 §31）。
 *
 * 一行 = 这台 core 信任一个远程服务（issuer）签的断言、并向它开隧道。撤销只记
 * `revoked_at_ms`，同一个 issuer 再登记时整行覆盖。这里没有凭据：源私钥在
 * SecretStore，断言原文不落盘。
 */

import type { DatabaseSync } from "node:sqlite";

export type CloudMode = "personal" | "saas";

export interface RegistrationRow {
  readonly issuer: string;
  readonly sourceKeyRef: string;
  readonly jwksJson: string;
  readonly jwksUrl: string;
  readonly jwksFetchedAtMs: number;
  readonly trustedOrigins: readonly string[];
  readonly relayOrigins: readonly string[];
  readonly ownerAccountId: string;
  readonly label: string;
  readonly mode: CloudMode;
  readonly registeredBy: string;
  readonly registeredAtMs: number;
  readonly revokedAtMs: number;
}

interface RegistrationRecord {
  issuer: string;
  source_key_ref: string;
  jwks_json: string;
  jwks_url: string;
  jwks_fetched_at_ms: number;
  trusted_origins_json: string;
  relay_origins_json: string;
  owner_account_id: string;
  label: string;
  mode: CloudMode;
  registered_by: string;
  registered_at_ms: number;
  revoked_at_ms: number;
}

function strings(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value)
      ? value.filter((one): one is string => typeof one === "string")
      : [];
  } catch {
    return [];
  }
}

function rowOf(record: RegistrationRecord): RegistrationRow {
  return {
    issuer: record.issuer,
    sourceKeyRef: record.source_key_ref,
    jwksJson: record.jwks_json,
    jwksUrl: record.jwks_url,
    jwksFetchedAtMs: Number(record.jwks_fetched_at_ms),
    trustedOrigins: strings(record.trusted_origins_json),
    relayOrigins: strings(record.relay_origins_json),
    ownerAccountId: record.owner_account_id,
    label: record.label,
    mode: record.mode,
    registeredBy: record.registered_by,
    registeredAtMs: Number(record.registered_at_ms),
    revokedAtMs: Number(record.revoked_at_ms),
  };
}

const COLUMNS =
  "issuer, source_key_ref, jwks_json, jwks_url, jwks_fetched_at_ms, trusted_origins_json, relay_origins_json, owner_account_id, label, mode, registered_by, registered_at_ms, revoked_at_ms";

export class CloudStore {
  constructor(private readonly database: DatabaseSync) {}

  /** 这个 issuer 的行（含已撤销的）。 */
  get(issuer: string): RegistrationRow | undefined {
    const record = this.database
      .prepare(`SELECT ${COLUMNS} FROM cloud_registrations WHERE issuer = ?`)
      .get(issuer) as RegistrationRecord | undefined;
    return record === undefined ? undefined : rowOf(record);
  }

  /** 这个 issuer 还有效的登记；撤销过的当没有。 */
  live(issuer: string): RegistrationRow | undefined {
    const row = this.get(issuer);
    return row !== undefined && row.revokedAtMs === 0 ? row : undefined;
  }

  /** 全部有效的登记，按登记先后。 */
  list(): RegistrationRow[] {
    return (
      this.database
        .prepare(
          `SELECT ${COLUMNS} FROM cloud_registrations WHERE revoked_at_ms = 0 ORDER BY registered_at_ms, issuer`,
        )
        .all() as unknown as RegistrationRecord[]
    ).map(rowOf);
  }

  /** 写一行；同一个 issuer 已有（撤销过的）就整行覆盖。 */
  put(row: RegistrationRow): void {
    this.database
      .prepare(
        `INSERT INTO cloud_registrations (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(issuer) DO UPDATE SET
           source_key_ref = excluded.source_key_ref,
           jwks_json = excluded.jwks_json,
           jwks_url = excluded.jwks_url,
           jwks_fetched_at_ms = excluded.jwks_fetched_at_ms,
           trusted_origins_json = excluded.trusted_origins_json,
           relay_origins_json = excluded.relay_origins_json,
           owner_account_id = excluded.owner_account_id,
           label = excluded.label,
           mode = excluded.mode,
           registered_by = excluded.registered_by,
           registered_at_ms = excluded.registered_at_ms,
           revoked_at_ms = excluded.revoked_at_ms,
           relay_cleanup = ''`,
      )
      .run(
        row.issuer,
        row.sourceKeyRef,
        row.jwksJson,
        row.jwksUrl,
        row.jwksFetchedAtMs,
        JSON.stringify(row.trustedOrigins),
        JSON.stringify(row.relayOrigins),
        row.ownerAccountId,
        row.label,
        row.mode,
        row.registeredBy,
        row.registeredAtMs,
        row.revokedAtMs,
      );
  }

  /** JWKS 刷新之后写回缓存。 */
  updateJwks(issuer: string, jwksJson: string, fetchedAtMs: number): void {
    this.database
      .prepare(
        "UPDATE cloud_registrations SET jwks_json = ?, jwks_fetched_at_ms = ? WHERE issuer = ?",
      )
      .run(jwksJson, fetchedAtMs, issuer);
  }

  setTrustedOrigins(issuer: string, origins: readonly string[]): void {
    this.database
      .prepare(
        "UPDATE cloud_registrations SET trusted_origins_json = ? WHERE issuer = ?",
      )
      .run(JSON.stringify(origins), issuer);
  }

  /** 撤销：只记时刻；答这次是否真的改了一行（没有有效登记时 `false`）。 */
  revoke(issuer: string, atMs: number): boolean {
    const result = this.database
      .prepare(
        "UPDATE cloud_registrations SET revoked_at_ms = ? WHERE issuer = ? AND revoked_at_ms = 0",
      )
      .run(atMs, issuer);
    return Number(result.changes) > 0;
  }

  /**
   * 撤销时中继侧没删掉的那一份（迁移 0041）：记下当时的错误码；`""` 清掉。
   * 只对已撤销的行有意义，再登记（{@link put}）时清空。
   */
  setRelayCleanup(issuer: string, code: string): void {
    this.database
      .prepare(
        "UPDATE cloud_registrations SET relay_cleanup = ? WHERE issuer = ? AND revoked_at_ms > 0",
      )
      .run(code.slice(0, 64), issuer);
  }

  /** 已撤销、中继侧还欠着清理的登记，按撤销先后。 */
  relayPending(): { issuer: string; revokedAtMs: number; code: string }[] {
    return (
      this.database
        .prepare(
          "SELECT issuer, revoked_at_ms, relay_cleanup FROM cloud_registrations WHERE revoked_at_ms > 0 AND relay_cleanup <> '' ORDER BY revoked_at_ms, issuer",
        )
        .all() as unknown as {
        issuer: string;
        revoked_at_ms: number;
        relay_cleanup: string;
      }[]
    ).map((record) => ({
      issuer: record.issuer,
      revokedAtMs: Number(record.revoked_at_ms),
      code: record.relay_cleanup,
    }));
  }

  /**
   * 远程服务表（迁移 0039）里这个 issuer 的 CA 指纹：个人中转多是自签证书，
   * 登记与取 JWKS 都按用户加入它时给的指纹钉扎。没有那一行就是系统信任。
   */
  remoteFingerprint(issuer: string): string {
    const record = this.database
      .prepare("SELECT fingerprint FROM remote_services WHERE issuer = ?")
      .get(issuer) as { fingerprint: string } | undefined;
    return record?.fingerprint ?? "";
  }

  /**
   * 只带指纹的「远程服务」行：用注册令牌登记自签证书的个人中转时（没有账号口令
   * 可走 `sources.remoteAdd`），先把信任锚钉在这里，登记与隧道都按它验证。
   * 已有同一 issuer 的行时不覆盖：指纹相同答 `same`、不同答 `conflict`。
   */
  pinRemote(input: {
    issuer: string;
    fingerprint: string;
    label: string;
    serviceId: string;
    atMs: number;
  }): "created" | "same" | "conflict" {
    const existing = this.database
      .prepare("SELECT fingerprint FROM remote_services WHERE issuer = ?")
      .get(input.issuer) as { fingerprint: string } | undefined;
    if (existing !== undefined) {
      return existing.fingerprint === input.fingerprint ? "same" : "conflict";
    }
    this.database
      .prepare(
        "INSERT INTO remote_services(service_id, kind, issuer, label, default_label, account_hint, fingerprint, added_at_ms, last_ok_at_ms) " +
          "VALUES(?, 'personal', ?, ?, ?, '', ?, ?, 0)",
      )
      .run(
        input.serviceId,
        input.issuer,
        input.label,
        input.label,
        input.fingerprint,
        input.atMs,
      );
    return "created";
  }

  /** 撤掉 {@link pinRemote} 新建的那一行（登记没成功就不留）。 */
  unpinRemote(issuer: string): void {
    this.database
      .prepare("DELETE FROM remote_services WHERE issuer = ?")
      .run(issuer);
  }

  /** 全部工作空间的标识（组织默认角色按它们逐条授予）。 */
  workspaceIds(): string[] {
    return (
      this.database
        .prepare("SELECT id FROM workspaces ORDER BY id")
        .all() as unknown as { id: string }[]
    ).map((record) => record.id);
  }
}
