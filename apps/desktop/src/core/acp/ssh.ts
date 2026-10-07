/**
 * SSH 节点的 ACP（契约 §26 的 SSH 小节；R-30）。
 *
 * 适配器跑在执行主机上，本机起的是一条不带 TTY 的 `ssh`：
 * `ssh -o … -- 目的主机 env … /bin/sh -c 'cd "$0" || exit 1; exec "$@"' <cwd> <适配器> <参数…>`。
 * 它的 stdin / stdout 就是 ACP 的传输，所以 `host.ts` 的协商、开会话、接回、
 * 模式与模型一行不改，只多一个 transport（{@link AcpTransport}）。
 *
 *   * 主机、密钥、askpass、主机密钥文件与 `ARMADRA_REMOTE_WORKER_LAUNCHER` 是
 *     `remote/` 那一套（`terminal/ssh/argv.ts::streamArgv`）；
 *   * 适配器装没装由那台主机上的 Worker 答（`agents.probe`，能力位复用
 *     `remote.integration.v1`）。主机没登记、没配 Worker、Worker 没有这个动作
 *     （过旧）答 `acp_unsupported`；没装答 `acp_not_installed`；
 *   * 画布工具：`session/new.mcpServers` 带执行主机上同步过去的 Hook 客户端
 *     （`<注入根>/bin/armadra-hook mcp`），端点是 Worker 的中继 socket——与远端
 *     画布注入同一条（`remote/integration.ts::canvas`）。准备不成就不带，会话
 *     照常可用；
 *   * 凭据：远端不兑换（契约 §20）。节点凭据与 ama 模型密钥都不设，也不经远端
 *     命令行传任何值；
 *   * 远端命令里的每个词放在单引号里，值里有 `'`、`\`、`!` 或控制字符时拒绝，
 *     不猜远端登录 shell 是哪一种（与 `remoteShellCommand` 同一条规矩）。
 */

import type { SshHost } from "../settings/ssh-hosts";
import { remoteDomain } from "../remote";
import { executeRemote } from "../remote/execute";
import { streamArgv } from "../terminal/ssh/argv";
import type { AcpAdapter } from "./adapters";
import { AcpError } from "./client";
import {
  type AcpAdapterStart,
  type AcpHostSession,
  type AcpTransport,
  startAdapter,
} from "./host";
import { type AcpStdioMcpServer, CANVAS_MCP_NAME } from "./mcp";

type EnvPairs = readonly (readonly [string, string])[];

/** 起一个远端适配器要用到的 `remote/` 那几样；测试换成替身。 */
export interface AcpSshDeps {
  readonly dataDir: string;
  readonly host: (hostId: string) => SshHost | undefined;
  /** 替换 `ssh` 的 argv[0]（`ARMADRA_REMOTE_WORKER_LAUNCHER`）。 */
  readonly launcher?: string | undefined;
  readonly askpass?: {
    start(): Promise<void>;
    childEnvironment(hostId: string): EnvPairs | undefined;
  };
  /** 在主机的 Worker 上执行 `agents.probe`。 */
  readonly probe: (
    hostId: string,
    programs: readonly string[],
  ) => Promise<unknown>;
  /** 执行主机上的 Hook 客户端与它的环境；准备不成答 `undefined`。 */
  readonly canvas?: (
    hostId: string,
    env: EnvPairs,
  ) => Promise<{ readonly client: string; readonly env: EnvPairs } | undefined>;
}

let override: AcpSshDeps | undefined;

/** 测试用：换掉装配好的远端域。答之前那一个。 */
export function setAcpSshDeps(
  next: AcpSshDeps | undefined,
): AcpSshDeps | undefined {
  const previous = override;
  override = next;
  return previous;
}

function assembled(dataDir: string): AcpSshDeps | undefined {
  if (override !== undefined) return override;
  const remote = remoteDomain();
  if (remote === undefined) return undefined;
  return {
    dataDir,
    host: remote.host,
    launcher: remote.launcher,
    askpass: remote.askpass,
    probe: async (hostId, programs) =>
      await executeRemote(hostId, "agents.probe", "/", { programs }),
    canvas: async (hostId, env) => await remote.integration.canvas(hostId, env),
  };
}

/** 节点数据里的 `ssh.hostId`；不是 SSH 节点答 `undefined`。 */
export function sshHostOf(
  data: Record<string, unknown> | undefined,
): string | undefined {
  const ssh = data?.ssh;
  if (ssh === null || typeof ssh !== "object") return undefined;
  const hostId = (ssh as { hostId?: unknown }).hostId;
  return typeof hostId === "string" && hostId !== "" ? hostId : undefined;
}

/* ------------------------------- 远端命令 ------------------------------- */

/** 单引号里对 sh、fish、csh 都是字面量的值。 */
const LITERAL = /^[^'\\!\u0000-\u001f\u007f]*$/u;

function quoted(value: string, what: string): string {
  if (!LITERAL.test(value)) {
    throw new AcpError(
      "acp_spawn_failed",
      `${what} cannot be passed to the remote shell`,
    );
  }
  return `'${value}'`;
}

/**
 * 交给远端登录 shell 的那一行：设环境、进工作目录（进不去就失败，不在家目录
 * 里悄悄起）、`exec` 适配器。
 */
export function remoteAcpCommand(
  cwd: string,
  program: string,
  args: readonly string[],
  env: EnvPairs = [],
): string {
  const words = ["env"];
  for (const [key, value] of env) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new AcpError(
        "acp_spawn_failed",
        `${key} cannot be passed to the remote shell`,
      );
    }
    words.push(`${key}=${quoted(value, key)}`);
  }
  words.push(
    "/bin/sh",
    "-c",
    `'cd "$0" || exit 1; exec "$@"'`,
    quoted(cwd, "The working directory"),
    quoted(program, "The adapter program"),
    ...args.map((arg) => quoted(arg, "An adapter argument")),
  );
  return words.join(" ");
}

