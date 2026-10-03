import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { SecretBackend } from "../../secrets/backend";
import { secretName } from "./inject";

/**
 * 节点凭据条目：`agent_credentials` 一行（迁移 0031）加 SecretStore 里同名的一个
 * 值。表只记名字与种类；值只在 {@link SecretBackend} 里，读出来只活一次调用那么久。
 *
 * 写的顺序是「先值后行」、删的顺序是「先值后行」：任何一步失败，留下的要么是一个
 * 没有行的孤儿值（下次同名写入覆盖它，`ref` 是随机的所以不会被别人撞上），要么是
 * 一个 `isSet: false` 的行——都不会是一个看起来设好了、其实取不到的条目。
 */

export interface CredentialRow {
  readonly ref: string;
  readonly providerId: string;
  readonly kind: string;
  readonly label: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
}

/** `ref` 只用这个字符集：它同时是 SecretStore 条目名的一部分。 */
export const REF_PATTERN = /^[a-z0-9]{8,64}$/;

export class CredentialStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly secrets: SecretBackend,
    private readonly now: () => number = Date.now,
  ) {}

  /** 后端自报的种类（`file` 时本机拒绝存凭据）。 */
  backendKind(): SecretBackend["kind"] {
    return this.secrets.kind;
  }

  list(): CredentialRow[] {
    return (
      this.database
        .prepare(
          "SELECT ref, provider_id, kind, label, created_at, last_used_at " +
            "FROM agent_credentials ORDER BY created_at, ref",
        )
        .all() as unknown as RawRow[]
    ).map(fromRaw);
  }

  get(ref: string): CredentialRow | undefined {
    if (!REF_PATTERN.test(ref)) return undefined;
    const row = this.database
      .prepare(
        "SELECT ref, provider_id, kind, label, created_at, last_used_at " +
          "FROM agent_credentials WHERE ref = ?",
      )
      .get(ref) as unknown as RawRow | undefined;
    return row === undefined ? undefined : fromRaw(row);
  }

  async create(input: {
    providerId: string;
    kind: string;
    label: string;
    value: string;
  }): Promise<CredentialRow> {
    const ref = randomBytes(8).toString("hex");
    await this.secrets.set(secretName(ref), input.value);
    const createdAt = this.now();
    this.database
      .prepare(
        "INSERT INTO agent_credentials (ref, provider_id, kind, label, created_at) " +
          "VALUES (?, ?, ?, ?, ?)",
      )
      .run(ref, input.providerId, input.kind, input.label, createdAt);
    return {
      ref,
      providerId: input.providerId,
      kind: input.kind,
      label: input.label,
      createdAt,
      lastUsedAt: null,
    };
  }

  async update(
    ref: string,
    patch: { label?: string; value?: string },
  ): Promise<CredentialRow | undefined> {
    const row = this.get(ref);
    if (row === undefined) return undefined;
    if (patch.value !== undefined) {
      await this.secrets.set(secretName(ref), patch.value);
    }
    if (patch.label !== undefined) {
      this.database
        .prepare("UPDATE agent_credentials SET label = ? WHERE ref = ?")
        .run(patch.label, ref);
    }
    return this.get(ref);
  }

  /** `false`：没有这一行。 */
  async remove(ref: string): Promise<boolean> {
    if (this.get(ref) === undefined) return false;
    await this.secrets.delete(secretName(ref));
    this.database
      .prepare("DELETE FROM agent_credentials WHERE ref = ?")
      .run(ref);
    return true;
  }

  /** 值在不在。打不开（后端断开）也算不在：设置页提示重设，而不是报错。 */
  async isSet(ref: string): Promise<boolean> {
    try {
      return (await this.secrets.get(secretName(ref))) !== undefined;
    } catch {
      return false;
    }
  }

  /** 取值；只给兑换用。打不开时抛 `SecretUnavailable`。 */
  async value(ref: string): Promise<string | undefined> {
    return this.secrets.get(secretName(ref));
  }

  touch(ref: string): void {
    this.database
      .prepare("UPDATE agent_credentials SET last_used_at = ? WHERE ref = ?")
      .run(this.now(), ref);
  }
}

interface RawRow {
  ref: string;
  provider_id: string;
  kind: string;
  label: string;
  created_at: number;
  last_used_at: number | null;
}

function fromRaw(row: RawRow): CredentialRow {
  return {
    ref: row.ref,
    providerId: row.provider_id,
    kind: row.kind,
    label: row.label,
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
  };
}
