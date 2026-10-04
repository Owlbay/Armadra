import type { DatabaseSync } from "node:sqlite";
import { AccountsTx } from "./accounts-store";
import { IdentityError } from "./errors";
import { ID_PATTERN, newId } from "./tokens";

/**
 * 身份域的持久化，五张表、一个事务。
 *
 * 吸收自 合并前的实现。表名列名都是 Host 的，所以
 * 旧 `host.db` 搬进来的行在这里原样读得出来。
 *
 * 唯一一条不能松的规矩：**每次认证都读库**。没有任何内存缓存能比一次撤销活得
 * 更久——一台设备被撤销之后，它的会话必须在下一个请求上就失效，而不是等某个
 * 缓存过期。所以这里没有缓存层，只有事务。
 */

export interface IdentityOwner {
  readonly principalId: string;
  readonly createdAtMs: number;
}
export interface IdentityDevice {
  readonly deviceId: string;
  readonly principalId: string;
  readonly name: string;
  readonly role: string;
  readonly epoch: number;
  readonly createdAtMs: number;
  readonly revokedAtMs: number;
}
export interface IdentitySession {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly deviceEpoch: number;
  readonly origin: string;
  readonly scopes: Buffer;
  readonly accessHash: Buffer;
  readonly refreshHash: Buffer;
  readonly csrfHash: Buffer;
  readonly rotation: number;
  readonly createdAtMs: number;
  readonly accessExpiresAtMs: number;
  readonly expiresAtMs: number;
  readonly revokedAtMs: number;
  /** 最近一次认证成功的时刻（节流写入，见 `touchSession`）；0 = 没记过。 */
  readonly lastSeenAtMs?: number;
  /** 建会话那一刻的来源地址与 UA，给「我的会话」列表看。 */
  readonly remoteIp?: string;
  readonly userAgent?: string;
}
export interface IdentityTicket {
  readonly ticketId: string;
  readonly ticketHash: Buffer;
  readonly hostId: string;
  readonly instanceId: string;
  readonly origin: string;
  readonly deviceName: string;
  readonly scopes: Buffer;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly consumedAtMs: number;
}

/** `identity_lockouts` 的一行（迁移 `identity_hardening`）。 */
export interface LockoutRow {
  readonly key: string;
  readonly failures: number;
  readonly lockedUntilMs: number;
  readonly updatedAtMs: number;
}

/** `identity_mfa` 的一行。密钥本身在 SecretStore，这里只有条目名。 */
export interface MfaRow {
  readonly principalId: string;
  readonly totpSecretRef: string;
  readonly enrolledAtMs: number;
  /** 0 = 登记了但还没用一个码确认过，登录时不要求它。 */
  readonly verifiedAtMs: number;
  readonly lastTimeStep: number;
}

export interface RecoveryCodeRow {
  readonly principalId: string;
  readonly codeHash: Buffer;
  readonly salt: Buffer;
  readonly createdAtMs: number;
  readonly usedAtMs: number;
}

/** `identity_credentials(kind='passkey')` 的一行。 */
export interface PasskeyRow {
  readonly credentialId: string;
  readonly principalId: string;
  /** WebAuthn 凭据 ID，base64url。 */
  readonly webauthnId: string;
  readonly publicKey: Buffer;
  readonly signCount: number;
  readonly aaguid: string;
  readonly transports: readonly string[];
  readonly label: string;
  readonly createdAtMs: number;
  readonly revokedAtMs: number;
}

/** `identity_password_resets` 的一行（迁移 0036）。令牌明文不在库里。 */
export interface PasswordResetRow {
  readonly tokenHash: Buffer;
  readonly principalId: string;
  readonly issuedBy: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly usedAtMs: number;
}

/** 一台设备在会话表里留下的痕迹：最近那个会话的 UA 与全部会话里最晚的活动。 */
export interface DeviceActivity {
  readonly userAgent: string;
  readonly lastSeenAtMs: number;
}

