import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AccountsTx } from "../identity/accounts-store";
import { compileGrants } from "../identity/authorize";
import { roleScopes } from "../identity/roles";
import { loadMigrations } from "./migrations";

/**
 * 迁移 0045（契约 §60）：授予加来源、租约与目标，邀请加会话与整台。旧库升上来之后
 * 每一行都落在缺省值上（本地、不过期、工作空间），编译出来的 scope 一个不差；唯一
 * 索引换成按目标，同一工作空间上的工作空间授予与会话授予可以并存。
 */

const migrations = loadMigrations(
  join(dirname(fileURLToPath(import.meta.url)), "migrations"),
);
const OWNER = "a".repeat(32);
const MEMBER = "b".repeat(32);
const GRANT = "c".repeat(32);
const INVITATION = "d".repeat(32);
const AT = 1_700_000_000_000;

let database: DatabaseSync;

function upTo(version: number) {
  for (const migration of migrations.filter((m) => m.version <= version))
    database.exec(migration.sql);
}

function after(version: number) {
  for (const migration of migrations.filter((m) => m.version > version))
    database.exec(migration.sql);
}

function principal(id: string, kind: string) {
  database
    .prepare(
      "INSERT INTO identity_principals(principal_id, kind, display_name, created_at_ms, disabled_at_ms) " +
        "VALUES(?, ?, ?, ?, 0)",
    )
    .run(id, kind, kind, AT);
}

function grant(
  id: string,
  workspaceId: string,
  extra: Record<string, string | number> = {},
) {
  const columns = Object.keys(extra);
  database
    .prepare(
      "INSERT INTO identity_grants(grant_id, subject_kind, subject_id, workspace_id, role, granted_by, " +
        `created_at_ms, revoked_at_ms${columns.map((c) => `, ${c}`).join("")}) ` +
        `VALUES(?, 'principal', ?, ?, 'editor', ?, ?, 0${columns.map(() => ", ?").join("")})`,
    )
    .run(id, MEMBER, workspaceId, OWNER, AT, ...Object.values(extra));
}

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
});

afterEach(() => database.close());

describe("0045 grant_scope", () => {
  it("旧库升级：授予与邀请落在缺省值上，编译结果不变", () => {
    upTo(44);
    principal(OWNER, "owner");
    principal(MEMBER, "member");
    grant(GRANT, "ws-1");
    database
      .prepare(
        "INSERT INTO identity_invitations(invitation_id, issued_by, target_group_id, target_workspace_id, " +
          "role, token_hash, created_at_ms, expires_at_ms) VALUES(?, ?, '', 'ws-1', 'viewer', ?, ?, ?)",
      )
      .run(INVITATION, OWNER, new Uint8Array(32), AT, AT + 1000);
    // 0045 之前的编译：editor 在 ws-1 上的那串 scope。
    const before = [...roleScopes("editor", "ws-1")];

    after(44);
    const accounts = new AccountsTx(database);
    const [row] = accounts.grantsFor(MEMBER, AT);
    expect(row).toMatchObject({
      grantId: GRANT,
      workspaceId: "ws-1",
      origin: "",
      expiresAtMs: 0,
      targetKind: "workspace",
      targetId: "",
    });
    expect(compileGrants(accounts, MEMBER, AT)).toEqual(before);
    expect(accounts.invitation(INVITATION)).toMatchObject({
      targetWorkspaceId: "ws-1",
      targetSessionId: "",
      targetHost: false,
    });
  });

  it("唯一索引按目标：工作空间与会话授予并存，同一目标仍只有一条", () => {
    upTo(45);
    principal(OWNER, "owner");
    principal(MEMBER, "member");
    grant(GRANT, "ws-1");
    grant("e".repeat(32), "ws-1", {
      target_kind: "session",
      target_id: "sess-1",
    });
    expect(() =>
      grant("f".repeat(32), "ws-1", {
        target_kind: "session",
        target_id: "sess-1",
      }),
    ).toThrow(/UNIQUE/);
    expect(() => grant("1".repeat(32), "ws-1")).toThrow(/UNIQUE/);
    expect(() =>
      grant("2".repeat(32), "ws-1", { target_kind: "cluster" }),
    ).toThrow(/CHECK/);
    const names = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'identity_grants' ORDER BY name",
      )
      .all()
      .map((row) => (row as { name: string }).name);
    expect(names).toContain("identity_grants_one_live_per_target");
    expect(names).not.toContain("identity_grants_one_live_per_subject");
  });

  it("租约到期的授予不再编译", () => {
    upTo(45);
    principal(OWNER, "owner");
    principal(MEMBER, "member");
    grant(GRANT, "ws-1", {
      origin: "cloud:0123456789abcdef",
      expires_at_ms: AT + 10,
    });
    const accounts = new AccountsTx(database);
    expect(compileGrants(accounts, MEMBER, AT)).not.toEqual([]);
    expect(compileGrants(accounts, MEMBER, AT + 10)).toEqual([]);
  });
});
