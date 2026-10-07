import { createHash } from "node:crypto";
import { posix } from "node:path";
import { posixQuote } from "../../terminal/shell";
import { render as renderEndpoint } from "../endpoint";
import { CLIENT_NAME } from "./events";
import {
  INJECTED_AGENTS,
  artifactFiles,
  artifactLayout,
  injectionFromLayout,
} from "./inject";
import { launcherFiles } from "./launcher";
import { skillContent } from "./skills";

/**
 * 画布注入的远端那一份：SSH 终端里起的 CLI 读到的插件、扩展、技能、说明与
 * Hook 客户端（docs/design/remote-canvas-injection.md）。
 *
 * 本机那份在 `<数据目录>/integration/<cli>/`（`inject.ts`），路径是控制端这台
 * 机器的；SSH 终端里的 CLI 跑在执行主机上，那些路径在那边不存在。这里按同一套
 * `artifactFiles` 生成同样的产物，只是根换成执行主机上 Worker 答的目录
 * （`<Worker 状态目录>/integration/<版本>/`），路径一律 POSIX，Hook 客户端换成
 * 同步过去的 `armadra-hook.js` 与一个用远端 node 跑它的启动器。
 *
 * 启动行不带任何注入的词：远端每个 CLI 有一个启动器（`run/<cli>`）与一个同名的
 * 垫片（`shims/<cli>`），与本机同一个生成器（`launcher.ts`，
 * docs/design/canvas-launcher.md §6.2）。画布终端的 `PATH` 把垫片目录放在最
 * 前面，垫片从 `PATH` 里去掉自己再委托给启动器；启动器看到 `ARMADRA_NODE_ID`
 * 才在参数后面接上注入的 argv、给 CLI 设注入的变量。于是页面、依赖编排、节能唤醒
 * 拼的都是一行 `claude …`，与远端家目录在哪、同步有没有成功都无关——同步失败时
 * 没有垫片，CLI 照常不带注入启动。Codex 的 Hook 信任靠启动器带的
 * `--dangerously-bypass-hook-trust`，执行主机上也不写 `~/.codex/config.toml`。
 *
 * 纯函数：只根据 Worker 答的位置与控制端这份 Hook 客户端生成文件，不碰磁盘。
 */

/** Worker 为画布注入答的位置（`integration.locate`）。 */
export interface RemoteIntegrationSite {
  /** 注入产物的根目录，绝对 POSIX 路径。 */
  readonly root: string;
  /** Worker 自己跑在的那个 node：远端一定有它。 */
  readonly node: string;
  /** Worker 为这个控制端开的 Hook 中继 socket。 */
  readonly socket: string;
  /** 这个控制端的端点文件。 */
  readonly endpointFile: string;
  /** 节点令牌目录。 */
  readonly tokenDir: string;
}

/** 一个要落在执行主机上的文件。 */
export interface RemoteFile {
  /** 绝对 POSIX 路径，都在 {@link RemoteIntegrationSite.root} 之下。 */
  readonly path: string;
  readonly content: string;
  readonly mode: number;
  readonly sha256: string;
}

/**
 * 端点文件里的令牌。远端不拿控制端 Hook 服务的应用令牌：中继在控制端转发时
 * 换上真的（`remote/integration.ts`），执行主机上只剩这个占位，泄露了也调不动
 * 控制端任何东西——能连上中继 socket 的本来就只有 Worker 所属的那个用户。
 */
export const RELAY_TOKEN = "relay";

/** 垫片所在的目录。 */
export function shimDirectory(root: string): string {
  return posix.join(root, "shims");
}

/** 远端 Hook 客户端的启动器路径。 */
export function remoteClientBin(root: string): string {
  return posix.join(root, "bin", CLIENT_NAME);
}

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function file(path: string, content: string, mode = 0o644): RemoteFile {
  return { path, content, mode, sha256: digest(content) };
}

/**
 * 远端的启动器：用 Worker 那个 node 跑同步过去的包。不设
 * `ELECTRON_RUN_AS_NODE`——远端没有 Electron，跑的就是 node。
 */
function launcher(node: string, bundle: string): string {
  return [
    "#!/bin/sh",
    "# Armadra Hook 客户端（执行主机）。由控制端生成，改动会被覆盖。",
    `exec ${posixQuote(node)} ${posixQuote(bundle)} "$@"`,
    "",
  ].join("\n");
}

/** 启动器所在的目录。 */
export function runDirectory(root: string): string {
  return posix.join(root, "run");
}

/**
 * 执行主机上画布注入的全部文件：每个 CLI 的产物、垫片、Hook 客户端与它的启动器、
 * 这个控制端的端点文件。确定性的：同一份输入生成同样的字节，Worker 按哈希只写
 * 变了的。
 */
export function remoteIntegrationFiles(
  site: RemoteIntegrationSite,
  hookBundle: string,
): RemoteFile[] {
  const files: RemoteFile[] = [];
  const bundlePath = posix.join(site.root, "cli", `${CLIENT_NAME}.js`);
  const clientBin = remoteClientBin(site.root);
  files.push(file(bundlePath, hookBundle));
  files.push(file(clientBin, launcher(site.node, bundlePath), 0o755));
  files.push(
    file(
      site.endpointFile,
      renderEndpoint({
        socket: site.socket,
        token: RELAY_TOKEN,
        nodeTokenDir: site.tokenDir,
      }),
      0o600,
    ),
  );
  const shims = shimDirectory(site.root);
  const run = runDirectory(site.root);
  const target = { join: posix.join, windows: false };
  for (const agentId of INJECTED_AGENTS) {
    // ama on an execution host is not supported in this version: its key
    // file is never synced (docs/design/coordinator-agent.md §7).
    if (agentId === "ama") continue;
    const written = artifactFiles(site.root, agentId, clientBin, target);
    for (const [path, content] of written) files.push(file(path, content));
    const layout = artifactLayout(site.root, agentId, posix.join);
    const present = (path: string | undefined): path is string =>
      path !== undefined && written.has(path);
    const injection = injectionFromLayout(agentId, layout, clientBin, present);
    if (injection === undefined) continue;
    const executables = launcherFiles(
      {
        agentId,
        runDir: run,
        shimDir: shims,
        args: injection.args,
        env: injection.env,
      },
      posix.join,
    );
    for (const [path, entry] of executables) {
      files.push(file(path, entry.content, entry.mode));
    }
  }
  return files;
}

/** 这份注入的指纹：文件列表与每个文件的哈希。控制端据此判断要不要再同步。 */
export function fingerprint(files: readonly RemoteFile[]): string {
  const hash = createHash("sha256");
  for (const entry of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${entry.path}\0${entry.mode}\0${entry.sha256}\n`);
  }
  return hash.digest("hex");
}

/** 技能正文还没登记时（协作域没装配）远端也不注入：只有 Hook 没有规则没有意义。 */
export function remoteInjectionReady(): boolean {
  return skillContent() !== undefined;
}
