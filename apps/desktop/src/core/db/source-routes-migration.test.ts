import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACCOUNT,
  ISSUER,
  RELAYED_ID,
  RELAY_FP,
  fakeWorld,
  memoryBackend,
} from "../sources/fake.fixture";
import { RemoteClient } from "../sources/remote-client";
import { SourceSecrets } from "../sources/secrets";
import { SourcesService } from "../sources/service";
import { SourceClient } from "../sources/source-client";
import { SourcesStore } from "../sources/store";
import { loadMigrations } from "./migrations";

/**
 * 迁移 0044（契约 §55）：旧的一源一路回填成路由，凭据（SecretStore）不动、照旧
 * 可用；旧版挂第二个中继留下的错配（旧来源 + 新 issuer）拆成两条路。
 */

const migrations = loadMigrations(
  join(dirname(fileURLToPath(import.meta.url)), "migrations"),
);
const LAN = "https://192.168.0.107:8443";
const PUBLIC = "https://relay-public.test";
const DIRECT_ID = "a".repeat(32);
const RELAY_ONLY = "b".repeat(32);
const BOTH = "c".repeat(32);
const SPLIT = "d".repeat(32);
const LOCAL = "e".repeat(32);
const FP = "9".repeat(64);

let database: DatabaseSync;

function upTo(version: number) {
  for (const migration of migrations.filter((m) => m.version <= version))
    database.exec(migration.sql);
}

function after(version: number) {
  for (const migration of migrations.filter((m) => m.version > version))
    database.exec(migration.sql);
}

function source(
  sourceId: string,
  kind: string,
  baseUrl: string,
  relayOrigin: string,
  cloudIssuer: string,
  fingerprint = "",
) {
  database
    .prepare(
      "INSERT INTO client_sources(source_id, kind, label, base_url, relay_origin, fingerprint, " +
        "cloud_issuer, added_at_ms, last_ok_at_ms) VALUES(?, ?, 'x', ?, ?, ?, ?, 10, 20)",
    )
    .run(sourceId, kind, baseUrl, relayOrigin, fingerprint, cloudIssuer);
}

function remote(serviceId: string, issuer: string, fingerprint = "") {
  database
    .prepare(
      "INSERT INTO remote_services(service_id, kind, issuer, label, account_hint, fingerprint, added_at_ms) " +
        "VALUES(?, 'personal', ?, 'r', ?, ?, 1)",
    )
    .run(serviceId, issuer, ACCOUNT, fingerprint);
}

function routes(sourceId: string) {
  return database
    .prepare(
      "SELECT via, origin, cloud_issuer, fingerprint, preferred, added_at_ms, last_ok_at_ms " +
        "FROM client_source_routes WHERE source_id = ? ORDER BY via, origin",
    )
    .all(sourceId);
}

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
});

afterEach(() => {
  database.close();
});

