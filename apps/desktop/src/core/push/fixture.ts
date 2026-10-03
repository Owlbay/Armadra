import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../db/open";
import { AccountsService } from "../identity/accounts";
import { type AuthorizationSubject, Authorizer } from "../identity/authorize";
import { scope } from "../identity/scopes";
import { IdentityService } from "../identity/service";
import { IdentityStore } from "../identity/store";
import type { CoreLog } from "../platform";
import { completionSettings } from "../settings/schema";
import type { JsonObject } from "../settings/local";
import { tempDir } from "../testing/temp-dir";
import { PushService } from "./service";

/**
 * 推送用例的真库夹具：一个配对出来的 owner、按需加的成员（带授予与一台身份
 * 设备）、以及装在这份库上的 {@link PushService}。只给测试用，不 import vitest。
 */

const here = dirname(fileURLToPath(import.meta.url));
const INSTANCE = "0123456789abcdef0123456789abcdef";
const ORIGIN = "http://127.0.0.1:1420";

export const QUIET_LOG: CoreLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface FixtureOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly settings?: JsonObject;
  readonly fetch?: typeof fetch;
  readonly clock?: () => number;
  readonly log?: CoreLog;
}

export function pushFixture(options: FixtureOptions = {}) {
  const dataDir = tempDir("armadra-push-");
  const opened = openDatabase({
    file: join(dataDir, "canvas.db"),
    migrationsDir: resolve(here, "../db/migrations"),
  });
  const database = opened.database;
  const store = new IdentityStore(database);
  const identity = new IdentityService(store, INSTANCE);
  const accounts = new AccountsService({ store });
  const authorizer = new Authorizer(store);
  const ticket = identity.issueBootstrap({
    hostId: store.hostId(),
    instanceId: INSTANCE,
    origin: ORIGIN,
    deviceName: "owner 的手机",
    scopes: [scope("identity:manage"), scope("identity:read")],
  });
  const paired = identity.consumeBootstrap({
    ticket: ticket.ticket,
    hostId: store.hostId(),
    instanceId: INSTANCE,
    origin: ORIGIN,
  });
  const owner: AuthorizationSubject = {
    principalId: paired.principal.principalId,
    kind: "owner",
    scopes: paired.principal.scopes,
  };
  const ownerDeviceId = paired.principal.deviceId;
  let settings: JsonObject = options.settings ?? {};

  const push = new PushService({
    database,
    dataDir,
    log: options.log ?? QUIET_LOG,
    env: options.env ?? {},
    settings: () => completionSettings(settings),
    canRead: (principalId, principalKind, workspaceId) =>
      authorizer.permits(
        {
          principalId,
          kind: principalKind === "owner" ? "owner" : "member",
          scopes: [],
        },
        [scope("canvas:read", workspaceId)],
      ),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  /** 一个成员：可选地在若干工作空间上有角色，带一台身份设备。 */
  function member(
    displayName: string,
    grants: Record<string, "viewer" | "editor" | "operator" | "driver"> = {},
  ) {
    const principal = accounts.createPrincipal(owner, { displayName });
    for (const [workspaceId, role] of Object.entries(grants)) {
      accounts.putGrant(owner, {
        workspaceId,
        subjectKind: "principal",
        subjectId: principal.principalId,
        role,
      });
    }
    const deviceId = randomBytes(16).toString("hex");
    database
      .prepare(
        `INSERT INTO identity_devices (device_id, principal_id, name, role, epoch, created_at_ms)
         VALUES (?, ?, ?, 'member', 1, ?)`,
      )
      .run(
        deviceId,
        principal.principalId,
        `${displayName} 的手机`,
        Date.now(),
      );
    return { principalId: principal.principalId, deviceId };
  }

  function workspace(id: string, name: string): void {
    const now = new Date().toISOString();
    database
      .prepare(
        "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, name, join(dataDir, `root-${id}`), now, now);
  }

  return {
    dataDir,
    database,
    owner,
    ownerDeviceId,
    push,
    member,
    workspace,
    setSettings(next: JsonObject) {
      settings = next;
    },
    close() {
      push.stop();
      opened.close();
    },
  };
}
