/**
 * ACP 驱动的终端侧：一个 `TerminalBackend`（ACP 会话视图设计 §4.1、§5.6）。
 *
 * ACP 只是同一个节点的另一种驱动方式，所以它不另养一套会话：`terminal_sessions`
 * 的那一行、代次、人类租约（`POST /api/terminals/{id}/drive`）、输入围栏、退出
 * 通知、Eco 休眠的「结束 → 同一行上起下一代」全是终端管理器的那一份，这里只
 * 把每个原语落到协议上：
 *
 * | 原语                          | ACP                                                       |
 * | ----------------------------- | --------------------------------------------------------- |
 * | `create`                      | 起适配器、`initialize`、`session/new` 或接回（`index.ts`）  |
 * | `input` 括号粘贴 + `\r`        | `session/prompt`（`writeSubmit` 写的就是这个形状；信封原样） |
 * | `input` 单个 `ESC` / `signal` | `session/cancel`                                          |
 * | 其他输入                       | 拒绝 `acp_no_raw_write`——ACP 没有「半截输入」              |
 * | `capture`                     | 镜像尾部渲染成散文                                        |
 * | `getForeground`               | 适配器程序名                                              |
 * | `terminate`                   | 回合里先 cancel，再收掉进程子树                           |
 * | `attach`                      | 409 `acp_session`：没有 PTY 可附着                        |
 *
 * 于是 `send` 的门链、队列、租约、回执，收件箱唤醒，`interrupt` 动词，依赖编排
 * 与调度的投递一行不改：它们写的都是 `TerminalBridge.writeSubmit` / `write`。
 */

import {
  type Attachment,
  type BackendCapabilities,
  type BackendNotice,
  type BackendRef,
  type ForegroundInfo,
  PASTE_END,
  PASTE_START,
  type SessionKey,
  type TerminalBackend,
  TerminalError,
  type TerminalHandle,
  type TerminalSize,
  type TerminalSpec,
  type TerminateMode,
} from "../terminal/backend";
import { AcpError, type AcpExit } from "./client";
import type { AcpSession } from "./session";

const ESCAPE = "\u001b";

/**
 * 起一个会话（`index.ts` 的装配）：答会话、适配器程序，与它驱动的那个 CLI 在
 * 前台门里的名字（`expectedProcesses`）。
 */
export type AcpOpener = (
  spec: TerminalSpec,
  onExit: (exit: AcpExit) => void,
) => Promise<{
  readonly session: AcpSession;
  readonly program: string;
  readonly agentNames: readonly string[];
}>;

interface Entry {
  readonly session: AcpSession;
  readonly program: string;
  readonly agentNames: readonly string[];
  readonly generation: number;
  lastTurn?: string;
}

/** 括号粘贴加回车 → 正文；不是这个形状答 `undefined`。 */
export function submittedText(data: string): string | undefined {
  const tail = `${PASTE_END}\r`;
  if (!data.startsWith(PASTE_START) || !data.endsWith(tail)) return undefined;
  return data.slice(PASTE_START.length, data.length - tail.length);
}

function noRawWrite(): TerminalError {
  return new TerminalError(
    409,
    "acp_no_raw_write",
    "An ACP session takes whole prompts, not keystrokes",
  );
}

export class AcpBackend implements TerminalBackend {
  readonly kind = "acp" as const;
  private readonly entries = new Map<SessionKey, Entry>();
  private readonly listeners: ((notice: BackendNotice) => void)[] = [];

  constructor(private readonly opener: AcpOpener) {}

  getCapabilities(): BackendCapabilities {
    return {
      kind: "acp",
      persistent: false,
      redrawsOnAttach: true,
      usable: true,
    };
  }

  notices(listener: (notice: BackendNotice) => void): void {
    this.listeners.push(listener);
  }

  /** 这个 key（节点）上活着的会话。 */
  session(key: string): AcpSession | undefined {
    return this.entries.get(key as SessionKey)?.session;
  }

  /** 按会话行 id 找。 */
  sessionByRow(rowId: string): AcpSession | undefined {
    for (const entry of this.entries.values()) {
      if (entry.session.rowId === rowId) return entry.session;
    }
    return undefined;
  }

  /** 每个活着的会话。 */
  sessions(): AcpSession[] {
    return [...this.entries.values()].map((entry) => entry.session);
  }

  /** 最近一次经输入路径发出的 prompt 的回合 id。 */
  lastTurn(key: string): string | undefined {
    return this.entries.get(key as SessionKey)?.lastTurn;
  }