/** 会话列表的一行：会话加它的设备。 */
export interface SessionListing {
  readonly session: IdentitySession;
  readonly device: IdentityDevice;
}

export class IdentityStore {
  private hostIdValue: string | undefined;

  constructor(private readonly database: DatabaseSync) {}

  /**
   * 这台机器的 Host 标识，没有就生成一个并写进 `store_meta`。
   *
   * 页面把它记下来，用来确认「我配对的还是同一个 Host」。搬运过 `host.db` 的
   * 机器在这里读到的是 Go Host 用了很久的那个值——这正是搬运必须在第一次调用
   * 这个方法之前完成的理由。
   */
  hostId(): string {
    if (this.hostIdValue !== undefined) return this.hostIdValue;
    const row = this.database
      .prepare("SELECT host_id FROM store_meta WHERE singleton = 1")
      .get() as { host_id?: string } | undefined;
    if (row?.host_id !== undefined && ID_PATTERN.test(row.host_id)) {
      this.hostIdValue = row.host_id;
      return row.host_id;
    }
    const generated = newId();
    this.database
      .prepare(
        "INSERT INTO store_meta(singleton, host_id) VALUES(1, ?) " +
          "ON CONFLICT(singleton) DO UPDATE SET host_id = excluded.host_id",
      )
      .run(generated);
    this.hostIdValue = generated;
    return generated;
  }

