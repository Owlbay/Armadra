/**
 * `forge_config` 的读写（迁移 0037）。令牌不在这里，只有它在 SecretStore 里的名字。
 */

import type { DatabaseSync } from "node:sqlite";

import { type ForgeKind, forgeError } from "./types";

export interface ForgeConfigRecord {
  readonly repoKey: string;
  readonly forge: ForgeKind;
  readonly apiBase: string;
  readonly credentialRef: string;
  readonly accountLogin: string;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

interface Row {
  repo_key: string;
  forge: ForgeKind;
  api_base: string;
  credential_ref: string;
  account_login: string;
  revision: number;
  created_at_ms: number;
  updated_at_ms: number;
}

const COLUMNS =
  "repo_key, forge, api_base, credential_ref, account_login, revision, created_at_ms, updated_at_ms";

function record(row: Row): ForgeConfigRecord {
  return {
    repoKey: row.repo_key,
    forge: row.forge,
    apiBase: row.api_base,
    credentialRef: row.credential_ref,
    accountLogin: row.account_login,
    revision: Number(row.revision),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export interface PutConfig {
  readonly repoKey: string;
  readonly forge: ForgeKind;
  readonly apiBase: string;
  readonly credentialRef: string;
  readonly accountLogin: string;
  /** 0 = 新建；其他值必须等于存着的 revision。 */
  readonly expectedRevision: number;
  readonly atMs: number;
}

export class ForgeStore {
  constructor(private readonly database: DatabaseSync) {}

  get(repoKey: string): ForgeConfigRecord | undefined {
    const row = this.database
      .prepare(`SELECT ${COLUMNS} FROM forge_config WHERE repo_key = ?`)
      .get(repoKey) as Row | undefined;
    return row === undefined ? undefined : record(row);
  }

  list(): ForgeConfigRecord[] {
    const rows = this.database
      .prepare(`SELECT ${COLUMNS} FROM forge_config ORDER BY repo_key`)
      .all() as unknown as Row[];
    return rows.map(record);
  }

  /** 按 revision CAS 写一行；对不上抛 `conflict`。 */
  put(input: PutConfig): ForgeConfigRecord {
    const current = this.get(input.repoKey);
    if ((current?.revision ?? 0) !== input.expectedRevision) {
      throw forgeError("conflict", "REVISION_MISMATCH");
    }
    if (current === undefined) {
      this.database
        .prepare(
          `INSERT INTO forge_config (${COLUMNS}) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          input.repoKey,
          input.forge,
          input.apiBase,
          input.credentialRef,
          input.accountLogin,
          input.atMs,
          input.atMs,
        );
    } else {
      const changed = this.database
        .prepare(
          "UPDATE forge_config SET forge = ?, api_base = ?, credential_ref = ?, account_login = ?, revision = revision + 1, updated_at_ms = ? WHERE repo_key = ? AND revision = ?",
        )
        .run(
          input.forge,
          input.apiBase,
          input.credentialRef,
          input.accountLogin,
          Math.max(input.atMs, current.createdAtMs),
          input.repoKey,
          input.expectedRevision,
        );
      if (Number(changed.changes) !== 1) {
        throw forgeError("conflict", "REVISION_MISMATCH");
      }
    }
    return this.get(input.repoKey) as ForgeConfigRecord;
  }

  /** 删一行；revision 对不上抛 `conflict`，没有这一行抛 `notFound`。 */
  delete(repoKey: string, expectedRevision: number): ForgeConfigRecord {
    const current = this.get(repoKey);
    if (current === undefined) throw forgeError("notFound", "NO_CONFIG");
    if (current.revision !== expectedRevision) {
      throw forgeError("conflict", "REVISION_MISMATCH");
    }
    this.database
      .prepare("DELETE FROM forge_config WHERE repo_key = ? AND revision = ?")
      .run(repoKey, expectedRevision);
    return current;
  }
}
