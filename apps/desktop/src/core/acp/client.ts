/**
 * 一个 ACP Agent 进程（ACP 会话视图设计 §5.1、§5.3；补全架构 §5.1 第 1 条）。
 *
 * 协议只包装 `@armadra/agent/acp` 的 `AcpClient`，不自写分帧与 JSON-RPC。这里
 * 只管 `AcpClient` 不管的那一半：
 *
 *   * **起进程**：不经 shell，argv 是数组；unix 上自成进程组（`detached`），
 *     适配器起的子树（SDK 起的 `claude`、`codex app-server`）一次 `kill(-pgid)`
 *     收掉；Windows 上 `taskkill /T`。
 *   * **stderr**：只留 64 KiB 尾巴、脱敏，在内存里，由调用方决定要不要进 debug
 *     日志；从不进镜像、数据库或 API 响应。
 *   * **退出对账**：进程没了 → 挂起的请求以 `connection_closed` 失败、挂起的
 *     审批一律回 `cancelled`，`exited` 带上「是不是我们要它退的」。
 *   * **审批挂起表**：`session/request_permission` 进表、交给 `onPermission`，
 *     由人经 `answerPermission` 答；`cancel(sessionId)`、进程退出时表里该会话的
 *     请求一律回 `cancelled`（规范要求）。只认 Agent 自己给的 `optionId`。
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";

import {
  AcpClient,
  type AcpContentBlock,
  type AcpImplementationInfo,
  type AcpPermissionOption,
  type AcpPermissionOutcome,
  type AcpRequestPermissionParams,
  type AcpRequestPermissionResult,
  type AcpSessionNotification,
  type AcpToolCallUpdate,
} from "@armadra/agent/acp";

import { STDERR_TAIL_BYTES } from "../language/limits";
import { redactSecrets } from "../terminal/ssh/redact";

/** 错误一律 `{ code, message }`（AGENTS.md）。 */
export class AcpError extends Error {
  constructor(
    readonly code: AcpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AcpError";
  }

  toJSON(): { code: AcpErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

export type AcpErrorCode =
  | "acp_spawn_failed"
  | "acp_exited"
  | "acp_initialize_failed"
  | "acp_initialize_timeout"
  | "acp_protocol_version"
  | "acp_auth_required"
  | "acp_session_failed"
  | "acp_mode_unsupported"
  | "acp_mode_unavailable"
  | "acp_not_installed";

/** 一条挂起的 `session/request_permission`。 */
export interface AcpPendingPermission {
  /** 本进程内唯一；审批行（G2-1）以它找回这一条。 */
  readonly id: string;
  readonly sessionId: string;
  readonly toolCall: AcpToolCallUpdate;
  readonly options: readonly AcpPermissionOption[];
  readonly createdAt: number;
}

/** 一条挂起审批是怎么结束的。 */
export type AcpPermissionSettlement =
  | { readonly by: "answer"; readonly outcome: AcpPermissionOutcome }
  /** 回合被取消、连接关闭或进程退出：一律 `cancelled`，没有人答。 */
  | { readonly by: "cancelled"; readonly outcome: { outcome: "cancelled" } };

export interface AcpExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** `terminate()` 要它退的；否则是进程自己没的（崩溃、被外人杀）。 */
  readonly requested: boolean;
}

export interface AcpSpawnOptions {
  /** 要起的程序：解析好的路径（`host.ts` 用 `resolveCommand` 解）。 */
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** 缺省继承 core 的环境。 */
  readonly env?: NodeJS.ProcessEnv;
  readonly clientInfo?: AcpImplementationInfo;
  readonly onUpdate?: (notification: AcpSessionNotification) => void;
  /** 新的一条挂起审批进表。 */
  readonly onPermission?: (pending: AcpPendingPermission) => void;
  readonly onPermissionSettled?: (
    pending: AcpPendingPermission,
    settlement: AcpPermissionSettlement,
  ) => void;
  /** stderr 原始块（已脱敏）；由调用方决定是否进 debug 日志。 */
  readonly onStderr?: (text: string) => void;
  readonly onProtocolError?: (reason: string) => void;
  readonly onExit?: (exit: AcpExit) => void;
}

/** 按 64 KiB 截尾的 stderr；只有末尾有用：起不来的进程在最后几行说原因。 */
class Tail {
  private bytes = Buffer.alloc(0);

