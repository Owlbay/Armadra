/**
 * The settings domain: the preferences document, the local split, and the
 * execution host registry read out of it.
 *
 * Nine routes from phase 1, plus `GET /api/execution-hosts/{id}` and
 * `POST …/{id}/resync` for the Worker fleet (contract §21.2; the reconnect
 * itself is the remote domain's, reached through `remote/fleet.ts`).
 * `POST /api/execution-hosts/{id}/validate`
 * is the tenth in the table and is **not** here: it reaches a machine over
 * `ssh` and runs the Worker's version handshake, so it is registered by
 * `core/remote`, which owns the host-key file, the askpass helper and the
 * Worker connections it needs. The registry itself stays this domain's — the
 * remote domain reads it through {@link settingsDomain} rather than keeping a
 * second copy.
 */

import type { CoreContext } from "../main";
import { settingsFile, workerSettingsFile } from "../paths";
import {
  deleteExecutionHost,
  exportExecutionHosts,
  importExecutionHosts,
  getExecutionHost,
  listExecutionHosts,
  putExecutionHost,
  resyncExecutionHost,
  type ExecutionHostDeps,
} from "./execution-hosts";
import { CoreFailure } from "../http/errors";
import { registerProcedures } from "../http/rpc";
import type { JsonObject } from "./local";
import { localPaths } from "./local";
import {
  applySettingsPatch,
  getLocalSettings,
  getSettings,
  patchSettings,
} from "./routes";
import { SettingsStore } from "./store";
import { workspaceCounts } from "./workspace-counts";
import { effectiveHostName } from "./host-name";

export { SettingsStore } from "./store";
export type { JsonObject, JsonValue } from "./local";
export { isLocal, localPaths, LOCAL_PATHS } from "./local";
export { completionSettings, normalize, merge } from "./schema";
export { parseHosts, validateHost, type SshHost } from "./ssh-hosts";
export { systemHostName } from "./host-name";

/** The store this run assembled, so other domains can read a preference. */
export interface SettingsDomain {
  readonly settings: SettingsStore;
}

let assembled: SettingsDomain | undefined;

/**
 * The settings store of the running core.
 *
 * A module-level handle rather than something threaded through `CoreContext`,
 * because almost every domain reads a preference and almost none writes one:
 * putting the store in the context would make every signature carry it. It is
 * set by `install` and is undefined until then, which is exactly the window in
 * which nothing has started.
 */
export function settingsDomain(): SettingsDomain | undefined {
  return assembled;
}

/**
 * 这台主机的名字（契约 §61）：设置 `host.name`，没设（或设置域还没装）是系统
 * 主机名。每次现读，改了设置即时生效。
 */
export function currentHostName(): string {
  return effectiveHostName(assembled?.settings.snapshot());
}

export function install(context: CoreContext): SettingsDomain {
  const localFile = workerSettingsFile(context.dataDir);
  const settings = SettingsStore.load({
    sharedFile: settingsFile(context.dataDir),
    localFile,
    onError: (error) =>
      context.log.warn("could not write the settings document", {
        error: error instanceof Error ? error.message : String(error),
      }),
  });
  const deps = { settings, workerSettingsFile: localFile };
  const hosts: ExecutionHostDeps = {
    settings,
    workspaceCounts: () => workspaceCounts(context.db.database),
  };

  const { router } = context.server;
  // 契约 §34.5：与下面三条旧路径同一份实现。
  registerProcedures(context.server, "settings", {
    get: () => deps.settings.snapshot(),
    update: (patch) => {
      const answer = applySettingsPatch(deps, patch);
      if (answer.status >= 400) {
        const { code, message } = answer.body as {
          code: string;
          message: string;
        };
        throw new CoreFailure(answer.status, code, message);
      }
      return answer.body as JsonObject;
    },
    local: () => ({ paths: [...localPaths()], file: deps.workerSettingsFile }),
  });
  router.handle("GET", "/api/settings", () => getSettings(deps));
  router.handle("PATCH", "/api/settings", (_match, request) =>
    patchSettings(deps, request),
  );
  router.handle("GET", "/api/settings/local", () => getLocalSettings(deps));

  router.handle("GET", "/api/execution-hosts", () => listExecutionHosts(hosts));
  router.handle("GET", "/api/execution-hosts/export", () =>
    exportExecutionHosts(hosts),
  );
  router.handle("POST", "/api/execution-hosts/import", (_match, request) =>
    importExecutionHosts(hosts, request),
  );
  router.handle("PUT", "/api/execution-hosts/{hostId}", (match, request) =>
    putExecutionHost(hosts, match.params.hostId ?? "", request),
  );
  router.handle("DELETE", "/api/execution-hosts/{hostId}", (match) =>
    deleteExecutionHost(hosts, match.params.hostId ?? ""),
  );
  // Worker 舰队（契约 §21.2）：单台主机的行（带 `worker`）与重新同步。
  router.handle("GET", "/api/execution-hosts/{hostId}", (match) =>
    getExecutionHost(hosts, match.params.hostId ?? ""),
  );
  router.handle("POST", "/api/execution-hosts/{hostId}/resync", (match) =>
    resyncExecutionHost(hosts, match.params.hostId ?? ""),
  );

  assembled = { settings };
  return assembled;
}
