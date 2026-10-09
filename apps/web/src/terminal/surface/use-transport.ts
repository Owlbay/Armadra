import * as React from "react";

import { terminalWebSocketUrl } from "@/api/client";
import { useCanvasStore } from "@/store/canvas-store";
import { bufferOffscreenChunk, drainOffscreenBuffer } from "../render-state";
import { createTerminalTransport } from "../transport";
import { takeWakeWithoutReset } from "./use-hibernation";
import { flushPendingInput } from "./use-handle";
import type { SurfaceRefs } from "./refs";
import type { ConnectionStatus } from "./types";

/**
 * attach 之后要不要补一次 resize：hello 报的是 core 给这一端开的尺寸，本地
 * 容器已经是这个尺寸就不发——多发一次就是让 core 再判一次窗口，最坏会让别的
 * 端整屏重绘（ui-acp-refresh §7.3 E-1）。
 */
export function helloNeedsResize(
  hello: { readonly cols: number; readonly rows: number },
  local: { readonly cols: number; readonly rows: number },
): boolean {
  return hello.cols !== local.cols || hello.rows !== local.rows;
}

/**
 * 传输的生命周期：连接前清屏，`hello` 之后对齐尺寸并决定要不要敲启动行，
 * `stale` / 意外断线按退避重连。节点数据只经 `dataRef` 读最新值，不进依赖数组。
 */
