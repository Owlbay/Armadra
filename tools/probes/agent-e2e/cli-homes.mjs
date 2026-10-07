// 另外四个 CLI（OpenCode / Pi / OMP / Copilot）的临时 HOME 与凭据复制，场景 6、
// 10、12 共用。由 lib.mjs 再导出。
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/* ------------------- 另外四个 CLI 的临时 HOME（场景 6、10） ------------------- */

export function which(program) {
  try {
    return execFileSync("which", [program], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

/** 包里的原生 OpenCode：`<全局 node_modules>/opencode-ai/node_modules/opencode-<平台>/bin/opencode`。 */
export function opencodeBinary() {
  try {
    const wrapper = execFileSync("which", ["opencode"], {
      encoding: "utf8",
    }).trim();
    const prefix = join(wrapper, "..", "..", "lib", "node_modules");
    const native = join(
      prefix,
      "opencode-ai",
      "node_modules",
      `opencode-${process.platform}-${process.arch}`,
      "bin",
      "opencode",
    );
    return existsSync(native) ? native : undefined;
  } catch {
    return undefined;
  }
}

/**
 * OpenCode / Pi / OMP / Copilot 的临时 HOME 与凭据。答
 * `{ [id]: { program, home, agentDir?, copilotHome?, xdgData?, secrets?, model? } }`，
 * 认证不上的那一家是 `{ skip }`。凭据只**复制**，绝不写操作员的配置目录
 * （本机实测见场景 6 顶部）：
 *
 *   * Pi：复制 ~/.pi/agent/auth.json 里的 moonshotai-cn 那一条（API key，不会
 *     刷新；OAuth 那条不复制，刷新会轮换真实那份），模型 kimi-k2.6。
 *   * OMP：同一把 key 经环境变量交给临时 models.yml 里的一个提供商（OMP 自带的
 *     moonshot 指向国际站，这把 key 在那边无效）。
 *   * OpenCode：用包里的原生二进制和它自带的免费模型，不需要凭据。
 *   * Copilot：登录在钥匙串里，`gh auth token` 取出的令牌经
 *     COPILOT_GITHUB_TOKEN 交给这一个进程（不写任何文件，不打印）。
 *
 * `dirs` 把 Pi / OMP 的 agent 目录（`pi` / `omp`）、`COPILOT_HOME`（`copilot`）
 * 与 OpenCode 的 `XDG_DATA_HOME`（`xdgData`）指到给定位置——场景 10 指到 core
 * 的根，core 才认得出这些会话；缺省都在各自的临时 HOME 里（场景 6）。
 */
export function prepareCliHomes(scratch, { dirs = {}, only } = {}) {
  const clis = {};
  // `only`：只准备这几家；别的家连凭据都不读。
  const wanted = (id) => only === undefined || only.has(id);
  const home = (id) => {
    const path = join(scratch, `home-${id}`);
    mkdirSync(path, { recursive: true });
    return path;
  };
  const piAuth = (() => {
    if (!wanted("pi") && !wanted("omp")) return undefined;
    try {
      return JSON.parse(
        readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8"),
      )["moonshotai-cn"];
    } catch {
      return undefined;
    }
  })();

  /* OpenCode */
  {
    const program = opencodeBinary();
    if (program) {
      const h = home("opencode");
      clis.opencode = {
        program,
        home: h,
        xdgData: dirs.xdgData ?? `${h}/.local/share`,
        // 免费模型的名单随 OpenCode 的在线目录变（新 HOME 里内置的那份已经
        // 过期）：跑之前先 `models --refresh` 刷一次目录再挑。
        model: "opencode/big-pickle",
      };
    } else {
      clis.opencode = { skip: "没有找到 OpenCode 的原生二进制" };
    }
  }

  /* Pi */
  if (which("pi") && piAuth?.type === "api_key") {
    const h = home("pi");
    const agentDir = dirs.pi ?? join(h, ".pi/agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "auth.json"),
      JSON.stringify({ "moonshotai-cn": piAuth }),
      { mode: 0o600 },
    );
    clis.pi = {
      program: which("pi"),
      home: h,
      agentDir,
      model: "moonshotai-cn/kimi-k2.6",
    };
  } else {
    clis.pi = {
      skip: "没有 pi，或 ~/.pi/agent/auth.json 里没有 API key 形式的凭据",
    };
  }

  /* OMP */
  if (which("omp") && piAuth?.type === "api_key") {
    const h = home("omp");
    const agentDir = dirs.omp ?? join(h, ".omp/agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "models.yml"),
      [
        "providers:",
        "  moonshot-cn:",
        "    baseUrl: https://api.moonshot.cn/v1",
        "    apiKey: MOONSHOT_API_KEY",
        "    api: openai-completions",
        "    authHeader: true",
        "    models:",
        "      - id: kimi-k2.6",
        "        name: Kimi K2.6",
        "        reasoning: false",
        "        input: [text]",
        "",
      ].join("\n"),
    );
    clis.omp = {
      program: which("omp"),
      home: h,
      // OMP 也认 PI_CODING_AGENT_DIR（core 的环境里带着一个）：指到它自己的目录。
      agentDir,
      secrets: { MOONSHOT_API_KEY: piAuth.key },
      model: "moonshot-cn/kimi-k2.6",
    };
  } else {
    clis.omp = { skip: "没有 omp，或没有可复制的 API key" };
  }

  /* Copilot */
  let token;
  if (wanted("copilot")) {
    try {
      token = execFileSync("gh", ["auth", "token"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {}
  }
  if (which("copilot") && token) {
    const h = home("copilot");
    const copilotHome = dirs.copilot ?? join(h, ".copilot");
    mkdirSync(copilotHome, { recursive: true });
    // 只复制非凭据的那份（信任过的目录、上次登录的账号名）：没有它 Copilot 会
    // 在第一次启动时问这些。
    try {
      copyFileSync(
        join(homedir(), ".copilot/config.json"),
        join(copilotHome, "config.json"),
      );
    } catch {}
    clis.copilot = {
      program: which("copilot"),
      home: h,
      copilotHome,
      secrets: { COPILOT_GITHUB_TOKEN: token },
      model: "gpt-5-mini",
    };
  } else {
    clis.copilot = { skip: "没有 copilot，或 `gh auth token` 取不到令牌" };
  }
  for (const id of ["opencode", "pi", "omp", "copilot"])
    if (!wanted(id)) clis[id] = { skip: "没选这家" };
  return clis;
}

/**
 * 包装脚本里换环境的那几行：HOME 与各 CLI 的配置目录换成临时的，再读 0600 的
 * 凭据文件（凭据不进脚本正文、不进命令行）。答脚本行，不含 shebang。
 */
export function cliEnvLines(scratch, id, cli) {
  const secretsFile = join(scratch, `secrets-${id}.sh`);
  writeFileSync(
    secretsFile,
    Object.entries(cli.secrets ?? {})
      .map(([name, value]) => `export ${name}='${value.replaceAll("'", "")}'`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  const h = cli.home;
  return [
    `export HOME='${h}'`,
    `export XDG_CONFIG_HOME='${h}/.config' XDG_DATA_HOME='${cli.xdgData ?? `${h}/.local/share`}' XDG_STATE_HOME='${h}/.local/state' XDG_CACHE_HOME='${h}/.cache'`,
    `export COPILOT_HOME='${cli.copilotHome ?? `${h}/.copilot`}' PI_CODING_AGENT_DIR='${cli.agentDir ?? `${h}/.pi/agent`}'`,
    "unset CLAUDE_CONFIG_DIR CODEX_HOME CLAUDECODE",
    `. '${secretsFile}'`,
  ];
}