  push(chunk: Buffer): void {
    const joined = Buffer.concat([this.bytes, chunk]);
    this.bytes =
      joined.byteLength > STDERR_TAIL_BYTES
        ? Buffer.from(joined.subarray(joined.byteLength - STDERR_TAIL_BYTES))
        : joined;
  }

  text(): string {
    return redactSecrets(this.bytes.toString("utf8"));
  }
}

interface PendingEntry {
  readonly pending: AcpPendingPermission;
  readonly resolve: (result: AcpRequestPermissionResult) => void;
}

/** `terminate()` 先关 stdin 等它自己退的时长（ACP Agent 读到 EOF 应当退出）。 */
const GRACE_MS = 2_000;
/** SIGTERM 之后再等多久才 SIGKILL。 */
const KILL_AFTER_MS = 1_000;
/** `terminate()` 最多等多久的回收：杀不掉的进程不能把收尾挂住。 */
const REAP_TIMEOUT_MS = 5_000;

export class AcpProcess {
  readonly pid: number;
  readonly client: AcpClient;
  /** 进程退出（或起不来）时 resolve，只 resolve 一次。 */
  readonly exited: Promise<AcpExit>;

  private readonly child: ChildProcess;
  private readonly options: AcpSpawnOptions;
  private readonly stderr = new Tail();
  private readonly pending = new Map<string, PendingEntry>();
  private nextPermission = 0;
  private terminating = false;
  private exitInfo: AcpExit | undefined;

  private constructor(child: ChildProcess, options: AcpSpawnOptions) {
    this.child = child;
    this.options = options;
    this.pid = child.pid as number;

    let settle: (exit: AcpExit) => void = () => {};
    this.exited = new Promise((resolve) => {
      settle = resolve;
    });
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.exitInfo !== undefined) return;
      const exit: AcpExit = { code, signal, requested: this.terminating };
      this.exitInfo = exit;
      // 进程没了：挂起的请求失败、挂起的审批回 cancelled（AcpClient 的 onClose
      // 会 abort 它们；这里再关一次，免得 stdout 先于 exit 关闭之外的顺序漏掉）。
      this.client.close();
      this.settleAll();
      settle(exit);
      options.onExit?.(exit);
    };

