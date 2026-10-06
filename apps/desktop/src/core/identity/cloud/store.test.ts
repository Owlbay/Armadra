import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openFreshDatabase } from "../../db/fresh.fixture";
import type { OpenedDatabase } from "../../db/open";
import { tempDir } from "../../testing/temp-dir";
import { migrationsDir } from "../../workspaces/fixture";
import { IdentityStore } from "../store";
import { CloudStore, type RegistrationRow } from "./store";

/** 迁移 0040 的表与 `store.ts` 的读写。 */

let opened: OpenedDatabase;
let store: CloudStore;
const OWNER = "a".repeat(32);

beforeEach(() => {
  opened = openFreshDatabase(
    join(tempDir("armadra-cloud-store-"), "canvas.db"),
    migrationsDir(),
  );
  new IdentityStore(opened.database).transaction((tx) =>
    tx.createOwner({ principalId: OWNER, createdAtMs: 1 }),
  );
  store = new CloudStore(opened.database);
});

afterEach(() => opened.close());

function row(overrides: Partial<RegistrationRow> = {}): RegistrationRow {
  return {
    issuer: "https://relay.test",
    sourceKeyRef: "armadra-cloud-source-key",
    jwksJson: '{"keys":[]}',
    jwksUrl: "https://relay.test/.well-known/jwks.json",
    jwksFetchedAtMs: 1_000,
    trustedOrigins: ["https://relay.test"],
    relayOrigins: ["https://relay.test"],
    ownerAccountId: "acct:dev",
    label: "laptop",
    mode: "personal",
    registeredBy: OWNER,
    registeredAtMs: 1_000,
    revokedAtMs: 0,
    ...overrides,
  };
}

describe("迁移 0040", () => {
  it("新表与邀请的两列都在，约束守住种类与外键", () => {
    const tables = opened.database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('cloud_registrations', 'identity_invitation_uses') ORDER BY name",
      )
      .all()
      .map((one) => (one as { name: string }).name);
    expect(tables).toEqual(["cloud_registrations", "identity_invitation_uses"]);
    const columns = opened.database
      .prepare("PRAGMA table_info(identity_invitations)")
      .all()
      .map((one) => (one as { name: string }).name);
    expect(columns).toEqual(expect.arrayContaining(["max_uses", "uses"]));
    expect(() => store.put(row({ mode: "bogus" as never }))).toThrow();
    expect(() => store.put(row({ issuer: "" }))).toThrow();
    expect(() => store.put(row({ registeredBy: "b".repeat(32) }))).toThrow();
  });
});

describe("CloudStore", () => {
  it("写、读、列；JSON 列往返", () => {
    store.put(row());
    expect(store.live("https://relay.test")).toEqual(row());
    expect(store.list().map((one) => one.issuer)).toEqual([
      "https://relay.test",
    ]);
  });

  it("撤销只记时刻，再登记整行覆盖", () => {
    store.put(row());
    expect(store.revoke("https://relay.test", 2_000)).toBe(true);
    expect(store.revoke("https://relay.test", 3_000)).toBe(false);
    expect(store.live("https://relay.test")).toBeUndefined();
    expect(store.get("https://relay.test")?.revokedAtMs).toBe(2_000);
    expect(store.list()).toEqual([]);
    store.put(row({ registeredAtMs: 4_000, label: "again" }));
    expect(store.live("https://relay.test")?.label).toBe("again");
  });

  it("JWKS 缓存与可信来源单独更新", () => {
    store.put(row());
    store.updateJwks("https://relay.test", '{"keys":[1]}', 5_000);
    store.setTrustedOrigins("https://relay.test", ["https://a.test"]);
    const got = store.live("https://relay.test");
    expect(got?.jwksJson).toBe('{"keys":[1]}');
    expect(got?.jwksFetchedAtMs).toBe(5_000);
    expect(got?.trustedOrigins).toEqual(["https://a.test"]);
  });

  it("远程服务的指纹：有行取行，没有是空串", () => {
    expect(store.remoteFingerprint("https://relay.test")).toBe("");
    opened.database
      .prepare(
        "INSERT INTO remote_services (service_id, kind, issuer, label, fingerprint, added_at_ms) VALUES (?, 'personal', ?, 'r', ?, 1)",
      )
      .run("c".repeat(32), "https://relay.test", "d".repeat(64));
    expect(store.remoteFingerprint("https://relay.test")).toBe("d".repeat(64));
  });
});

describe("迁移 0041：中继侧待清理", () => {
  it("只记在已撤销的行上，列出欠着的，再登记清空", () => {
    store.put(row());
    store.setRelayCleanup("https://relay.test", "source_unauthorized");
    // 还有效的登记不记。
    expect(store.relayPending()).toEqual([]);
    expect(store.revoke("https://relay.test", 2_000)).toBe(true);
    store.setRelayCleanup("https://relay.test", "source_unauthorized");
    expect(store.relayPending()).toEqual([
      {
        issuer: "https://relay.test",
        revokedAtMs: 2_000,
        code: "source_unauthorized",
      },
    ]);
    store.setRelayCleanup("https://relay.test", "");
    expect(store.relayPending()).toEqual([]);
    store.setRelayCleanup("https://relay.test", "source_unreachable");
    store.put(row({ registeredAtMs: 3_000 }));
    expect(store.relayPending()).toEqual([]);
  });

  it("列有长度约束", () => {
    store.put(row({ revokedAtMs: 2_000 }));
    expect(() =>
      opened.database
        .prepare("UPDATE cloud_registrations SET relay_cleanup = ?")
        .run("x".repeat(65)),
    ).toThrow();
  });
});
