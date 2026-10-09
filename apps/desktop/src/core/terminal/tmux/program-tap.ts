import { execFile } from "node:child_process";
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { hardenDirectory } from "../../paths";
import type { TmuxControl } from "./control";

const run = promisify(execFile);

/**
 * 从 tmux 的 pane 里读程序原始输出（契约 §53）。
 *
 * tmux 是一个终端模拟器：它认不得的 OSC（7501、9;4）就地吞掉，不会转给挂上
 * 来的客户端，而且没有客户端挂着的时候 core 根本读不到 pane。`pipe-pane -O`
 * 把 pane 收到的字节原样再抄一份给一条命令，这里让它 `cat` 进数据目录里的
 * 一个 FIFO，core 用非阻塞的管道句柄读——不占 libuv 线程池，也不落盘。
 *
 * 只动我们自己的 tmux 服务器（`-S <数据目录>/tmux.sock`），不碰用户的
 * `~/.tmux.conf`。每个会话多一个 `cat` 进程（约 1 MB 常驻）。
 *
 * 生命周期：
 *
 * - core 退出：我们这端的句柄随进程关闭，`cat` 下一次写就收到 EPIPE 退出，
 *   pipe-pane 随之结束。
 * - core 重启后 adopt：删掉旧 FIFO 再建新的，`pipe-pane`（不带 `-o`）顶掉
 *   旧管道。
 * - pane 结束：tmux 关掉管道，`cat` 退出；这一端由 {@link prune} 在下一次
 *   `list` 时收走。
 */
export class TmuxProgramTap {
  private readonly directory: string;
  private readonly control: TmuxControl;
  private readonly deliver: (name: string, chunk: Buffer) => void;
  private readonly open = new Map<string, Socket>();

  constructor(options: {
    readonly directory: string;
    readonly control: TmuxControl;
    readonly deliver: (name: string, chunk: Buffer) => void;
  }) {
    this.directory = options.directory;
    this.control = options.control;
    this.deliver = options.deliver;
    // 上一个 core 留下的 FIFO 没有读者了；它们的 `cat` 写一次就会退出。
    try {
      for (const entry of readdirSync(this.directory)) {
        if (entry.endsWith(".fifo"))
          rmSync(join(this.directory, entry), { force: true });
      }
    } catch {
      // 目录还不存在是第一次运行。
    }
  }

  /** 开始抄 `name` 这个 pane。失败只记不抛：状态通道是锦上添花。 */
  async start(name: string): Promise<void> {
    if (process.platform === "win32") return;
    this.stop(name);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    hardenDirectory(this.directory);
    const fifo = join(this.directory, `${name}.fifo`);
    rmSync(fifo, { force: true });
    await run("mkfifo", ["-m", "600", fifo]);
    // 读写打开：没有写者时不会读到 EOF，也不会在 open 上阻塞。
    const fd = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
    let socket: Socket;
    try {
      socket = new Socket({ fd, readable: true, writable: false });
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    // 不为它撑着事件循环：退出时句柄随进程关掉，正是 `cat` 收到 EPIPE 的方式。
    socket.unref();
    socket.on("data", (chunk: Buffer) => this.deliver(name, chunk));
    socket.on("error", () => this.stop(name));
    this.open.set(name, socket);
    await this.control.run([
      "pipe-pane",
      "-O",
      "-t",
      name,
      `exec cat > ${shellQuote(fifo)}`,
    ]);
  }

  stop(name: string): void {
    const socket = this.open.get(name);
    if (socket === undefined) return;
    this.open.delete(name);
    socket.destroy();
    rmSync(join(this.directory, `${name}.fifo`), { force: true });
  }

  /** 收走 tmux 已经不认识的会话的那一端。 */
  prune(alive: ReadonlySet<string>): void {
    for (const name of [...this.open.keys()]) {
      if (!alive.has(name)) this.stop(name);
    }
  }

  stopAll(): void {
    for (const name of [...this.open.keys()]) this.stop(name);
  }

  /** 测试用：哪些 pane 正在被抄。 */
  names(): string[] {
    return [...this.open.keys()];
  }
}

/** POSIX sh 的单引号转义：`'` 写成 `'\''`。 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
