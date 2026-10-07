import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { loadMigrations } from "./migrations";

it("preserves released queue receipts when extending the queue with controller actors", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const migrations = loadMigrations(
      join(dirname(fileURLToPath(import.meta.url)), "migrations"),
    );
    for (const migration of migrations.filter((m) => m.version <= 41))
      database.exec(migration.sql);
    database
      .prepare(
        "INSERT INTO agent_send_queue (id, workspace_id, source_node_id, target_node_id, origin, body, trail, created_at, expires_at, state, settled_by, notified_at) VALUES ('old', 'workspace', 'source', 'target', 'send', 'preserved', '[]', 1, 2, 'cancelled', 'target', 3)",
      )
      .run();
    for (const migration of migrations.filter((m) => m.version > 41))
      database.exec(migration.sql);
    expect(
      database
        .prepare(
          "SELECT body, source_node_id, source_kind, settled_by, notified_at FROM agent_send_queue WHERE id = 'old'",
        )
        .get(),
    ).toMatchObject({
      body: "preserved",
      source_node_id: "source",
      source_kind: "node",
      settled_by: "target",
      notified_at: 3,
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    database.close();
  }
});