  async create(spec: TerminalSpec): Promise<TerminalHandle> {
    const key = spec.sessionKey;
    const generation = spec.generation;
    let opened: Awaited<ReturnType<AcpOpener>>;
    // 退出回调认的是**这一个**会话：切换驱动之后同一个 key 上的新行也从第 1 代
    // 起，只比代次会把新会话当成旧的收掉。
    let mine: AcpSession | undefined;
    try {
      opened = await this.opener(spec, (exit) => {
        const entry = this.entries.get(key);
        if (entry === undefined || mine === undefined || entry.session !== mine)
          return;
        this.entries.delete(key);
        if (exit.requested) return;
        for (const listener of this.listeners) {
          listener({
            type: "exited",
            key,
            generation,
            ...(exit.code === null ? {} : { exitCode: exit.code }),
          });
        }
      });
    } catch (error) {
      if (error instanceof AcpError) {
        throw new TerminalError(
          error.code === "acp_not_installed" ||
          error.code === "acp_unsupported" ||
          error.code === "acp_mode_unsupported"
            ? 400
            : 502,
          error.code,
          error.message,
        );
      }
      throw error;
    }
    mine = opened.session;
    this.entries.set(key, {
      session: opened.session,
      program: opened.program,
      agentNames: opened.agentNames,
      generation,
    });
    return {
      sessionKey: key,
      generation,
      ...(opened.session.pid === undefined ? {} : { pid: opened.session.pid }),
    };
  }

  async list(): Promise<BackendRef[]> {
    return [...this.entries.entries()]
      .filter(([, entry]) => entry.session.alive)
      .map(([key]) => ({ name: key, attached: false }));
  }

  async attach(
    _key: SessionKey,
    _generation: number,
    _size: TerminalSize,
  ): Promise<Attachment> {
    throw new TerminalError(
      409,
      "acp_session",
      "This session is driven over ACP and has no terminal to attach to",
    );
  }

  async detach(_key: SessionKey, _attachmentId: number): Promise<void> {}

  async input(key: SessionKey, bytes: Buffer): Promise<void> {
    const entry = this.require(key);
    const data = bytes.toString("utf8");
    if (data === ESCAPE) {
      await entry.session.cancel();
      return;
    }
    const text = submittedText(data);
    if (text === undefined || text.trim() === "") throw noRawWrite();
    entry.lastTurn = this.promptOn(entry, text);
  }

  async paste(
    key: SessionKey,
    text: string,
    pressEnter: boolean,
  ): Promise<void> {
    const entry = this.require(key);
    if (!pressEnter || text.trim() === "") throw noRawWrite();
    entry.lastTurn = this.promptOn(entry, text);
  }

  async resize(_key: SessionKey, _size: TerminalSize): Promise<void> {}

  async capture(
    key: SessionKey,
    lines: number,
    _withEscapes: boolean,
  ): Promise<string> {
    return this.entries.get(key)?.session.capture(lines) ?? "";
  }

  async signal(key: SessionKey, _signal: "interrupt"): Promise<void> {
    await this.entries.get(key)?.session.cancel();
  }

  async terminate(key: SessionKey, mode: TerminateMode): Promise<void> {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    if (mode === "interrupt") {
      await entry.session.cancel();
      return;
    }
    this.entries.delete(key);
    await entry.session.terminate();
  }

  /**
   * 前台门（`send` / `interrupt` / 调度）问的是「前台还是不是这个 Agent」。
   * ACP 会话里答案按构造就是：core 起的适配器、开好的会话，中间没有可以让
   * 人另开别的程序的 shell。所以前台是适配器程序，它下面是这家 CLI（以前台
   * 门认得的名字列出，ACP 设计 §4.1 的「前台进程门」一行）。
   */
  async getForeground(key: SessionKey): Promise<ForegroundInfo> {
    const entry = this.require(key);
    return {
      ...(entry.session.pid === undefined ? {} : { pid: entry.session.pid }),
      command: entry.program,
      children: [...entry.agentNames],
    };
  }

  async scroll(_key: SessionKey, _lines: number): Promise<void> {}

  async destroyByReference(_reference: string): Promise<void> {}

  async setDormant(_key: SessionKey, _dormant: boolean): Promise<void> {}

  async detachAll(): Promise<void> {
    // 与直连 PTY 同一个道理：活不过 core 的会话，core 收尾时一起结束。
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(
      entries.map((entry) => entry.session.terminate().catch(() => undefined)),
    );
  }

  /** core 进程退出时同步收掉每个适配器的进程组（它们是 detached 起的）。 */
  killAllSync(): void {
    for (const entry of this.entries.values()) {
      const pid = entry.session.pid;
      if (pid === undefined) continue;
      try {
        process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
      } catch {
        // 已经没了。
      }
    }
  }

  private promptOn(entry: Entry, text: string): string {
    try {
      return entry.session.prompt(text);
    } catch (error) {
      if (error instanceof AcpError) {
        throw new TerminalError(409, error.code, error.message);
      }
      throw error;
    }
  }

  private require(key: SessionKey): Entry {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      throw new TerminalError(404, "not_found", "ACP session is not running");
    }
    return entry;
  }
}