describe("0044_client_source_routes", () => {
  it("回填：直连一条、中继一条，直连优先作首选；本机没有路", () => {
    upTo(43);
    remote("1".repeat(32), LAN);
    source(LOCAL, "local", "", "", "");
    source(DIRECT_ID, "direct", "https://gw.test:8443", "", "", FP);
    source(RELAY_ONLY, "relayed", "", LAN, LAN);
    source(BOTH, "relayed", "https://gw.test:8443", LAN, LAN, FP);
    after(43);

    expect(routes(LOCAL)).toEqual([]);
    expect(routes(DIRECT_ID)).toEqual([
      {
        via: "direct",
        origin: "https://gw.test:8443",
        cloud_issuer: "",
        fingerprint: FP,
        preferred: 1,
        added_at_ms: 10,
        last_ok_at_ms: 20,
      },
    ]);
    expect(routes(RELAY_ONLY)).toEqual([
      {
        via: "relayed",
        origin: LAN,
        cloud_issuer: LAN,
        fingerprint: "",
        preferred: 1,
        added_at_ms: 10,
        last_ok_at_ms: 20,
      },
    ]);
    expect(
      routes(BOTH).map((row) => [
        (row as { via: string }).via,
        (row as { preferred: number }).preferred,
      ]),
    ).toEqual([
      ["direct", 1],
      ["relayed", 0],
    ]);
    // 镜像列原样。
    expect(
      database
        .prepare(
          "SELECT kind, base_url, relay_origin, cloud_issuer FROM client_sources WHERE source_id = ?",
        )
        .get(BOTH),
    ).toEqual({
      kind: "relayed",
      base_url: "https://gw.test:8443",
      relay_origin: LAN,
      cloud_issuer: LAN,
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("旧版的错配（旧中继来源 + 新 issuer）拆成两条路，镜像改成新的那条", () => {
    upTo(43);
    remote("1".repeat(32), LAN);
    remote("2".repeat(32), PUBLIC);
    source(SPLIT, "relayed", "", LAN, PUBLIC);
    after(43);
    expect(
      routes(SPLIT).map((row) => {
        const { origin, cloud_issuer, preferred } = row as {
          origin: string;
          cloud_issuer: string;
          preferred: number;
        };
        return { origin, cloud_issuer, preferred };
      }),
    ).toEqual([
      { origin: LAN, cloud_issuer: LAN, preferred: 0 },
      { origin: PUBLIC, cloud_issuer: PUBLIC, preferred: 1 },
    ]);
    expect(
      database
        .prepare(
          "SELECT relay_origin, cloud_issuer FROM client_sources WHERE source_id = ?",
        )
        .get(SPLIT),
    ).toEqual({ relay_origin: PUBLIC, cloud_issuer: PUBLIC });
  });

  it("来源与 issuer 不同但来源不是登记过的服务（SaaS 式中继节点）：不拆", () => {
    upTo(43);
    remote("2".repeat(32), PUBLIC);
    source(SPLIT, "relayed", "", "https://node-1.relay.test", PUBLIC);
    after(43);
    expect(routes(SPLIT)).toMatchObject([
      {
        via: "relayed",
        origin: "https://node-1.relay.test",
        cloud_issuer: PUBLIC,
        preferred: 1,
      },
    ]);
  });

  it("升级后旧凭据照旧可用：换票不重新 cloud/login", async () => {
    upTo(43);
    const world = fakeWorld();
    const backend = memoryBackend();
    const core = world.cores.get(`${ISSUER}/s/${RELAYED_ID}`)!;
    // 升级前就存着的两份凭据：远程服务的与源的（键是中继来源）。
    await backend.set(
      `armadra-remote-${"1".repeat(32)}`,
      JSON.stringify({
        refreshToken: world.cloud.sessions.issue("dev-remote"),
        deviceId: "dev-remote",
      }),
    );
    await backend.set(
      `armadra-source-${RELAYED_ID}`,
      JSON.stringify({
        byOrigin: {
          [ISSUER]: {
            refreshToken: core.sessions.issue("dev-core"),
            deviceId: "dev-core",
          },
        },
      }),
    );
    remote("1".repeat(32), ISSUER, RELAY_FP);
    source(RELAYED_ID, "relayed", "", ISSUER, ISSUER);
    after(43);

    const service = new SourcesService({
      store: new SourcesStore(database),
      secrets: new SourceSecrets(() => backend),
      remote: new RemoteClient(world.transport, {
        platform: "desktop",
        name: "test",
      }),
      peer: new SourceClient(world.transport),
      hostId: () => "f".repeat(32),
      hostLabel: () => "mac",
      log: { info: () => undefined, warn: () => undefined },
    });
    const listed = await service.list();
    expect(listed.sources[0]).toMatchObject({
      sourceId: RELAYED_ID,
      hasCredentials: true,
      routes: [{ via: "relayed", origin: ISSUER, preferred: true }],
    });
    const session = await service.session(RELAYED_ID);
    expect(session.via).toBe("relayed");
    expect(core.cloudLogins).toBe(0);
  });
});
