import * as React from "react";

import { sessionGateway } from "@/session";
import { useCanvasStore } from "@/store/canvas-store";
import { pasteIntoTerminal, writeClipboard } from "./clipboard";
import { ensureSearch } from "./search";
import type { SurfaceRefs } from "./refs";
import type { ConnectionStatus, TerminalSurfaceHandle } from "./types";

/** 排队输入的上限（UTF-16 码元）。超出的部分丢弃，不让一个连不上的会话无限攒。 */
export const PENDING_INPUT_LIMIT = 64 * 1024;

/**
 * 把输入交给 PTY。
 *
 * 有可用传输就直接发（传输自己在 hello 之前保序攒着）。没有——终端已断开
 * （离屏省电）或显示层已释放——就先排队并叫醒生命周期：重连之后传输一建好，
 * `flushPendingInput` 按原顺序交给它，一个字节不丢。以前这里是静默丢弃。
 * 休眠着的会话不排：进程不在，唤醒走的是 `use-hibernation` 那条路。
 */
export function deliverInput(refs: SurfaceRefs, data: string): void {
  if (!data) return;
  const transport = refs.transportRef.current;
  if (transport && transport.state !== "closed") {
    transport.input(data);
    return;
  }
  if (refs.statusRef.current.connection === "hibernated") return;
  const queue = refs.pendingInputRef.current;
  const queued = queue.reduce((total, item) => total + item.length, 0);
  if (queued + data.length <= PENDING_INPUT_LIMIT) queue.push(data);
  refs.reviveRef.current?.();
}

/** 传输建好后调用：排着的输入按序交给它。 */
export function flushPendingInput(refs: SurfaceRefs): void {
  const transport = refs.transportRef.current;
  if (!transport) return;
  const queue = refs.pendingInputRef.current;
  while (queue.length > 0) transport.input(queue.shift() as string);
}

/**
 * 对 xterm 实例做一件事；显示层已释放时先叫醒，等重建好再做。
 */
function withTerminal(
  refs: SurfaceRefs,
  action: (
    terminal: NonNullable<SurfaceRefs["terminalRef"]["current"]>,
  ) => void,
): void {
  const terminal = refs.terminalRef.current;
  if (terminal) {
    action(terminal);
    return;
  }
  refs.mountQueueRef.current.push(action);
  refs.reviveRef.current?.();
}

/** 头部按钮、快捷键与移动端工具条通过这个句柄操作终端。 */
export function useSurfaceHandle(
  refs: SurfaceRefs,
  options: {
    ref: React.Ref<TerminalSurfaceHandle> | undefined;
    sessionId: string | undefined;
    ensureSession: (forceNew: boolean) => Promise<void>;
    patch: (next: Partial<ConnectionStatus>) => void;
    setAttempt: React.Dispatch<React.SetStateAction<number>>;
  },
): void {
  const { ref, sessionId, ensureSession, patch, setAttempt } = options;

  React.useImperativeHandle(
    ref,
    () => ({
      find: (query, direction = "next") => {
        if (!query) return;
        // 搜索 addon 到第一次搜索才装（代码分割）；装完立刻执行本次搜索。
        void ensureSearch(refs.terminalRef, refs.searchRef).then((search) => {
          if (!search) return;
          if (direction === "next") search.findNext(query);
          else search.findPrevious(query);
        });
      },
      clearSearch: () => refs.searchRef.current?.clearDecorations(),
      focus: () => withTerminal(refs, (terminal) => terminal.focus()),
      terminate: (mode) => {
        const transport = refs.transportRef.current;
        if (transport) {
          transport.terminate(mode);
          return;
        }
        if (sessionId) {
          // Nothing is attached, so the request goes through the gateway
          // rather than down a socket: ending a session is a lifecycle
          // decision and follows whichever side owns the record.
          void sessionGateway.terminate(
            useCanvasStore.getState().workspace?.id ?? "",
            sessionId,
            mode,
          );
        }
      },
      restart: () => {
        refs.freshSessionRef.current = false;
        refs.launchPhaseRef.current = "idle";
        void ensureSession(true);
      },
      recycle: () => {
        if (!sessionId) return;
        void sessionGateway
          .recycle(useCanvasStore.getState().workspace?.id ?? "", sessionId)
          .then(() => setAttempt((value) => value + 1))
          .catch((cause: unknown) => {
            patch({
              error: cause instanceof Error ? cause.message : String(cause),
            });
          });
      },
      writeLine: (line) => deliverInput(refs, `${line}\r`),
      sendKeys: (data) => {
        if (!data) return;
        deliverInput(refs, data);
        withTerminal(refs, (terminal) => terminal.focus());
      },
      copySelection: () =>
        writeClipboard(refs.terminalRef.current?.getSelection()),
      paste: () =>
        withTerminal(refs, (terminal) => void pasteIntoTerminal(terminal)),
    }),
    [refs, ensureSession, patch, sessionId, setAttempt],
  );
}
