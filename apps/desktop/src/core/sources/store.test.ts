import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openFreshDatabase } from "../db/fresh.fixture";
import type { OpenedDatabase } from "../db/open";
import { tempDir } from "../testing/temp-dir";
import { migrationsDir } from "../workspaces/fixture";
import { type SourceRow, SourcesStore } from "./store";

/** 迁移 0039 的两张表与 `store.ts` 的 CRUD。 */

let opened: OpenedDatabase;
let store: SourcesStore;

beforeEach(() => {
  opened = openFreshDatabase(
    join(tempDir("armadra-sources-store-"), "canvas.db"),
    migrationsDir(),
  );
  store = new SourcesStore(opened.database);
});

afterEach(() => opened.close());

function row(sourceId: string, overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    sourceId,
    kind: "direct",
    label: sourceId.slice(0, 4),
    defaultLabel: sourceId.slice(0, 4),
    baseUrl: "https://gw.test",
    relayOrigin: "",
    fingerprint: "",
    cloudIssuer: "",
    principalHint: "",
    addedAtMs: 1_000,
    lastOkAtMs: 0,
    orderIndex: 1,
    ...overrides,
  };
}

describe("迁移 0039", () => {
  it("两张表都在，约束守住长度与种类", () => {
    const names = opened.database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('client_sources', 'remote_services') ORDER BY name",
      )
      .all()
      .map((one) => (one as { name: string }).name);
    expect(names).toEqual(["client_sources", "remote_services"]);
    expect(() => store.upsert(row("short"))).toThrow();
    expect(() =>
      store.upsert(row("a".repeat(32), { kind: "bogus" as never })),
    ).toThrow();
    expect(() =>
      store.upsert(row("a".repeat(32), { fingerprint: "abc" })),
    ).toThrow();
    expect(() => store.upsert(row("a".repeat(32), { label: "" }))).toThrow();
    expect(() =>
      store.upsertRemote({
        serviceId: "b".repeat(32),
        kind: "relay" as never,
        issuer: "https://x",
        label: "x",
        defaultLabel: "x",
        accountHint: "",
        fingerprint: "",
        addedAtMs: 1,
        lastOkAtMs: 0,
      }),
    ).toThrow();
  });
});

describe("源表", () => {
  it("插入、改写（加入时刻不变）、读回、删除", () => {
    store.upsert(row("a".repeat(32)));
    const changed = store.upsert(
      row("a".repeat(32), { label: "renamed", addedAtMs: 9_999 }),
    );
    expect(changed.label).toBe("renamed");
    expect(changed.addedAtMs).toBe(1_000);
    expect(store.delete("a".repeat(32))).toBe(true);
    expect(store.get("a".repeat(32))).toBeUndefined();
    expect(store.delete("a".repeat(32))).toBe(false);
  });

  it("local 行删不掉", () => {
    store.upsert(
      row("c".repeat(32), { kind: "local", baseUrl: "", orderIndex: 0 }),
    );
    expect(store.delete("c".repeat(32))).toBe(false);
    expect(store.get("c".repeat(32))?.kind).toBe("local");
  });

  it("顺序：local 第一，其余按 order_index、再按加入先后；nextOrder 接在最大号后面", () => {
    store.upsert(row("1".repeat(32), { orderIndex: 2, addedAtMs: 5 }));
    store.upsert(row("2".repeat(32), { orderIndex: 1, addedAtMs: 9 }));
    store.upsert(row("3".repeat(32), { orderIndex: 1, addedAtMs: 3 }));
    store.upsert(row("4".repeat(32), { kind: "local", orderIndex: 7 }));
    expect(store.list().map((one) => one.sourceId[0])).toEqual([
      "4",
      "3",
      "2",
      "1",
    ]);
    expect(store.nextOrder()).toBe(8);
    store.touchOk("1".repeat(32), 42);
    expect(store.get("1".repeat(32))?.lastOkAtMs).toBe(42);
  });
});

describe("远程服务", () => {
  it("issuer 唯一；按 issuer 找得到；删除", () => {
    const base = {
      kind: "personal" as const,
      issuer: "https://relay.test",
      label: "relay",
      defaultLabel: "relay",
      accountHint: "owner",
      fingerprint: "a".repeat(64),
      addedAtMs: 1,
      lastOkAtMs: 0,
    };
    store.upsertRemote({ serviceId: "5".repeat(32), ...base });
    expect(() =>
      store.upsertRemote({ serviceId: "6".repeat(32), ...base }),
    ).toThrow();
    expect(store.remoteByIssuer("https://relay.test")?.serviceId).toBe(
      "5".repeat(32),
    );
    store.touchRemoteOk("5".repeat(32), 77);
    expect(store.remote("5".repeat(32))?.lastOkAtMs).toBe(77);
    expect(store.remotes()).toHaveLength(1);
    expect(store.deleteRemote("5".repeat(32))).toBe(true);
    expect(store.remotes()).toEqual([]);
  });
});
