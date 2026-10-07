/**
 * `Armadra serve [参数]`：桌面安装包里带的服务器壳入口（平台计划 A5-1）。
 *
 * 同一个二进制收到 `serve` 就不开窗口、不抢单实例锁、不碰更新与崩溃上报，而是
 * 以 `ELECTRON_RUN_AS_NODE=1` 把自己当 Node 重新起一遍，跑
 * `<resources>/server/main.js serve …`（`apps/server` 的构建产物），参数原样透传。
 * 这样原生模块（node-pty）与桌面是同一份、同一个 ABI。
 *
 * 判定与参数拼装是纯函数，进程的起停在 {@link runServeShell}；`main/entry.ts`
 * 是唯一调用方，在 `index.ts` 的任何装配之前问它。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** 服务器壳在安装包里的位置：`<resources>/server/{main.js,web/}`。 */
export const SERVER_DIR = "server";

/**
 * `serve` 子命令之后的参数；不是 serve 调用时答 `null`。
 *
 * 认两种写法：`Armadra serve …`（`argv[1]` 就是 `serve`）与任意位置的
 * `--serve`（开发时 `electron . --serve`）。后一种把 `--serve` 摘掉，其余原样。
 */
export function serveArguments(argv: readonly string[]): string[] | null {
  const rest = argv.slice(1);
  if (rest[0] === "serve") return rest.slice(1);
  if (rest.includes("--serve")) return rest.filter((arg) => arg !== "--serve");
  return null;
}

export interface ServeLaunch {
  readonly command: string;
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
  /** 入口脚本；调用方先确认它在盘上。 */
  readonly entry: string;
}

/** 参数里有没有给 `--web-root`（`--web-root X` 或 `--web-root=X`）。 */
function givesWebRoot(args: readonly string[]): boolean {
  return args.some((a) => a === "--web-root" || a.startsWith("--web-root="));
}

/** 参数里有没有给 `--data-dir`（两种写法）。 */
function givesDataDir(args: readonly string[]): boolean {
  return args.some((a) => a === "--data-dir" || a.startsWith("--data-dir="));
}

/** serve 缺省的数据目录名，在用户主目录下；与桌面的数据目录互不相干。 */
export const SERVE_DATA_DIR = ".armadra-server";

/**
 * 子进程怎么起。
 *
 *   * 数据目录：`--data-dir` 与环境变量 `ARMADRA_DATA_DIR` 都没给时，用
 *     `~/.armadra-server`，**绝不落到桌面的默认数据目录**——桌面可能正开着同一份
 *     库，而服务器壳的迁移版本可能比那份库新（事故：2026-10-06）。
 *   * 页面产物：用户没给 `--web-root` 就指向包内 `server/web`。
 *   * 迁移：`ARMADRA_CORE_MIGRATIONS_DIR` 指向包内 `migrations/`（用户已设则不动）。
 *   * node-pty：它在 `app.asar.unpacked/node_modules` 里，服务器壳的 `main.js`
 *     在 asar 之外找不到它，经 `NODE_PATH` 补上；Electron 当 Node 跑时读 asar 的
 *     补丁照样在。
 *   * hook 客户端与随包 ama 在 `resources/cli`、`resources/agent*`，core 从
 *     `server/` 往上一级就找得到，不用再复制。
 */
export function serveLaunch(
  rest: readonly string[],
  options: {
    execPath: string;
    resourcesPath: string;
    env: NodeJS.ProcessEnv;
    home?: string;
  },
): ServeLaunch {
  const { execPath, resourcesPath, env } = options;
  const serverDir = join(resourcesPath, SERVER_DIR);
  const entry = join(serverDir, "main.js");
  const args = [entry, "serve", ...rest];
  if (!givesDataDir(rest) && !env.ARMADRA_DATA_DIR)
    args.push("--data-dir", join(options.home ?? homedir(), SERVE_DATA_DIR));
  if (!givesWebRoot(rest)) args.push("--web-root", join(serverDir, "web"));
  const unpacked = join(resourcesPath, "app.asar.unpacked", "node_modules");
  const nodePath = [unpacked, env.NODE_PATH]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(delimiter);
  return {
    command: execPath,
    args,
    entry,
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_PATH: nodePath,
      ARMADRA_CORE_MIGRATIONS_DIR:
        env.ARMADRA_CORE_MIGRATIONS_DIR || join(resourcesPath, "migrations"),
    },
  };
}

/**
 * 起服务器壳，把它的退出码当作自己的。终止信号转给子进程（它自己收尾后退出，
 * 我们跟着退出）；子进程起不来、入口缺失时在标准错误说明并以 1 退出。
 */
export function runServeShell(
  rest: readonly string[],
  deps: {
    execPath?: string;
    resourcesPath?: string;
    env?: NodeJS.ProcessEnv;
    home?: string;
    exists?: (path: string) => boolean;
    start?: typeof spawn;
    exit?: (code: number) => void;
    stderr?: (line: string) => void;
  } = {},
): ChildProcess | null {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const stderr = deps.stderr ?? ((line) => process.stderr.write(line));
  const launch = serveLaunch(rest, {
    execPath: deps.execPath ?? process.execPath,
    resourcesPath: deps.resourcesPath ?? process.resourcesPath,
    env: deps.env ?? process.env,
    ...(deps.home === undefined ? {} : { home: deps.home }),
  });
  if (!(deps.exists ?? existsSync)(launch.entry)) {
    stderr(
      `Armadra serve：找不到 ${launch.entry}；服务器壳只随打包后的安装包提供\n`,
    );
    exit(1);
    return null;
  }
  const child = (deps.start ?? spawn)(launch.command, launch.args, {
    env: launch.env,
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    stderr(`Armadra serve：服务器壳没有起来：${error.message}\n`);
    exit(1);
  });
  child.on("exit", (code, signal) => {
    exit(code ?? (signal === null ? 1 : 128));
  });
  return child;
}
