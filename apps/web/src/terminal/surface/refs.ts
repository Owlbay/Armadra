import * as React from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { TerminalBackendKind, TerminalNodeData } from "@armadra/shared";

import type { TerminalPreferences } from "@/app/preferences-store";
import { createOffscreenBuffer, type OffscreenBuffer } from "../render-state";
import { TerminalInputLog } from "../input-log";
import type { TerminalTransport } from "../transport";
import type { ConnectionStatus } from "./types";
import { createBackoff, type Backoff } from "@/lib/backoff";

export type LaunchPhase = "idle" | "armed" | "sent";
export type Timer = ReturnType<typeof setTimeout> | null;

/**
 * 表面用到的全部可变引用。
 *
 * 每个 hook 只读它关心的那几条，但它们共享同一份对象：xterm 实例、传输、
 * 启动器计时器与状态镜像都要被好几个 effect 同时看见，而其中任何一条进依赖
 * 数组都会让终端重挂。
 */
export interface SurfaceRefs {
  bodyRef: React.RefObject<HTMLDivElement | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  terminalRef: React.RefObject<Terminal | null>;
  fitRef: React.RefObject<FitAddon | null>;
  searchRef: React.RefObject<SearchAddon | null>;
  transportRef: React.RefObject<TerminalTransport | null>;
  inputLogRef: React.RefObject<TerminalInputLog | null>;
  visibleRef: React.RefObject<boolean>;
  bufferRef: React.RefObject<OffscreenBuffer>;
  writeThroughRef: React.RefObject<boolean>;
  onBellRef: React.RefObject<(() => void) | undefined>;
  onFindRef: React.RefObject<(() => void) | undefined>;
  backendRef: React.RefObject<TerminalBackendKind | null>;
  sessionIdRef: React.RefObject<string | undefined>;
  /** 当前会话跑的 shell（会话记录里的）；启动行按它的方言引用。 */
  shellRef: React.RefObject<string | undefined>;
  fileDropQueue: React.RefObject<Promise<void>>;
  preferencesRef: React.RefObject<TerminalPreferences>;
  dataRef: React.RefObject<TerminalNodeData>;
  freshSessionRef: React.RefObject<boolean>;
  creatingRef: React.RefObject<boolean>;
  launchPhaseRef: React.RefObject<LaunchPhase>;
  launchTimerRef: React.RefObject<Timer>;
  promptTimerRef: React.RefObject<Timer>;
  reconnectTimerRef: React.RefObject<Timer>;
  reconnectBackoffRef: React.RefObject<Backoff>;
  statusRef: React.RefObject<ConnectionStatus>;
  /**
   * 最后一次对齐过的行列数（refit 发出 resize、hello 之后更新）。显示层被
   * 释放后重建时拿它当 `new Terminal` 的初值，首帧不会因为 80×24 的缺省值
   * 多发一次 resize、让 tmux 多重绘一次。
   */
  gridRef: React.RefObject<{ cols: number; rows: number } | null>;
  /** 没有可用传输时排着的输入；传输建好后按序交给它的 pre-hello 队列。 */
  pendingInputRef: React.RefObject<string[]>;
  /** 生命周期的复活入口：输入到一个已断开 / 已释放的终端时先叫醒它。 */
  reviveRef: React.RefObject<(() => void) | null>;
  /** 显示层重建后要对新实例做的事（聚焦、粘贴）。 */
  mountQueueRef: React.RefObject<((terminal: Terminal) => void)[]>;
  /** 正在被 xterm 消化的那一批灌写属于哪个实例；背压用。 */
  flushingRef: React.RefObject<Terminal | null>;
}

/**
 * 建立引用组，并在每次渲染时把随 props / 偏好 / 状态变化的那几条刷新到最新值。
 * 刷新发生在渲染里而不是 effect 里，和拆分之前一样：effect 读到的必须是这一
 * 轮的值，不能晚一帧。
 */
export function useSurfaceRefs(current: {
  data: TerminalNodeData;
  preferences: TerminalPreferences;
  status: ConnectionStatus;
  onBell?: () => void;
  onFind?: () => void;
}): SurfaceRefs {
  const refs = React.useRef<SurfaceRefs | null>(null);
  refs.current ??= {
    bodyRef: React.createRef<HTMLDivElement>(),
    containerRef: React.createRef<HTMLDivElement>(),
    terminalRef: { current: null },
    fitRef: { current: null },
    searchRef: { current: null },
    transportRef: { current: null },
    inputLogRef: { current: new TerminalInputLog() },
    visibleRef: { current: false },
    bufferRef: { current: createOffscreenBuffer() },
    writeThroughRef: { current: false },
    onBellRef: { current: current.onBell },
    onFindRef: { current: current.onFind },
    backendRef: { current: null },
    sessionIdRef: { current: undefined },
    shellRef: { current: undefined },
    fileDropQueue: { current: Promise.resolve() },
    preferencesRef: { current: current.preferences },
    dataRef: { current: current.data },
    freshSessionRef: { current: false },
    creatingRef: { current: false },
    launchPhaseRef: { current: "idle" },
    launchTimerRef: { current: null },
    promptTimerRef: { current: null },
    reconnectTimerRef: { current: null },
    reconnectBackoffRef: {
      current: createBackoff({ baseMs: 1_000, capMs: 10_000 }),
    },
    statusRef: { current: current.status },
    gridRef: { current: null },
    pendingInputRef: { current: [] },
    reviveRef: { current: null },
    mountQueueRef: { current: [] },
    flushingRef: { current: null },
  };
  const bundle = refs.current;
  bundle.onBellRef.current = current.onBell;
  bundle.onFindRef.current = current.onFind;
  bundle.preferencesRef.current = current.preferences;
  bundle.dataRef.current = current.data;
  bundle.statusRef.current = current.status;
  return bundle;
}
