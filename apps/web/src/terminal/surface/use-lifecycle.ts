import * as React from "react";

import { useAgentStatusStore } from "@/agent/status-store";
import { useOnScreen, usePageVisible } from "@/panels/resources/use-visibility";
import { scoped } from "@/sources/scope";
import { useCanvasStore } from "@/store/canvas-store";
import { INPUT_TTL_MS } from "../input-log";
import {
  LIFECYCLE_RECHECK_MS,
  canDetach,
  canRelease,
  detachDelay,
  isSeen,
  pressureReleases,
  releaseAfterMs,
  resolveLifecycle,
  type HoldInputs,
  type LifecyclePhase,
  type ReleaseAfter,
} from "../lifecycle";
import { onMemoryPressure } from "../pressure-bus";
import type { SurfaceRefs } from "./refs";

export interface SurfaceLifecycle {
  phase: LifecyclePhase;
  /** 我们主动收了 socket（`detached` 与 `released` 都是）。 */
  detached: boolean;
  /** 显示层在不在：`released` 时为假，`use-xterm` 据此销毁 / 重建实例。 */
  mounted: boolean;
  /** 显示层的代次：每次释放后重建加一，传输与 WebGL effect 以它为依赖。 */
  generation: number;
  onScreen: boolean;
  pageVisible: boolean;
}

interface State {
  detached: boolean;
  released: boolean;
  generation: number;
  /** 每次复活加一，让还看不见时的断开计时从头算。 */
  wake: number;
}

/**
 * 终端前端的分阶段生命周期（性能设计 §2.4）：`live → parked → detached →
 * released`，判定在 `lifecycle.ts`，这里只管计时、订阅内存压力和复活。
 *
 * - 看不见（折叠 / 平移离屏 / 窗口后台）够久就收 socket，再够久（设置项
 *   `releaseAfter`）销毁显示层；内存压力可以提前释放；
 * - 回到可见，或者有输入要发给它（`refs.reviveRef`），就复活：已释放的先
 *   重建显示层，再连传输。
 */
export function useSurfaceLifecycle(
  refs: SurfaceRefs,
  options: { nodeId: string; collapsed: boolean; releaseAfter: ReleaseAfter },
): SurfaceLifecycle {
  const { nodeId, collapsed, releaseAfter } = options;
  const onScreen = useOnScreen(refs.bodyRef);
  const pageVisible = usePageVisible();
  const seen = isSeen({ collapsed, onScreen, pageVisible });

  const [state, setState] = React.useState<State>({
    detached: false,
    released: false,
    generation: 0,
    wake: 0,
  });

  const revive = React.useCallback(() => {
    setState((current) =>
      current.detached || current.released
        ? {
            detached: false,
            released: false,
            generation: current.released
              ? current.generation + 1
              : current.generation,
            wake: current.wake + 1,
          }
        : current,
    );
  }, []);
  refs.reviveRef.current = revive;

  /** 此刻挡着断开 / 释放的那些条件；都在引用或 store 里，读最新值。 */
  const holds = React.useCallback((): HoldInputs => {
    const status = refs.statusRef.current;
    const now = Date.now();
    const log = refs.inputLogRef.current;
    return {
      launchArmed: refs.launchPhaseRef.current === "armed",
      pendingLaunch: Boolean(refs.dataRef.current.agent?.pendingLaunch),
      connecting:
        status.connection === "starting" ||
        status.connection === "connecting" ||
        status.hibernation === "resuming",
      unackedInput:
        refs.pendingInputRef.current.length > 0 ||
        Boolean(
          log?.pending.some((entry) => now - entry.sentAt < INPUT_TTL_MS),
        ),
      focusNode: useCanvasStore.getState().focusNodeId === nodeId,
      blocked:
        useAgentStatusStore.getState().statuses[scoped(nodeId)]?.state ===
        "blocked",
    };
  }, [refs, nodeId]);

  /* 回到可见：复活。 */
  React.useEffect(() => {
    if (seen) revive();
  }, [seen, revive]);

  /* 看不见从什么时候开始（内存压力的告警档按它判）。 */
  const unseenSinceRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (seen) unseenSinceRef.current = null;
    else unseenSinceRef.current ??= Date.now();
  }, [seen]);

  /* 看不见够久：收 socket。豁免命中就过一会儿再看。 */
  React.useEffect(() => {
    if (state.detached) return;
    const delay = detachDelay({ collapsed, onScreen, pageVisible });
    if (delay === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = () => {
      if (!canDetach(holds())) {
        timer = setTimeout(attempt, LIFECYCLE_RECHECK_MS);
        return;
      }
      setState((current) =>
        current.detached ? current : { ...current, detached: true },
      );
    };
    timer = setTimeout(attempt, delay);
    return () => clearTimeout(timer);
  }, [collapsed, onScreen, pageVisible, state.detached, state.wake, holds]);

  /* 断开够久：销毁显示层。 */
  React.useEffect(() => {
    if (!state.detached || state.released) return;
    const delay = releaseAfterMs(releaseAfter);
    if (delay === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = () => {
      if (!canRelease(holds())) {
        timer = setTimeout(attempt, LIFECYCLE_RECHECK_MS);
        return;
      }
      setState((current) =>
        current.released ? current : { ...current, released: true },
      );
    };
    timer = setTimeout(attempt, delay);
    return () => clearTimeout(timer);
  }, [state.detached, state.released, state.wake, releaseAfter, holds]);

  /* 内存压力：看不见的实例提前释放（`never` 时不动）。 */
  const releaseAfterRef = React.useRef(releaseAfter);
  releaseAfterRef.current = releaseAfter;
  React.useEffect(
    () =>
      onMemoryPressure((level) => {
        if (releaseAfterMs(releaseAfterRef.current) === null) return;
        const since = unseenSinceRef.current;
        const unseenFor = since === null ? null : Date.now() - since;
        if (!pressureReleases(level, unseenFor)) return;
        if (!canRelease(holds())) return;
        setState((current) =>
          current.released
            ? current
            : { ...current, detached: true, released: true },
        );
      }),
    [holds],
  );

  React.useEffect(
    () => () => {
      if (refs.reviveRef.current === revive) refs.reviveRef.current = null;
    },
    [refs, revive],
  );

  return {
    phase: resolveLifecycle({
      seen,
      detached: state.detached,
      released: state.released,
    }),
    detached: state.detached || state.released,
    mounted: !state.released,
    generation: state.generation,
    onScreen,
    pageVisible,
  };
}
