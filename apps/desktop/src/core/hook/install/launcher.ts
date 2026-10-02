import { posix } from "node:path";
import { posixQuote } from "../../terminal/shell";

/**
 * 画布启动器与垫片的 POSIX 生成器（docs/design/canvas-launcher.md §4、§6.1）。
 *
 * 每个有注入的 CLI 在 `<根>/integration/` 下有两个可执行文件：
 *
 *   * **启动器** `run/<cli>`：节点 shell 里敲的那一行调用它，程序与 CLI 自己的
 *     旗标作参数。环境里有 `ARMADRA_NODE_ID` 时给 CLI 进程设注入的变量、在调用者
 *     的参数之后接上注入的 argv，再 `exec`；没有时原样 `exec`——shell 历史里的那
 *     一行在画布外重跑就是一次普通启动。注入的词是文件里的字面量，不经 PTY、不经
 *     shell 展开，没有长度与引用问题。
 *   * **垫片** `shims/<cli>`：与 CLI 同名，节点终端的 `PATH` 把 `shims/` 放在最
 *     前面。它先把自己的目录从 `PATH` 摘掉，再把调用委托给启动器，所以 CLI 再起的
 *     同名程序找到的是真 CLI，不会二次注入。
 *
 * 本机（`inject.ts::prepareInjection`）与执行主机（`remote.ts`）共用这里：纯函数，
 * 只拼正文，不碰磁盘。Windows 那半是 `windows-launcher.ts` 的 C# 启动器。
 */

/** 启动器的门：只有画布节点终端的环境里有它。 */
export const LAUNCH_GATE = "ARMADRA_NODE_ID";

/**
 * 路径怎么拼。本机数据目录用原生的；同步到执行主机的那份用 `path.posix.join`。
 * 与 `inject.ts::PathJoin` 同形，放在这里免得两个模块互相导入。
 */
export type PathJoin = (...parts: string[]) => string;

export interface LauncherSpec {
  readonly agentId: string;
  /** `<根>/integration/run`。 */
  readonly runDir: string;
  /** `<根>/integration/shims`。 */
  readonly shimDir: string;
  /** 启动器追加在调用者参数之后的 argv，字面值（`canvasInjection` 答的 `args`）。 */
  readonly args: readonly string[];
  /** 启动器只给 CLI 进程设的变量（`canvasInjection` 答的 `env`）。 */
  readonly env: readonly (readonly [string, string])[];
}

/** 一个要写的可执行文件。 */
export interface LauncherFile {
  readonly content: string;
  readonly mode: number;
}

/** `<根>/integration/run`：启动器所在的目录。 */
export function runDirectory(root: string, join: PathJoin): string {
  return join(root, "integration", "run");
}

/** `<根>/integration/shims`：垫片所在的目录，节点终端的 `PATH` 把它放最前面。 */
export function shimsDirectory(root: string, join: PathJoin): string {
  return join(root, "integration", "shims");
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function exportLines(env: LauncherSpec["env"]): string[] {
  const lines: string[] = [];
  for (const [name, value] of env) {
    // 名字是我们自己的常量；不像变量名的东西写进脚本就是一行代码。
    if (!ENV_NAME.test(name)) {
      throw new Error(`not an environment variable name: ${name}`);
    }
    lines.push(`${name}=${posixQuote(value)}; export ${name}`);
  }
  return lines;
}

/**
 * `run/<cli>` 的正文。
 *
 * 两个 `exec`，没有子进程：CLI 顶替启动器的 pid，进程树与直接起 CLI 一样。
 * `$1` 是程序（绝对路径或裸名），后面的词原样透传，`--` 之后的也一样；启动器
 * 不解析、不改写调用者的任何词。注入的文件不在由 CLI 报错，启动器不检查。
 */
export function posixLauncher(spec: LauncherSpec): string {
  const tail = spec.args.map((arg) => posixQuote(arg)).join(" ");
  return [
    "#!/bin/sh",
    `# Armadra 画布启动器（${spec.agentId}）。由 core 生成，改动会被覆盖。`,
    `# 用法：run/${spec.agentId} <程序> [程序前置词…] [CLI 的参数…]`,
    `# 没有 ${LAUNCH_GATE}（不是画布节点，或在画布外重跑这一行）时原样启动程序。`,
    `[ -n "\${${LAUNCH_GATE}:-}" ] || exec "$@"`,
    // 变量在第一个 `exec` 之后才设：画布外不设。
    ...exportLines(spec.env),
    `exec "$@"${tail === "" ? "" : ` ${tail}`}`,
    "",
  ].join("\n");
}

/**
 * `shims/<cli>` 的正文：摘掉自己的目录，再委托给 `run/<cli>`，程序传裸名，由
 * 摘过的 `PATH` 找真 CLI。节点 shell 的 rc 若整条重设 `PATH`，垫片就不在了，
 * 手敲的 CLI 不带注入——尽力而为，启动行写的是启动器的绝对路径，不受影响。
 */
export function posixShim(spec: LauncherSpec): string {
  return [
    "#!/bin/sh",
    `# Armadra 画布垫片（${spec.agentId}）：只在画布节点终端的 PATH 最前面。由 core 生成，改动会被覆盖。`,
    `shims=${posixQuote(spec.shimDir)}`,
    "rest=; set -f; old_ifs=$IFS; IFS=:",
    'for entry in $PATH; do [ "$entry" = "$shims" ] && continue; rest="${rest:+$rest:}$entry"; done',
    "IFS=$old_ifs; set +f; PATH=$rest; export PATH",
    `exec ${posixQuote(posix.join(spec.runDir, spec.agentId))} ${posixQuote(spec.agentId)} "$@"`,
    "",
  ].join("\n");
}

/**
 * 一个 CLI 的启动器与垫片，路径 → 正文与权限。确定性的：同样的产物布局与注入
 * 生成同样的字节，写的一方据此「字节相同不写」。
 */
export function launcherFiles(
  spec: LauncherSpec,
  join: PathJoin,
): Map<string, LauncherFile> {
  return new Map([
    [
      join(spec.runDir, spec.agentId),
      { content: posixLauncher(spec), mode: 0o755 },
    ],
    [
      join(spec.shimDir, spec.agentId),
      { content: posixShim(spec), mode: 0o755 },
    ],
  ]);
}
