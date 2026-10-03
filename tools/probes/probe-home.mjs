// 探针起的 core / 服务器壳 / Electron / CLI 用的临时 HOME。
//
// 探针只许碰自己造出来的东西：core 读 HOME 下的 CLI 登录状态（`~/.claude`、
// `~/.codex`……）、给 tmux 找 `~/.tmux.conf`、跑 git 时读 `~/.gitconfig`。用操作员
// 的真实 HOME 起 core，结果就随这台机器变：装了并登录过 Claude 的机器上，页面会
// 弹「Claude 的额度读取现已默认关闭」，正好盖住 remote-e2e 要点的「提交」按钮。
//
// 这里给出一份环境：HOME 与各 CLI、XDG、git 的全局配置都指进一个 mktemp 目录，
// 再去掉会把真实账号带进去的那几个凭据变量。Vite / pnpm 这类工具链进程不用它
// ——它们只是构建工具，读自己的 store 与配置，不读 Armadra 或 CLI 的状态。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 指向真实账号的凭据变量：探针的进程里一个都不留。 */
export const CREDENTIAL_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "COPILOT_GITHUB_TOKEN",
];

/**
 * 造一个临时 HOME，返回它的路径、给子进程用的环境变量（只含要覆盖的键）与
 * 删除函数。`.gitconfig` 里放一个探针身份，core 在临时 HOME 下照样能提交。
 */
export function probeHome(prefix = "armadra-probe-home-") {
  const path = mkdtempSync(join(tmpdir(), prefix));
  for (const directory of [".config", ".local/share", ".local/state", ".cache"])
    mkdirSync(join(path, directory), { recursive: true });
  const gitconfig = join(path, ".gitconfig");
  writeFileSync(
    gitconfig,
    "[user]\n\tname = probe\n\temail = probe@example.invalid\n[init]\n\tdefaultBranch = main\n",
  );
  const env = {
    HOME: path,
    USERPROFILE: path,
    XDG_CONFIG_HOME: join(path, ".config"),
    XDG_DATA_HOME: join(path, ".local/share"),
    XDG_STATE_HOME: join(path, ".local/state"),
    XDG_CACHE_HOME: join(path, ".cache"),
    CLAUDE_CONFIG_DIR: join(path, ".claude"),
    CODEX_HOME: join(path, ".codex"),
    COPILOT_HOME: join(path, ".copilot"),
    GIT_CONFIG_GLOBAL: gitconfig,
  };
  return {
    path,
    env,
    remove: () => rmSync(path, { recursive: true, force: true }),
  };
}

/**
 * 给 Armadra 进程的完整环境：当前环境去掉凭据变量，叠上临时 HOME，再叠上
 * 调用方自己的键（`extra` 最后，所以它能覆盖前面任何一个）。
 */
export function isolatedEnv(home, extra = {}) {
  const base = { ...process.env };
  for (const name of CREDENTIAL_VARIABLES) delete base[name];
  return { ...base, ...home.env, ...extra };
}
