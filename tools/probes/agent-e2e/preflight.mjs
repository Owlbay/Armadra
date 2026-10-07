// agent-e2e 的开跑前检查：Claude / Codex 这两家共用装配要的前提，以及按前提
// 决定哪些场景跑、哪些记 skipped。纯函数，不读 lib.mjs（那边一导入就建输出
// 目录、解析参数）；`--preflight` 只跑这里、不起任何进程以外的东西。
//
// 缺哪家的前提只让依赖它的场景跳过，不让共用装配崩掉：比如 Codex 不是用
// `~/.codex/auth.json` 登录的（API key 提供方写在 config.toml 里），探针不复制那
// 种配置，Codex 记 skipped，Claude 与另外几家照跑。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 真跑场景要的那几家（共用装配起的节点）。6、10、11、12 自己判各家前提。 */
export const SCENARIO_NEEDS = {
  1: ["codex"],
  2: ["claude"],
  3: ["claude", "codex"],
  4: ["claude", "codex"],
  5: ["claude", "codex"],
  7: ["claude"],
  8: ["claude"],
};

/** Codex 的 token 超过这么久没刷新就不跑：临时目录里刷新会轮换真实那份。 */
export const CODEX_REFRESH_LIMIT_MS = 7 * 86_400_000;

function defaultVersion(program) {
  return execFileSync(program, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 20_000,
  }).trim();
}

/**
 * Claude 与 Codex 的前提：`{ claude, codex }`，每家 `{ ok, version?, reason? }`，
 * Codex 另带 `auth`（解析过的 auth.json，只在 ok 时有）。`version(program)` 抛错
 * 即没装。
 */
export function cliPrerequisites({
  home,
  version = defaultVersion,
  now = Date.now(),
} = {}) {
  const probe = (program) => {
    try {
      return { ok: true, version: version(program) };
    } catch {
      return { ok: false, reason: `没有 ${program}（--version 跑不起来）` };
    }
  };
  const claude = probe("claude");
  let codex = probe("codex");
  if (codex.ok) {
    const file = join(home, ".codex/auth.json");
    let auth;
    try {
      auth = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      codex = {
        ok: false,
        version: codex.version,
        reason:
          error?.code === "ENOENT"
            ? "没有 ~/.codex/auth.json（不是用 ChatGPT 登录的 Codex，比如 config.toml 里的 API key 提供方——探针不复制那种配置）"
            : "~/.codex/auth.json 读不出来或不是 JSON",
      };
    }
    if (auth !== undefined) {
      const refreshed = Date.parse(auth.last_refresh ?? "");
      codex =
        !Number.isFinite(refreshed) || now - refreshed > CODEX_REFRESH_LIMIT_MS
          ? {
              ok: false,
              version: codex.version,
              reason:
                "~/.codex/auth.json 超过 7 天没刷新：在临时 CODEX_HOME 里刷新会让真实那份失效，先在自己的终端里跑一次 codex",
            }
          : { ...codex, auth, refreshedAt: refreshed };
    }
  }
  return { claude, codex };
}

/**
 * 共用装配的场景里哪些跑、哪些跳过：答 `{ run: [id…], skip: { id: 原因 } }`。
 * `ids` 是 `--only` 里要走共用装配的那些（不含 9、11、12）。
 */
export function planScenarios(ids, clis) {
  const run = [];
  const skip = {};
  for (const id of ids) {
    const missing = (SCENARIO_NEEDS[id] ?? []).filter(
      (family) => !clis[family]?.ok,
    );
    if (missing.length === 0) run.push(id);
    else
      skip[id] = missing
        .map((family) => `${family}：${clis[family]?.reason ?? "不可用"}`)
        .join("；");
  }
  return { run, skip };
}

/** `ARMADRA_E2E_TUI_ONLY` / `ARMADRA_E2E_ACP_ONLY` 一类的家名单；没设就是全部。 */
export function chosenFamilies(value, all) {
  if (!value) return new Set(all);
  return new Set(
    value
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}
