/**
 * "Does this machine have a Node the remote core can run on?"
 *
 * This is the one place the TypeScript port is **less capable than the Rust
 * Runtime**, and the design says so in as many words (§9, 「远端执行需要目标机
 * 有 Node」): the Rust Worker is a static binary that runs on a bare machine,
 * and the TypeScript Worker is `out/core/main.js`, which is not.
 *
 * The decided behaviour is not a fallback. A host with no Node reports
 * `unsupported` with the version it would need, and a workspace on it refuses
 * to execute. The outcome that must never happen is the quiet one — a
 * "remote" workspace whose files are read on this machine — because that is a
 * data operation wearing a preference's clothes.
 */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import type { SshHost } from "../settings/ssh-hosts";
import { nodeProbeArgv } from "../terminal/ssh/argv";
import { redactSecrets, tail } from "../terminal/ssh/redact";
import { runCommand } from "../terminal/ssh/run";

/**
 * The lowest Node the remote core is known to run on.
 *
 * It is the `engines.node` floor of `@armadra/desktop` rather than a number
 * chosen here: the thing being shipped to the far side is this build's own
 * bundle, so the requirement is this build's own requirement.
 */
export const MINIMUM_NODE_MAJOR = 22;

/** How long the far side gets to answer. The probe line is `ssh -o ConnectTimeout=5`. */
const PROBE_TIMEOUT_MS = 20_000;

export interface NodeProbe {
  /** `v22.11.0`, exactly as `node --version` printed it. Absent when missing. */
  readonly version?: string;
  readonly major?: number;
  /** The far side has a Node this build can run on. */
  readonly usable: boolean;
  /** A stable key: `missing`, `tooOld`, `unreachable`. Absent when usable. */
  readonly reason?: "missing" | "tooOld" | "unreachable";
  /** Redacted diagnostics, for the settings page. Empty when everything worked. */
  readonly detail: string;
}

/** `v22.11.0` → 22. Anything that is not that shape has no major. */
export function parseNodeVersion(output: string): number | undefined {
  const match = /^v(\d+)\./mu.exec(output.trim());
  if (match?.[1] === undefined) return undefined;
  const major = Number.parseInt(match[1], 10);
  return Number.isNaN(major) ? undefined : major;
}

/** Turn one probe's raw output into the verdict, without running anything. */
export function readNodeProbe(
  exitCode: number | undefined,
  stdout: string,
  stderr: string,
): NodeProbe {
  const major = parseNodeVersion(stdout);
  if (exitCode !== 0 || major === undefined) {
    // The `command -v node` guard means a zero exit with no version is still a
    // host without Node; a non-zero exit with no diagnostics is the same thing
    // reported differently by a different login shell.
    const detail = redactSecrets(tail(stderr === "" ? stdout : stderr));
    return {
      usable: false,
      reason: exitCode === undefined ? "unreachable" : "missing",
      detail,
    };
  }
  const version = stdout.trim().split(/\s+/u)[0] ?? "";
  if (major < MINIMUM_NODE_MAJOR) {
    return {
      version,
      major,
      usable: false,
      reason: "tooOld",
      detail: `Node ${version}; the remote Armadra core needs ${MINIMUM_NODE_MAJOR} or newer`,
    };
  }
  return { version, major, usable: true, detail: "" };
}

/** Ask the host. */
export async function probeNode(
  dataDir: string,
  host: SshHost,
  launcher?: string,
): Promise<NodeProbe> {
  const argv = nodeProbeArgv(dataDir, host);
  // The same substitution every other `ssh` of this domain takes: a person
  // who reaches the host through a wrapper would otherwise be told it has no
  // Node by a probe that never used the wrapper.
  const program = launcher ?? (argv[0] as string);
  argv.shift();
  const output = await runCommand(program, argv, {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (output.spawnError !== undefined || output.timedOut) {
    return {
      usable: false,
      reason: "unreachable",
      detail: output.timedOut
        ? "The Node probe timed out"
        : `ssh could not be started: ${output.spawnError ?? ""}`,
    };
  }
  return readNodeProbe(output.code, output.stdout, output.stderr);
}

/**
 * The message a person is shown when the host cannot run a remote Worker.
 *
 * It names the requirement rather than the symptom, because "unsupported" on
 * its own is not something anybody can act on.
 */
export function unsupportedMessage(host: SshHost, probe: NodeProbe): string {
  if (probe.reason === "tooOld") {
    return `执行主机 ${host.name} 上的 Node 是 ${probe.version ?? "未知版本"}，远端 Armadra core 需要 ${MINIMUM_NODE_MAJOR} 或更新`;
  }
  if (probe.reason === "unreachable") {
    return `无法在执行主机 ${host.name} 上探测 Node：${probe.detail}`;
  }
  return `执行主机 ${host.name} 上没有 Node。这个构建的远端 Worker 是一份 JavaScript 包，需要目标机自带 Node ${MINIMUM_NODE_MAJOR} 或更新`;
}

/* ------------------------------ agents.probe ------------------------------ */

/** 一次最多问这么多个程序。 */
const MAX_PROGRAMS = 32;

/**
 * 能问的程序：裸程序名，或一个绝对路径（`custom:` 条目的启动程序）。别的
 * （相对路径、带控制字符）不问，答 `null`。
 */
const PROGRAM_NAME = /^[A-Za-z0-9._@+-]{1,128}$/u;

export interface AgentsProbe {
  /** Worker 这台机器的 `process.platform`。 */
  readonly platform: string;
  /** 程序 → 在这台机器的 `PATH` 上找到的路径；没有为 `null`。 */
  readonly programs: Readonly<Record<string, string | null>>;
}

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `agents.probe`（Worker 侧，契约 §26 的 SSH 小节）：执行主机上装没装这些
 * 程序。按 Worker 自己的 `PATH` 找——Worker 与 SSH 节点的 ACP 适配器都由同一种
 * 非交互 `ssh` 起，看到的是同一个环境。只读、不起任何进程。
 */
export function probeAgents(
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): AgentsProbe {
  const requested = Array.isArray(args.programs)
    ? args.programs.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const directories = (env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry !== "" && isAbsolute(entry));
  const programs: Record<string, string | null> = {};
  for (const program of requested.slice(0, MAX_PROGRAMS)) {
    if (isAbsolute(program)) {
      programs[program] =
        !/[\u0000-\u001f\u007f]/u.test(program) && executable(program)
          ? program
          : null;
      continue;
    }
    if (!PROGRAM_NAME.test(program)) {
      programs[program] = null;
      continue;
    }
    programs[program] =
      directories
        .map((directory) => join(directory, program))
        .find((candidate) => executable(candidate)) ?? null;
  }
  return { platform: process.platform, programs };
}
