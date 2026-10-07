import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { configHomeWith, envReader } from "../hook/install/shared";

/**
 * 各 CLI 的家目录，一份。
 *
 * 之前有四份：`collab/transcript.ts` 的 `home()` / `codexHome()`、
 * `conversations/claude.ts` 的 `claudeHome()` 和 `usage/providers.ts` 的
 * `homeDir()`，覆盖变量与兜底各写各的。配置目录的规则以
 * `hook/install/shared.ts::configHomeWith` 为准——装 Hook 的那一处和读记录的这
 * 一处必须指向同一个目录，否则用户改了 `CODEX_HOME` 以后两边各认一个。
 */

/** `~`，Windows 用 `USERPROFILE`；拿不到时是 `undefined`。 */
export function homeDir(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env.HOME ?? env.USERPROFILE ?? homedir();
  return value === "" ? undefined : value;
}

/**
 * 这家 CLI 的配置目录：CLI 自己的覆盖优先，否则落在家目录下。
 *
 * 没有家目录时只认覆盖：落在相对路径上的结果指向的是进程当前目录，那不是任何
 * 一家 CLI 的家。没有安装器规则的 id（自定义条目）也是 `undefined`。
 */
export function configRoot(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const home = homeDir(env);
  let resolved: string;
  try {
    resolved = configHomeWith(agentId, envReader(env), home ?? "");
  } catch {
    return undefined;
  }
  if (home === undefined && !isAbsolute(resolved)) return undefined;
  return resolved;
}
