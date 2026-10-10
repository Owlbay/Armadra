import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SourcesStore } from "../sources/store";
import { loadMigrations } from "./migrations";

/**
 * 迁移 0046（契约 §61）：源表与远程服务加 `default_label`。旧行无从分辨改没改过名，
 * 按「没改过」回填成 label；之后新的缺省名进来时跟着走，改名为空恢复成它。
 */

const migrations = loadMigrations(
  join(dirname(fileURLToPath(import.meta.url)), "migrations"),
);

let database: DatabaseSync;

function upTo(version: number) {
  for (const migration of migrations.filter((m) => m.version <= version))
    database.exec(migration.sql);
}

function after(version: number) {
  for (const migration of migrations.filter((m) => m.version > version))
    database.exec(migration.sql);
}

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
});

afterEach(() => database.close());

describe("0046 source_default_labels", () => {
  it("旧行回填 default_label = label，新列守住长度", () => {
    upTo(45);
    database
      .prepare(
        "INSERT INTO client_sources(source_id, kind, label, base_url, added_at_ms) VALUES(?, 'direct', ?, ?, 1)",
      )
      .run("a".repeat(32), "我的笔记本", "https://gw.test");
    database
      .prepare(
        "INSERT INTO remote_services(service_id, kind, issuer, label, added_at_ms) VALUES(?, 'personal', ?, ?, 1)",
      )
      .run("b".repeat(32), "https://relay.test", "relay.test");
    after(45);

    const store = new SourcesStore(database);
    expect(store.get("a".repeat(32))).toMatchObject({
      label: "我的笔记本",
      defaultLabel: "我的笔记本",
    });
    expect(store.remote("b".repeat(32))).toMatchObject({
      label: "relay.test",
      defaultLabel: "relay.test",
    });
    expect(() =>
      database
        .prepare("UPDATE client_sources SET default_label = ?")
        .run("x".repeat(129)),
    ).toThrow();
    expect(() =>
      database
        .prepare("UPDATE remote_services SET default_label = ?")
        .run("x".repeat(129)),
    ).toThrow();
  });

  it("新库上 default_label 缺省是空串", () => {
    upTo(46);
    database
      .prepare(
        "INSERT INTO client_sources(source_id, kind, label, added_at_ms) VALUES(?, 'local', 'x', 1)",
      )
      .run("c".repeat(32));
    expect(
      database.prepare("SELECT default_label FROM client_sources").get() as {
        default_label: string;
      },
    ).toEqual({ default_label: "" });
  });
});