  /**
   * 一次身份事务。
   *
   * `BEGIN IMMEDIATE` 而不是 `BEGIN`：读到的行会被当作下一步写入的前提（这个
   * 会话还没被撤销、这张票还没被用过），延迟取写锁会让两个并发的兑换都读到
   * 「没用过」。
   */
  transaction<T>(work: (tx: IdentityTx) => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work(new IdentityTx(this.database));
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

export class IdentityTx {
  /** 账号、组、授予与审计那几张表（迁移 0019），同一笔事务。 */
  readonly accounts: AccountsTx;

  constructor(private readonly database: DatabaseSync) {
    this.accounts = new AccountsTx(database);
  }

  /**
   * 这台机器的 owner。
   *
   * 0019 之后它是 `identity_principals` 里那一行 `kind='owner'`——单行表变成了
   * 多行表，而「只有一个 owner」由唯一索引保住，所以这里仍然不存在「挑哪一个」
   * 的问题。会话认证每个请求都要读它，所以它留在这个文件里，而不是和其余账号
   * 表一起放 `accounts-store.ts`。
   */
  owner(): IdentityOwner | undefined {
    const row = this.database
      .prepare(
        "SELECT principal_id, created_at_ms FROM identity_principals WHERE kind = 'owner'",
      )
      .get() as { principal_id: string; created_at_ms: number } | undefined;
    return row === undefined
      ? undefined
      : {
          principalId: row.principal_id,
          createdAtMs: Number(row.created_at_ms),
        };
  }

  createOwner(owner: IdentityOwner): void {
    this.database
      .prepare(
        "INSERT INTO identity_principals(principal_id, kind, display_name, created_at_ms, disabled_at_ms) " +
          "VALUES(?, 'owner', '', ?, 0)",
      )
      .run(owner.principalId, owner.createdAtMs);
  }

  device(deviceId: string): IdentityDevice | undefined {
    const row = this.database
      .prepare(
        "SELECT device_id, principal_id, name, role, epoch, created_at_ms, revoked_at_ms " +
          "FROM identity_devices WHERE device_id = ?",
      )
      .get(deviceId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toDevice(row);
  }

  createDevice(device: IdentityDevice): void {
    this.database
      .prepare(
        "INSERT INTO identity_devices(device_id, principal_id, name, role, epoch, created_at_ms, revoked_at_ms) " +
          "VALUES(?, ?, ?, ?, ?, ?, 0)",
      )
      .run(
        device.deviceId,
        device.principalId,
        device.name,
        device.role,
        device.epoch,
        device.createdAtMs,
      );
  }

  /**
   * 撤销一台设备并推进它的 epoch。
   *
   * epoch 是撤销的执行机制本身：会话行记着签发时的 epoch，设备一推进，所有旧
   * 会话的 `device_epoch` 就对不上了——不需要逐条去找会话删。`WHERE epoch = ?`
   * 是乐观并发：两个并发的撤销只有一个改得动行。
   */
  revokeDevice(deviceId: string, expectedEpoch: number, nowMs: number): void {
    const changes = this.database
      .prepare(
        "UPDATE identity_devices SET epoch = epoch + 1, revoked_at_ms = ? WHERE device_id = ? AND epoch = ?",
      )
      .run(nowMs, deviceId, expectedEpoch).changes;
    if (Number(changes) !== 1) throw new IdentityError("conflict");
  }

  devices(
    afterId: string,
    limit: number,
    principalId?: string,
  ): IdentityDevice[] {
    const rows = (
      principalId === undefined
        ? this.database
            .prepare(
              "SELECT device_id, principal_id, name, role, epoch, created_at_ms, revoked_at_ms " +
                "FROM identity_devices WHERE device_id > ? ORDER BY device_id LIMIT ?",
            )
            .all(afterId, limit)
        : this.database
            .prepare(
              "SELECT device_id, principal_id, name, role, epoch, created_at_ms, revoked_at_ms " +
                "FROM identity_devices WHERE principal_id = ? AND device_id > ? ORDER BY device_id LIMIT ?",
            )
            .all(principalId, afterId, limit)
    ) as Record<string, unknown>[];
    return rows.map(toDevice);
  }

  session(sessionId: string): IdentitySession | undefined {
    const row = this.database
      .prepare(
        "SELECT session_id, device_id, device_epoch, origin, scopes, access_hash, refresh_hash, csrf_hash, " +
          "rotation, created_at_ms, access_expires_at_ms, expires_at_ms, revoked_at_ms, " +
          "last_seen_at_ms, remote_ip, user_agent FROM identity_sessions WHERE session_id = ?",
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toSession(row);
  }

  createSession(session: IdentitySession): void {
    this.database
      .prepare(
        "INSERT INTO identity_sessions(session_id, device_id, device_epoch, origin, scopes, access_hash, " +
          "refresh_hash, csrf_hash, rotation, created_at_ms, access_expires_at_ms, expires_at_ms, revoked_at_ms, " +
          "last_seen_at_ms, remote_ip, user_agent) " +
          "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
      )
      .run(
        session.sessionId,
        session.deviceId,
        session.deviceEpoch,
        session.origin,
        new Uint8Array(session.scopes),
        new Uint8Array(session.accessHash),
        new Uint8Array(session.refreshHash),
        new Uint8Array(session.csrfHash),
        session.rotation,
        session.createdAtMs,
        session.accessExpiresAtMs,
        session.expiresAtMs,
        session.lastSeenAtMs ?? session.createdAtMs,
        (session.remoteIp ?? "").slice(0, 64),
        (session.userAgent ?? "").slice(0, 256),
      );
  }

  /** 三把密钥一起换，rotation 递增。用过的刷新票再也换不出东西。 */
  rotateSession(
    sessionId: string,
    expectedRotation: number,
    accessHash: Buffer,
    refreshHash: Buffer,
    csrfHash: Buffer,
    accessExpiresAtMs: number,
  ): void {
    const changes = this.database
      .prepare(
        "UPDATE identity_sessions SET access_hash = ?, refresh_hash = ?, csrf_hash = ?, " +
          "access_expires_at_ms = ?, rotation = rotation + 1 WHERE session_id = ? AND rotation = ?",
      )
      .run(
        new Uint8Array(accessHash),
        new Uint8Array(refreshHash),
        new Uint8Array(csrfHash),
        accessExpiresAtMs,
        sessionId,
        expectedRotation,
      ).changes;
    if (Number(changes) !== 1) throw new IdentityError("conflict");
  }

  renewSessionCsrf(
    sessionId: string,
    expectedRotation: number,
    csrfHash: Buffer,
  ): void {
    const changes = this.database
      .prepare(
        "UPDATE identity_sessions SET csrf_hash = ?, rotation = rotation + 1 WHERE session_id = ? AND rotation = ?",
      )
      .run(new Uint8Array(csrfHash), sessionId, expectedRotation).changes;
    if (Number(changes) !== 1) throw new IdentityError("conflict");
  }

  revokeSession(sessionId: string, nowMs: number): void {
    this.database
      .prepare(
        "UPDATE identity_sessions SET revoked_at_ms = ? WHERE session_id = ? AND revoked_at_ms = 0",
      )
      .run(nowMs, sessionId);
  }

  /**
   * 记最近活动。调用方负责节流（一分钟以内不重写），所以这里只是一条 UPDATE。
   */
  touchSession(sessionId: string, nowMs: number): void {
    this.database
      .prepare(
        "UPDATE identity_sessions SET last_seen_at_ms = ? WHERE session_id = ? AND revoked_at_ms = 0",
      )
      .run(nowMs, sessionId);
  }

  /**
   * 还活着的会话（没撤销、没过绝对期限、设备没撤销且 epoch 对得上），带设备。
   * 给了 `principalId` 只列那个人的。
   */
  liveSessions(nowMs: number, principalId?: string): SessionListing[] {
    const sql =
      "SELECT s.session_id, s.device_id, s.device_epoch, s.origin, s.scopes, s.access_hash, s.refresh_hash, " +
      "s.csrf_hash, s.rotation, s.created_at_ms, s.access_expires_at_ms, s.expires_at_ms, s.revoked_at_ms, " +
      "s.last_seen_at_ms, s.remote_ip, s.user_agent, d.principal_id, d.name, d.role, d.epoch, " +
      "d.created_at_ms AS device_created_at_ms, d.revoked_at_ms AS device_revoked_at_ms " +
      "FROM identity_sessions s JOIN identity_devices d ON d.device_id = s.device_id " +
      "WHERE s.revoked_at_ms = 0 AND s.expires_at_ms > ? AND d.revoked_at_ms = 0 AND d.epoch = s.device_epoch" +
      (principalId === undefined ? "" : " AND d.principal_id = ?") +
      " ORDER BY s.created_at_ms DESC, s.session_id LIMIT 1000";
    const statement = this.database.prepare(sql);
    const rows = (
      principalId === undefined
        ? statement.all(nowMs)
        : statement.all(nowMs, principalId)
    ) as Record<string, unknown>[];
    return rows.map((row) => ({
      session: toSession(row),
      device: toDevice({
        device_id: row.device_id,
        principal_id: row.principal_id,
        name: row.name,
        role: row.role,
        epoch: row.epoch,
        created_at_ms: row.device_created_at_ms,
        revoked_at_ms: row.device_revoked_at_ms,
      }),
    }));
  }

  /**
   * 这几台设备的会话痕迹（设备表的「平台」「最近访问」两列）。撤销与过期的会话
   * 也算：最近访问说的是这台设备最后一次被用，不是它现在还能不能用。
   */
  deviceActivity(deviceIds: readonly string[]): Map<string, DeviceActivity> {
    const found = new Map<string, DeviceActivity>();
    if (deviceIds.length === 0) return found;
    const rows = this.database
      .prepare(
        "SELECT device_id, user_agent, last_seen_at_ms, created_at_ms FROM identity_sessions " +
          `WHERE device_id IN (${deviceIds.map(() => "?").join(", ")}) ` +
          "ORDER BY created_at_ms DESC, session_id DESC",
      )
      .all(...deviceIds) as Record<string, unknown>[];
    for (const row of rows) {
      const deviceId = String(row.device_id);
      const lastSeen = Number(row.last_seen_at_ms ?? 0);
      const previous = found.get(deviceId);
      // 行按建会话的时间从新到旧：第一行就是最近那个会话，UA 取它的。
      found.set(deviceId, {
        userAgent: previous?.userAgent ?? String(row.user_agent ?? ""),
        lastSeenAtMs: Math.max(previous?.lastSeenAtMs ?? 0, lastSeen),
      });
    }
    return found;
  }

  /* ---------------------------- 口令重置 ---------------------------- */

  createPasswordReset(row: PasswordResetRow): void {
    this.database
      .prepare(
        "INSERT INTO identity_password_resets(token_hash, principal_id, issued_by, created_at_ms, " +
          "expires_at_ms, used_at_ms) VALUES(?, ?, ?, ?, ?, 0)",
      )
      .run(
        new Uint8Array(row.tokenHash),
        row.principalId,
        row.issuedBy,
        row.createdAtMs,
        row.expiresAtMs,
      );
  }

  passwordReset(tokenHash: Buffer): PasswordResetRow | undefined {
    const row = this.database
      .prepare(
        "SELECT token_hash, principal_id, issued_by, created_at_ms, expires_at_ms, used_at_ms " +
          "FROM identity_password_resets WHERE token_hash = ?",
      )
      .get(new Uint8Array(tokenHash)) as Record<string, unknown> | undefined;
    return row === undefined
      ? undefined
      : {
          tokenHash: blob(row.token_hash),
          principalId: String(row.principal_id),
          issuedBy: String(row.issued_by),
          createdAtMs: Number(row.created_at_ms),
          expiresAtMs: Number(row.expires_at_ms),
          usedAtMs: Number(row.used_at_ms),
        };
  }

  /**
   * 用掉一枚令牌。一次性就在条件里：用过的、过期的改不动行，答 false，两个并发
   * 的兑换只有一个改得动。
   */
  usePasswordReset(tokenHash: Buffer, nowMs: number): boolean {
    const changes = this.database
      .prepare(
        "UPDATE identity_password_resets SET used_at_ms = ? " +
          "WHERE token_hash = ? AND used_at_ms = 0 AND expires_at_ms > ?",
      )
      .run(nowMs, new Uint8Array(tokenHash), nowMs).changes;
    return Number(changes) === 1;
  }

  /** 作废这个人手里还没用的令牌（签新的之前、口令被别的路径换掉之后）。 */
  supersedePasswordResets(principalId: string, nowMs: number): number {
    const changes = this.database
      .prepare(
        "UPDATE identity_password_resets SET used_at_ms = ? WHERE principal_id = ? AND used_at_ms = 0",
      )
      .run(nowMs, principalId).changes;
    return Number(changes);
  }

  /* ------------------------------ 锁定 ------------------------------ */

  lockout(key: string): LockoutRow | undefined {
    const row = this.database
      .prepare(
        "SELECT key, failures, locked_until_ms, updated_at_ms FROM identity_lockouts WHERE key = ?",
      )
      .get(key) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toLockout(row);
  }

  putLockout(row: LockoutRow): void {
    this.database
      .prepare(
        "INSERT INTO identity_lockouts(key, failures, locked_until_ms, updated_at_ms) VALUES(?, ?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, " +
          "locked_until_ms = excluded.locked_until_ms, updated_at_ms = excluded.updated_at_ms",
      )
      .run(row.key, row.failures, row.lockedUntilMs, row.updatedAtMs);
  }

  deleteLockout(key: string): void {
    this.database
      .prepare("DELETE FROM identity_lockouts WHERE key = ?")
      .run(key);
  }

  activeLockouts(nowMs: number): LockoutRow[] {
    return (
      this.database
        .prepare(
          "SELECT key, failures, locked_until_ms, updated_at_ms FROM identity_lockouts " +
            "WHERE locked_until_ms > ? ORDER BY locked_until_ms DESC LIMIT 500",
        )
        .all(nowMs) as Record<string, unknown>[]
    ).map(toLockout);
  }

  /** 早于 `beforeMs` 且没锁着的行没有用了。 */
  pruneLockouts(beforeMs: number): void {
    this.database
      .prepare(
        "DELETE FROM identity_lockouts WHERE updated_at_ms < ? AND locked_until_ms < ?",
      )
      .run(beforeMs, beforeMs);
  }

  /* ------------------------------- MFA -------------------------------- */

  mfa(principalId: string): MfaRow | undefined {
    const row = this.database
      .prepare(
        "SELECT principal_id, totp_secret_ref, enrolled_at_ms, verified_at_ms, last_time_step " +
          "FROM identity_mfa WHERE principal_id = ?",
      )
      .get(principalId) as Record<string, unknown> | undefined;
    return row === undefined
      ? undefined
      : {
          principalId: String(row.principal_id),
          totpSecretRef: String(row.totp_secret_ref),
          enrolledAtMs: Number(row.enrolled_at_ms),
          verifiedAtMs: Number(row.verified_at_ms),
          lastTimeStep: Number(row.last_time_step),
        };
  }

  /** 登记（或在未确认时重登记）一份 TOTP；确认状态与时间步一起清零。 */
  putMfa(row: MfaRow): void {
    this.database
      .prepare(
        "INSERT INTO identity_mfa(principal_id, totp_secret_ref, enrolled_at_ms, verified_at_ms, last_time_step) " +
          "VALUES(?, ?, ?, ?, ?) ON CONFLICT(principal_id) DO UPDATE SET " +
          "totp_secret_ref = excluded.totp_secret_ref, enrolled_at_ms = excluded.enrolled_at_ms, " +
          "verified_at_ms = excluded.verified_at_ms, last_time_step = excluded.last_time_step",
      )
      .run(
        row.principalId,
        row.totpSecretRef,
        row.enrolledAtMs,
        row.verifiedAtMs,
        row.lastTimeStep,
      );
  }

  /**
   * 用掉一个时间步。`last_time_step < ?` 是条件的一部分：两个并发的校验拿着同一
   * 个码，只有一个改得动行——重放防护在这里，不在内存里。
   */
  advanceTimeStep(
    principalId: string,
    timeStep: number,
    verifiedAtMs?: number,
  ): boolean {
    const changes = this.database
      .prepare(
        "UPDATE identity_mfa SET last_time_step = ?, " +
          "verified_at_ms = CASE WHEN verified_at_ms = 0 THEN ? ELSE verified_at_ms END " +
          "WHERE principal_id = ? AND last_time_step < ?",
      )
      .run(timeStep, verifiedAtMs ?? 0, principalId, timeStep).changes;
    return Number(changes) === 1;
  }

  deleteMfa(principalId: string): void {
    this.database
      .prepare("DELETE FROM identity_mfa WHERE principal_id = ?")
      .run(principalId);
    this.database
      .prepare("DELETE FROM identity_recovery_codes WHERE principal_id = ?")
      .run(principalId);
  }

  recoveryCodes(principalId: string): RecoveryCodeRow[] {
    return (
      this.database
        .prepare(
          "SELECT principal_id, code_hash, salt, created_at_ms, used_at_ms FROM identity_recovery_codes " +
            "WHERE principal_id = ? ORDER BY created_at_ms, code_hash",
        )
        .all(principalId) as Record<string, unknown>[]
    ).map((row) => ({
      principalId: String(row.principal_id),
      codeHash: blob(row.code_hash),
      salt: blob(row.salt),
      createdAtMs: Number(row.created_at_ms),
      usedAtMs: Number(row.used_at_ms),
    }));
  }

  /** 换一整批：旧的（含用过的）全删，新的写进去。 */
  replaceRecoveryCodes(
    principalId: string,
    rows: readonly RecoveryCodeRow[],
  ): void {
    this.database
      .prepare("DELETE FROM identity_recovery_codes WHERE principal_id = ?")
      .run(principalId);
    const insert = this.database.prepare(
      "INSERT INTO identity_recovery_codes(principal_id, code_hash, salt, created_at_ms, used_at_ms) VALUES(?, ?, ?, ?, 0)",
    );
    for (const row of rows) {
      insert.run(
        principalId,
        new Uint8Array(row.codeHash),
        new Uint8Array(row.salt),
        row.createdAtMs,
      );
    }
  }

  /** 用掉一个恢复码；已经用过（并发的第二次）改不动行，答 false。 */
  useRecoveryCode(
    principalId: string,
    codeHash: Buffer,
    nowMs: number,
  ): boolean {
    const changes = this.database
      .prepare(
        "UPDATE identity_recovery_codes SET used_at_ms = ? WHERE principal_id = ? AND code_hash = ? AND used_at_ms = 0",
      )
      .run(nowMs, principalId, new Uint8Array(codeHash)).changes;
    return Number(changes) === 1;
  }

  /* ----------------------------- passkey ------------------------------ */

  passkeysOf(principalId: string): PasskeyRow[] {
    return (
      this.database
        .prepare(
          `SELECT ${PASSKEY_COLUMNS} WHERE kind = 'passkey' AND principal_id = ? AND revoked_at_ms = 0 ` +
            "ORDER BY created_at_ms, credential_id",
        )
        .all(principalId) as Record<string, unknown>[]
    ).map(toPasskey);
  }

  /** 按 WebAuthn 凭据 ID 找一把没撤销的 passkey。 */
  passkeyByWebauthnId(webauthnId: string): PasskeyRow | undefined {
    const row = this.database
      .prepare(
        `SELECT ${PASSKEY_COLUMNS} WHERE kind = 'passkey' AND subject = ? AND revoked_at_ms = 0`,
      )
      .get(webauthnId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toPasskey(row);
  }

  passkey(credentialId: string): PasskeyRow | undefined {
    const row = this.database
      .prepare(
        `SELECT ${PASSKEY_COLUMNS} WHERE kind = 'passkey' AND credential_id = ?`,
      )
      .get(credentialId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toPasskey(row);
  }

  createPasskey(row: PasskeyRow): void {
    this.database
      .prepare(
        "INSERT INTO identity_credentials(credential_id, principal_id, kind, provider, subject, public_key, " +
          "sign_count, aaguid, transports_json, label, created_at_ms, revoked_at_ms) " +
          "VALUES(?, ?, 'passkey', 'webauthn', ?, ?, ?, ?, ?, ?, ?, 0)",
      )
      .run(
        row.credentialId,
        row.principalId,
        row.webauthnId,
        new Uint8Array(row.publicKey),
        row.signCount,
        row.aaguid,
        JSON.stringify(row.transports),
        row.label,
        row.createdAtMs,
      );
  }

  /** 改名。撤销了的改不动，答 false。 */
  renamePasskey(credentialId: string, label: string): boolean {
    const changes = this.database
      .prepare(
        "UPDATE identity_credentials SET label = ? WHERE credential_id = ? AND kind = 'passkey' AND revoked_at_ms = 0",
      )
      .run(label, credentialId).changes;
    return Number(changes) === 1;
  }

  /** 按库的判定写回计数器（`@simplewebauthn/server` 的 `newCounter`）。 */
  updatePasskeyCounter(credentialId: string, signCount: number): void {
    this.database
      .prepare(
        "UPDATE identity_credentials SET sign_count = ? WHERE credential_id = ? AND kind = 'passkey' AND revoked_at_ms = 0",
      )
      .run(signCount, credentialId);
  }

  ticket(ticketId: string): IdentityTicket | undefined {
    const row = this.database
      .prepare(
        "SELECT ticket_id, ticket_hash, host_id, instance_id, origin, device_name, scopes, " +
          "created_at_ms, expires_at_ms, consumed_at_ms FROM identity_bootstrap_tickets WHERE ticket_id = ?",
      )
      .get(ticketId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toTicket(row);
  }

  createTicket(ticket: IdentityTicket): void {
    this.database
      .prepare(
        "INSERT INTO identity_bootstrap_tickets(ticket_id, ticket_hash, host_id, instance_id, origin, " +
          "device_name, scopes, created_at_ms, expires_at_ms, consumed_at_ms) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
      )
      .run(
        ticket.ticketId,
        new Uint8Array(ticket.ticketHash),
        ticket.hostId,
        ticket.instanceId,
        ticket.origin,
        ticket.deviceName,
        new Uint8Array(ticket.scopes),
        ticket.createdAtMs,
        ticket.expiresAtMs,
      );
  }

  /**
   * 把一张票标记为用过。一次性就在这里：`consumed_at_ms = 0` 是条件的一部分，
   * 第二次兑换改不动任何行，于是整笔事务回滚，第二张票换不出会话。
   */
  consumeTicket(ticketId: string, nowMs: number): void {
    const changes = this.database
      .prepare(
        "UPDATE identity_bootstrap_tickets SET consumed_at_ms = ? WHERE ticket_id = ? AND consumed_at_ms = 0",
      )
      .run(nowMs, ticketId).changes;
    if (Number(changes) !== 1) throw new IdentityError("unauthenticated");
  }

  /** 过期且没用过的票不必留着。删不掉也不影响正确性——一次性靠的是列，不是清理。 */
  pruneTickets(nowMs: number): void {
    this.database
      .prepare(
        "DELETE FROM identity_bootstrap_tickets WHERE expires_at_ms <= ?",
      )
      .run(nowMs);
  }
}

function toDevice(row: Record<string, unknown>): IdentityDevice {
  return {
    deviceId: String(row.device_id),
    principalId: String(row.principal_id),
    name: String(row.name),
    role: String(row.role),
    epoch: Number(row.epoch),
    createdAtMs: Number(row.created_at_ms),
    revokedAtMs: Number(row.revoked_at_ms),
  };
}

function toSession(row: Record<string, unknown>): IdentitySession {
  return {
    sessionId: String(row.session_id),
    deviceId: String(row.device_id),
    deviceEpoch: Number(row.device_epoch),
    origin: String(row.origin),
    scopes: blob(row.scopes),
    accessHash: blob(row.access_hash),
    refreshHash: blob(row.refresh_hash),
    csrfHash: blob(row.csrf_hash),
    rotation: Number(row.rotation),
    createdAtMs: Number(row.created_at_ms),
    accessExpiresAtMs: Number(row.access_expires_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
    revokedAtMs: Number(row.revoked_at_ms),
    lastSeenAtMs: Number(row.last_seen_at_ms ?? 0),
    remoteIp: String(row.remote_ip ?? ""),
    userAgent: String(row.user_agent ?? ""),
  };
}

function toLockout(row: Record<string, unknown>): LockoutRow {
  return {
    key: String(row.key),
    failures: Number(row.failures),
    lockedUntilMs: Number(row.locked_until_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

const PASSKEY_COLUMNS =
  "credential_id, principal_id, subject, public_key, sign_count, aaguid, transports_json, label, " +
  "created_at_ms, revoked_at_ms FROM identity_credentials";

function toPasskey(row: Record<string, unknown>): PasskeyRow {
  let transports: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row.transports_json));
    if (Array.isArray(parsed)) {
      transports = parsed.filter(
        (item): item is string => typeof item === "string",
      );
    }
  } catch {
    // 手改坏的那一列当作没有传输方式；判定不看它。
  }
  return {
    credentialId: String(row.credential_id),
    principalId: String(row.principal_id),
    webauthnId: String(row.subject),
    publicKey: blob(row.public_key),
    signCount: Number(row.sign_count),
    aaguid: String(row.aaguid),
    transports,
    label: String(row.label),
    createdAtMs: Number(row.created_at_ms),
    revokedAtMs: Number(row.revoked_at_ms),
  };
}

function toTicket(row: Record<string, unknown>): IdentityTicket {
  return {
    ticketId: String(row.ticket_id),
    ticketHash: blob(row.ticket_hash),
    hostId: String(row.host_id),
    instanceId: String(row.instance_id),
    origin: String(row.origin),
    deviceName: String(row.device_name),
    scopes: blob(row.scopes),
    createdAtMs: Number(row.created_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
    consumedAtMs: Number(row.consumed_at_ms),
  };
}

function blob(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.alloc(0);
}