/* --------------------------------- 起会话 --------------------------------- */

export interface AcpSshStart
  extends Omit<
    AcpAdapterStart,
    | "transport"
    | "mcpServers"
    | "canvasMcp"
    | "profilePath"
    | "injectionArgs"
    | "env"
  > {
  readonly hostId: string;
  /** 本机的数据目录：`ssh` 子进程的起点与主机密钥文件的位置。 */
  readonly dataDir: string;
  /** 设给远端适配器的变量（`custom:` 条目的 `env`）。 */
  readonly remoteEnv?: EnvPairs;
  /**
   * 节点会话的环境（节点身份、会话代次）：有就为画布工具准备执行主机上的
   * Hook 客户端。
   */
  readonly nodeEnv?: EnvPairs;
}

/** 不随画布工具到远端的变量：凭据条目名在远端不兑换（契约 §20）。 */
const NOT_FOR_MCP = new Set(["ARMADRA_CREDENTIAL_REF"]);

function statusOf(failure: unknown): number | undefined {
  const status = (failure as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/** 执行主机上装没装这个程序（`agents.probe`）。 */
async function probeProgram(
  deps: AcpSshDeps,
  host: SshHost,
  program: string,
): Promise<void> {
  let answer: unknown;
  try {
    answer = await deps.probe(host.id, [program]);
  } catch (failure) {
    if (statusOf(failure) === 501) {
      throw new AcpError(
        "acp_unsupported",
        `The Worker on ${host.name} is too old to run ACP agents`,
      );
    }
    throw new AcpError(
      "acp_spawn_failed",
      `Could not reach the Worker on ${host.name}: ${messageOf(failure)}`,
    );
  }
  const probe = (answer ?? {}) as {
    platform?: unknown;
    programs?: Record<string, unknown>;
  };
  if (probe.platform === "win32") {
    throw new AcpError("acp_unsupported", `${host.name} is not a POSIX host`);
  }
  const found = probe.programs?.[program];
  if (typeof found !== "string" || found === "") {
    throw new AcpError(
      "acp_not_installed",
      `${program} is not installed on ${host.name}`,
    );
  }
}

/** 画布那条 MCP 服务器（执行主机上的 Hook 客户端）；准备不成答空。 */
async function remoteCanvas(
  deps: AcpSshDeps,
  adapter: AcpAdapter,
  hostId: string,
  nodeEnv: EnvPairs | undefined,
): Promise<AcpStdioMcpServer[]> {
  if (!adapter.injection.mcp || nodeEnv === undefined) return [];
  if (deps.canvas === undefined) return [];
  const prepared = await deps
    .canvas(
      hostId,
      nodeEnv.filter(([name]) => !NOT_FOR_MCP.has(name)),
    )
    .catch(() => undefined);
  if (prepared === undefined) return [];
  return [
    {
      name: CANVAS_MCP_NAME,
      command: prepared.client,
      args: ["mcp"],
      env: prepared.env
        .filter(([name]) => !NOT_FOR_MCP.has(name))
        .map(([name, value]) => ({ name, value })),
    },
  ];
}

/**
 * 在 SSH 节点的执行主机上起适配器并开好会话。失败一律是 {@link AcpError}，
 * 路由原样答出（契约 §14.1 的码）。
 */
export async function startRemoteAdapter(
  adapter: AcpAdapter,
  options: AcpSshStart,
  deps: AcpSshDeps | undefined = assembled(options.dataDir),
): Promise<AcpHostSession> {
  if (deps === undefined) {
    throw new AcpError(
      "acp_unsupported",
      "Remote execution is not assembled in this core",
    );
  }
  const host = deps.host(options.hostId);
  if (host === undefined) {
    throw new AcpError(
      "acp_unsupported",
      `Execution host ${options.hostId} is not registered`,
    );
  }
  if (host.worker === undefined) {
    throw new AcpError(
      "acp_unsupported",
      `Execution host ${host.name} has no Worker configured`,
    );
  }
  // askpass 的 socket 要在 `ssh` 子进程被告知用它之前就在。
  await deps.askpass?.start();
  await probeProgram(deps, host, adapter.program);
  const mcpServers = await remoteCanvas(
    deps,
    adapter,
    host.id,
    options.nodeEnv,
  );
  const askpass = deps.askpass?.childEnvironment(host.id) ?? [];
  const remoteEnv = options.remoteEnv ?? [];
  const transport: AcpTransport = (command) => {
    const argv = streamArgv(
      options.dataDir,
      host,
      remoteAcpCommand(options.cwd, command.program, command.args, remoteEnv),
    );
    const ssh = argv.shift() as string;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [name, value] of askpass) env[name] = value;
    return {
      program: deps.launcher ?? ssh,
      args: argv,
      // 远端的工作目录在本机未必存在：本机子进程从数据目录起。
      cwd: options.dataDir,
      env,
    };
  };
  const {
    hostId: _hostId,
    dataDir: _dataDir,
    remoteEnv: _remoteEnv,
    nodeEnv: _nodeEnv,
    ...rest
  } = options;
  return await startAdapter(adapter, {
    ...rest,
    env: process.env,
    transport,
    mcpServers,
  });
}