    if (child.stdin === null || child.stdout === null) {
      throw new AcpError("acp_spawn_failed", "ACP agent has no stdio pipes");
    }
    this.client = new AcpClient({
      input: child.stdout,
      output: child.stdin,
      ...(options.clientInfo === undefined
        ? {}
        : { clientInfo: options.clientInfo }),
      onUpdate: (notification) => options.onUpdate?.(notification),
      onPermission: (params, signal) => this.hold(params, signal),
      onProtocolError: (_line, reason) => options.onProtocolError?.(reason),
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr.push(chunk);
      options.onStderr?.(redactSecrets(chunk.toString("utf8")));
    });
    // 对端退出导致的断管不值得报：exit 事件才是要紧的那个。
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.on("error", () => finish(null, null));
    child.on("exit", (code, signal) => finish(code, signal));
  }

  /**
   * 起进程。起不来（ENOENT、权限）抛 `acp_spawn_failed`：同步的 spawn 异常与
   * 「没拿到 pid」两条路都在这里收口。
   */
  static spawn(options: AcpSpawnOptions): AcpProcess {
    let child: ChildProcess;
    try {
      child = spawn(options.program, [...options.args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      throw new AcpError(
        "acp_spawn_failed",
        `cannot start ${options.program}: ${messageOf(error)}`,
      );
    }
    if (child.pid === undefined) {
      // 异步失败（通常是 ENOENT）会在没人监听的 child 上发 error，那是进程级
      // 的抛出；返回之前先挂上。
      child.on("error", () => {});
      throw new AcpError("acp_spawn_failed", `cannot start ${options.program}`);
    }
    return new AcpProcess(child, options);
  }

  get alive(): boolean {
    return this.exitInfo === undefined;
  }

  /** 退出了就是退出信息，否则 undefined。 */
  get exit(): AcpExit | undefined {
    return this.exitInfo;
  }

  /** 脱敏的 stderr 尾巴（64 KiB）。只给诊断，不进 API 响应。 */
  stderrTail(): string {
    return this.stderr.text();
  }

  /** 挂起表的快照（创建先后为序）。 */
  pendingPermissions(sessionId?: string): AcpPendingPermission[] {
    return [...this.pending.values()]
      .map((entry) => entry.pending)
      .filter(
        (pending) => sessionId === undefined || pending.sessionId === sessionId,
      );
  }

  /**
   * 答一条挂起的审批。`optionId` 必须是 Agent 给的选项之一；`null` = 回
   * `cancelled`。答过、已被取消或不认识的 id 答 `false`。
   */
  answerPermission(id: string, optionId: string | null): boolean {
    const entry = this.pending.get(id);
    if (entry === undefined) return false;
    if (
      optionId !== null &&
      !entry.pending.options.some((option) => option.optionId === optionId)
    ) {
      return false;
    }
    const outcome: AcpPermissionOutcome =
      optionId === null
        ? { outcome: "cancelled" }
        : { outcome: "selected", optionId };
    this.pending.delete(id);
    entry.resolve({ outcome });
    this.options.onPermissionSettled?.(entry.pending, {
      by: "answer",
      outcome,
    });
    return true;
  }

  /**
   * `session/cancel`：发通知，并让该会话挂起的审批一律回 `cancelled`（规范
   * 要求）。进程已退出时什么也不做。
   */
  async cancel(sessionId: string): Promise<void> {
    if (!this.alive) return;
    await this.client.cancel(sessionId);
  }

  prompt(sessionId: string, prompt: AcpContentBlock[], signal?: AbortSignal) {
    return this.client.prompt(sessionId, prompt, signal);
  }

  setMode(sessionId: string, modeId: string) {
    return this.client.setMode(sessionId, modeId);
  }

  /**
   * 结束进程（及其子树）。先关 stdin 给它 {@link GRACE_MS} 自己退——读到 EOF
   * 的 ACP Agent 会写完会话状态再走；不退再 SIGTERM，再 SIGKILL。等到回收或
   * {@link REAP_TIMEOUT_MS} 为止。
   */
  async terminate(): Promise<AcpExit> {
    if (this.exitInfo !== undefined) return this.exitInfo;
    this.terminating = true;
    try {
      this.child.stdin?.end();
    } catch {
      // 已经断了。
    }
    if (await this.waitExit(GRACE_MS)) return this.exited;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(this.pid), "/T", "/F"], {
        windowsHide: true,
      });
    } else {
      killGroup(this.pid, "SIGTERM");
      if (!(await this.waitExit(KILL_AFTER_MS))) {
        killGroup(this.pid, "SIGKILL");
      }
    }
    if (await this.waitExit(REAP_TIMEOUT_MS)) return this.exited;
    return { code: null, signal: "SIGKILL", requested: true };
  }

  private waitExit(ms: number): Promise<boolean> {
    return Promise.race([
      this.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        timer.unref?.();
      }),
    ]);
  }

  /** `AcpClient.onPermission`：进表，等人答或被 abort。 */
  private hold(
    params: AcpRequestPermissionParams,
    signal: AbortSignal,
  ): Promise<AcpRequestPermissionResult> {
    this.nextPermission += 1;
    const pending: AcpPendingPermission = {
      id: `perm-${this.pid}-${this.nextPermission}`,
      sessionId: params.sessionId,
      toolCall: params.toolCall,
      options: [...params.options],
      createdAt: Date.now(),
    };
    return new Promise((resolve) => {
      this.pending.set(pending.id, { pending, resolve });
      const aborted = () => this.drop(pending.id);
      if (signal.aborted) {
        aborted();
        return;
      }
      signal.addEventListener("abort", aborted, { once: true });
      this.options.onPermission?.(pending);
    });
  }

  /** 一条挂起审批被取消（cancel、断开、退出）：回 `cancelled`。 */
  private drop(id: string): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    entry.resolve({ outcome: { outcome: "cancelled" } });
    this.options.onPermissionSettled?.(entry.pending, {
      by: "cancelled",
      outcome: { outcome: "cancelled" },
    });
  }

  private settleAll(): void {
    for (const id of [...this.pending.keys()]) this.drop(id);
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // 已经没了。
    }
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
