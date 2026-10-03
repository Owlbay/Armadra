import { type AcpResume, type AcpSupport, acpAdapter } from "../acp/adapters";
import { rememberedAcpVersion } from "../acp/host";
import {
  type HistoryAvailability,
  availabilityOf,
} from "../history/availability";
import { state as integrationState } from "../hook/install/integration";
import { type AgentProbe, storedProbe } from "./probe";
import {
  type AgentInfo,
  type AgentSettings,
  customInfo,
  detect,
  resolveCommand,
} from "./registry";

/**
 * `GET /api/agents` — the six built-in adapters plus the user's `custom:`
 * entries, each one answered against *this* machine and *this* data directory.
 *
 * Three halves, and none of them may be frozen into a definition:
 *
 *   * the registry row (id, label, colour, prompt mode, capabilities) is
 *     static;
 *   * `installed` / `resolvedPath` are this box's PATH, probed per request
 *     because a CLI installed a minute ago must appear without a restart;
 *   * `clientRevision`, `skillsRevision` and `launcher` are the integration's
 *     — the launcher `run/<cli>` is a path inside the running data directory,
 *     so it is answered now rather than remembered
 *     (docs/design/canvas-launcher.md §8.1). The injected argv is no longer on
 *     the row: the launcher appends it, and a caller that wants to see it reads
 *     `GET /api/agents/{id}/integration`'s `launchArgs`.
 *
 * A revision is **omitted** rather than zeroed when its half is not installed:
 * the page draws "not integrated" from the field's absence, and a `0` would
 * read as "integrated, by a build older than every revision".
 */
export interface ListAgentsOptions {
  readonly dataDir: string;
  readonly settings: AgentSettings;
  readonly env?: NodeJS.ProcessEnv;
}

export interface AgentListRow extends AgentInfo {
  readonly clientRevision?: number;
  readonly skillsRevision?: number;
  /**
   * `run/<cli>` on this machine (`run\<cli>.exe` on Windows) — what a canvas
   * launch line starts, with the CLI's program and flags as its arguments. A
   * `custom:` entry answers its base CLI's. Absent while there is no current
   * launcher (not written yet, Windows without `armadra-launch.exe`): the page
   * then types a bare line.
   */
  readonly launcher?: string;
  /**
   * 缓存好的 `--version` 探测（`probe.ts`）。缺席表示这个 CLI 还没被探过，共享
   * 的求交集把它读成 unknown——**从不**读成「支持」。
   *
   * 这里只**读**缓存：探测在后台扫描里跑，一次列表绝不等一个子进程。
   */
  readonly probe?: AgentProbe;
  /**
   * 本机有没有这家 CLI 的历史数据（契约 §12.2）。只 stat 根目录，不扫描：
   * 列表要便宜。
   */
  readonly history: HistoryAvailability;
  /**
   * 这家 CLI 在本机怎么说 ACP（契约 §14.1）。`installed` 在补齐过的 PATH 上找
   * 适配器程序，每次请求都探；`version` 只读最近一次起会话或探测时
   * `initialize` 报的值，没有就缺席——列表从不为它起进程。没有 ACP 入口的行
   * 不带这个键。
   */
  readonly acp?: AgentAcpInfo;
}

/** `GET /api/agents` 行的 `acp`（契约 §14.1）。 */
export interface AgentAcpInfo {
  readonly support: AcpSupport;
  readonly program: string;
  readonly installed: boolean;
  readonly version?: string;
  readonly resume: AcpResume;
}

export function listAgents(options: ListAgentsOptions): AgentListRow[] {
  const rows: AgentInfo[] = [
    ...detect(),
    ...options.settings.customAgents().map((custom) => customInfo(custom)),
  ];
  return rows.map((row) => {
    const acp = acpOf(row, options);
    return {
      ...withIntegration(row, options),
      history: availabilityOf(row.id, options.settings, options.env),
      ...(acp === undefined ? {} : { acp }),
    };
  });
}

/**
 * ACP 那一半。一个 `custom:` 条目借它基础适配器的：ACP 入口是那家 CLI 的
 * 适配器程序，与用户给它起的标签和启动程序无关。
 */
function acpOf(
  row: AgentInfo,
  options: ListAgentsOptions,
): AgentAcpInfo | undefined {
  const provider = row.baseAgent ?? row.id;
  const adapter = acpAdapter(provider);
  if (adapter === undefined) return undefined;
  const installed =
    resolveCommand(adapter.program, options.env ?? process.env) !== undefined;
  const version = installed ? rememberedAcpVersion(provider) : undefined;
  return {
    support: adapter.support,
    program: adapter.program,
    installed,
    ...(version === undefined ? {} : { version }),
    resume: adapter.resume,
  };
}

/**
 * The integration half of one row.
 *
 * A `custom:` entry borrows its base adapter's integration: the files on disk
 * belong to the CLI, not to the label the user gave it, so a custom Claude
 * reports the same revisions and the same launcher as Claude itself.
 *
 * Reading it must never take the list down. An unreadable config home is the
 * normal state of a CLI that is not installed, and the answer for it is a row
 * with no revisions — not a 500 that empties the new-node menu.
 */
function withIntegration(
  row: AgentInfo,
  options: ListAgentsOptions,
): Omit<AgentListRow, "history"> {
  const provider = row.baseAgent ?? row.id;
  let state;
  try {
    state = integrationState(provider, {
      dataDir: options.dataDir,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  } catch {
    return { ...row, ...withProbe(row) };
  }
  return {
    ...row,
    ...(state.hook.installed ? { clientRevision: state.hook.revision } : {}),
    ...(state.skill.installed ? { skillsRevision: state.skill.revision } : {}),
    ...(state.launcher === undefined ? {} : { launcher: state.launcher }),
    ...withProbe(row),
  };
}

/**
 * 探测那一半。
 *
 * 一个 `custom:` 条目**不**借基础适配器的探测：它跑的是自己的启动程序，而版本是
 * 那个程序的事实。借来的版本会替一个从没被问过的二进制作担保。
 */
function withProbe(row: AgentInfo): { probe?: AgentProbe } {
  const probe = storedProbe(row.id);
  return probe === undefined ? {} : { probe };
}
