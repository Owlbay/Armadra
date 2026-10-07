import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/open";
import { tempDir } from "../testing/temp-dir";
import { auditCsv } from "./accounts-http";
import type { AuditFilter } from "./accounts-store";
import { IdentityStore } from "./store";

/**
 * 审计查询（契约 §18.6）：动作族、时间窗、游标，以及 CSV 的转义与注入防护。
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");

const P1 = "1".repeat(32);
const P2 = "2".repeat(32);

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

function seeded() {
  const opened = openDatabase({
    file: join(tempDir("armadra-audit-query-"), "canvas.db"),
    migrationsDir,
  });
  closing.push(opened.close);
  const store = new IdentityStore(opened.database);
  const rows: [number, string, string][] = [
    [1_000, "identity.login", P1],
    [2_000, "identity.login.failed", P2],
    [3_000, "identity.loginx", P1],
    [4_000, "identity_mfa.enroll", P1],
    [5_000, "identity.mfa.enroll", P2],
    [6_000, "share.grant.set", P1],
  ];
  store.transaction((tx) => {
    for (const [atMs, action, principalId] of rows) {
      tx.accounts.appendAudit({
        atMs,
        principalId,
        deviceId: "",
        action,
        target: "",
        workspaceId: "",
        detailJson: "",
      });
    }
  });
  const query = (filter: AuditFilter) =>
    store.transaction((tx) =>
      tx.accounts.auditEntries(filter).map((row) => row.action),
    );
  return { query };
}

describe("审计筛选", () => {
  it("动作族命中自己与点号后代，不命中前缀相同的别的动作，`_` 不当通配", () => {
    const { query } = seeded();
    expect(query({ actions: ["identity.login"] })).toEqual([
      "identity.login.failed",
      "identity.login",
    ]);
    expect(query({ actions: ["identity.mfa"] })).toEqual([
      "identity.mfa.enroll",
    ]);
    expect(query({ actions: ["identity.login", "share"] })).toEqual([
      "share.grant.set",
      "identity.login.failed",
      "identity.login",
    ]);
  });

  it("时间窗含起不含止，主体与游标叠加，从新到旧", () => {
    const { query } = seeded();
    expect(query({ sinceMs: 2_000, untilMs: 5_000 })).toEqual([
      "identity_mfa.enroll",
      "identity.loginx",
      "identity.login.failed",
    ]);
    expect(query({ principalId: P1, beforeId: 4 })).toEqual([
      "identity.loginx",
      "identity.login",
    ]);
    expect(query({ limit: 2 })).toEqual([
      "share.grant.set",
      "identity.mfa.enroll",
    ]);
  });
});

describe("审计 CSV", () => {
  it("表头、ISO 时间、引号转义，公式开头的单元格补一个撇号", () => {
    const csv = auditCsv([
      {
        id: 7,
        atMs: Date.UTC(2026, 9, 3, 8, 0, 0),
        principalId: "p1",
        deviceId: "d1",
        action: "share.grant.set",
        target: '=HYPERLINK("x")',
        workspaceId: "w1",
        detail: { role: "viewer", note: "a,b" },
      },
      {
        id: 6,
        atMs: 0,
        principalId: "",
        deviceId: "",
        action: "identity.login.failed",
        target: "-1+2",
        workspaceId: "",
        detail: null,
      },
    ]);
    expect(csv.split("\r\n")).toEqual([
      "id,time,principalId,deviceId,action,target,workspaceId,detail",
      `7,2026-10-03T08:00:00.000Z,p1,d1,share.grant.set,"'=HYPERLINK(""x"")",w1,"{""role"":""viewer"",""note"":""a,b""}"`,
      "6,1970-01-01T00:00:00.000Z,,,identity.login.failed,'-1+2,,",
      "",
    ]);
  });
});