export function useTerminalTransport(
  refs: SurfaceRefs,
  options: {
    nodeId: string;
    sessionId: string | undefined;
    detached: boolean;
    /** 节能休眠：进程不在，连上去只会拿到一个「已退出」。 */
    hibernated: boolean;
    attempt: number;
    /** 显示层代次（`use-lifecycle`）：重建之后要对新实例重新 attach。 */
    generation: number;
    setAttempt: React.Dispatch<React.SetStateAction<number>>;
    patch: (next: Partial<ConnectionStatus>) => void;
    refit: () => void;
    flushOutput: () => void;
    /** 离屏时把灌写排到共享调度器的下一拍。 */
    scheduleFlush: () => void;
    armLaunch: () => void;
    noteOutput: () => void;
    clearLaunchTimers: () => void;
  },
): void {
  const {
    nodeId,
    sessionId,
    detached,
    hibernated,
    attempt,
    generation,
    setAttempt,
    patch,
    refit,
    flushOutput,
    scheduleFlush,
    armLaunch,
    noteOutput,
    clearLaunchTimers,
  } = options;

  React.useEffect(() => {
    if (!sessionId || detached || hibernated) return;
    // 显示层已释放时没有实例：`detached` 一定也为真，上一行已经挡住；
    // 这里再挡一次，防止重建前的那一帧连上一个写不进去的传输。
    const terminal = refs.terminalRef.current;
    if (!terminal) return;

    let disposed = false;
    // 清屏发生在**连接之前**：tmux 后端不发 snapshot，attach 后的第一波重绘
    // （?1049h、鼠标追踪、DA/OSC 查询）必须原样落到一块干净的屏上；
    // 在 hello 之后再清会把这波重绘抹掉。
    // 上一条连接攒下、还没灌完的字节属于被清掉的那块屏，一起丢。
    // 例外：休眠着的 tmux 终端被别的端叫醒，屏上本来就是它休眠前那一屏，
    // tmux 接回来会自己整屏重绘，不清屏也不叠（ui-acp-refresh §7.3 E-4）。
    drainOffscreenBuffer(refs.bufferRef.current);
    if (!takeWakeWithoutReset(refs)) terminal.reset();

    /**
     * 写一段输出。
     *
     * 全速渲染时走原来的直写路径，一个字符都不多绕。离屏时攒起来（设计 §7.1：
     * 「不能因 `display:none` 仍让几十个终端每帧 fit 和重绘」）。缓冲非空时
     * 即使已经回到全速也要先入队再整体灌——PTY 的字节流里半个转义序列都不能
     * 错位，插队会把画面弄坏。
     */
    const writeChunk = (chunk: string) => {
      if (
        refs.writeThroughRef.current &&
        refs.bufferRef.current.chunks.length === 0
      ) {
        terminal.write(chunk);
        return;
      }
      bufferOffscreenChunk(refs.bufferRef.current, chunk);
      if (refs.writeThroughRef.current) flushOutput();
      else scheduleFlush();
    };
    const log = refs.inputLogRef.current!;
    const transport = createTerminalTransport(
      terminalWebSocketUrl(sessionId, log.writerId),
      {
        onHello: (hello) => {
          if (disposed) return;
          // 挂载时按节点数据抢先连上的那一条，碰上的可能是一个休眠的会话：
          // core 答「没在跑」时 `use-session` 已经把表面记成休眠了，这一帧
          // 晚到也不能把它改回「已退出」——那样节点上只剩「重新运行」。
          if (
            !hello.alive &&
            refs.statusRef.current.connection === "hibernated"
          ) {
            return;
          }
          refs.backendRef.current = hello.backend;
          refs.sessionIdRef.current = hello.sessionId;
          refs.reconnectBackoffRef.current.reset();
          patch({
            connection: hello.alive ? "live" : "exited",
            error: null,
            binding: hello.alive
              ? { sessionId: hello.sessionId, generation: hello.generation }
              : null,
          });
          // hello 带着 core 给这一端开的尺寸；本地容器不同才发 resize，
          // 之后 `refit()` 只在真的变了才发（§18.2 规则 2）。`refit()` 刚发过
          // 的同一尺寸 core 当作没变，不会再动窗口。
          refit();
          if (helloNeedsResize(hello, terminal))
            transport.resize(terminal.cols, terminal.rows);
          refs.gridRef.current = { cols: terminal.cols, rows: terminal.rows };

          const store = useCanvasStore.getState();
          const node = store.document?.nodes.find((item) => item.id === nodeId);
          const nodeData =
            node && node.data.kind === "terminal"
              ? node.data
              : refs.dataRef.current;
          // 只有本次挂载新建的会话、带 agent、且 CLI 还没自报 sessionId 时才敲启动行。
          // 待启动节点是例外：它的启动行本来就还没发过，重连之后仍然要接着等
          // 依赖（否则关掉再打开应用，这条绳子就永远悬着了）。
          if (
            hello.alive &&
            (refs.freshSessionRef.current ||
              Boolean(nodeData.agent?.pendingLaunch)) &&
            nodeData.agent &&
            !nodeData.agent.sessionId
          ) {
            armLaunch();
          }
        },
        onSnapshot: (chunk) => {
          if (!disposed) writeChunk(chunk);
        },
        onOutput: (chunk) => {
          if (disposed) return;
          writeChunk(chunk);
          // 启动行的静默判定看的是「后端有没有在输出」，和渲染快慢无关：
          // 离屏的终端一样要在提示符安静下来之后把启动行敲出去。
          noteOutput();
        },
        onStatus: (state, exitCode) => {
          if (disposed) return;
          if (state === "running") {
            patch({ connection: "live", exitCode: null });
            return;
          }
          // 同上：休眠着的会话本来就不在跑，这不是一次退出。
          if (refs.statusRef.current.connection === "hibernated") return;
          patch({
            connection: state === "failed" ? "failed" : "exited",
            exitCode,
            binding: null,
          });
          // 与会话 id 同理（`use-session.ts`）：退出码要存盘，但它是进程报上来
          // 的，不是用户改的，不进撤销栈。
          useCanvasStore
            .getState()
            .updateNodeData(
              nodeId,
              { lastExitCode: exitCode },
              { history: "ignore" },
            );
        },
        onWarning: (message) => {
          if (!disposed) patch({ error: message });
        },
        onStale: () => {
          if (disposed) return;
          patch({ binding: null });
          // 同一个 URL、同一个 session id，只是 generation 变了：
          // 重新走一遍连接分支（它会在连接前清屏）。
          setAttempt((value) => value + 1);
        },
        onClose: () => {
          if (disposed) return;
          const connection = refs.statusRef.current.connection;
          // 进程已退出/失败时的关闭是正常收尾；其余情况（Runtime 重启、网络抖动）
          // 都按意外断线处理：标记 detached 并按退避自动重连，重连会先清屏再 attach。
          if (
            connection === "exited" ||
            connection === "failed" ||
            connection === "hibernated"
          )
            return;
          patch({ connection: "detached", binding: null });
          const delay = refs.reconnectBackoffRef.current.next();
          refs.reconnectTimerRef.current = setTimeout(() => {
            refs.reconnectTimerRef.current = null;
            if (!disposed) setAttempt((value) => value + 1);
          }, delay);
        },
      },
      undefined,
      log,
    );
    refs.transportRef.current = transport;
    patch({ connection: "connecting", binding: null });
    // 断开 / 释放期间排下的输入：进传输的 pre-hello 队列，attach 后按序发出。
    flushPendingInput(refs);

    return () => {
      disposed = true;
      clearLaunchTimers();
      if (refs.reconnectTimerRef.current) {
        clearTimeout(refs.reconnectTimerRef.current);
        refs.reconnectTimerRef.current = null;
      }
      transport.close();
      if (refs.transportRef.current === transport)
        refs.transportRef.current = null;
    };
    // 节点数据只经 `refs.dataRef` 读最新值，不进依赖数组：否则改个标题都要重连
  }, [
    refs,
    nodeId,
    sessionId,
    detached,
    hibernated,
    attempt,
    generation,
    setAttempt,
    patch,
    refit,
    flushOutput,
    scheduleFlush,
    armLaunch,
    noteOutput,
    clearLaunchTimers,
  ]);
}
