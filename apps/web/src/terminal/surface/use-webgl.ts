import * as React from "react";

import type { TerminalRenderer } from "@/app/preferences/terminal";
import { useCanvasStore } from "@/store/canvas-store";
import { loseWebglContexts } from "../render-budget";
import { isLowZoom, wantsWebgl } from "../renderer-policy";
import type { SurfaceRefs } from "./refs";

/**
 * WebGL addon 的挂与卸（性能设计 §2.5 B1，从 `TerminalSurface` 搬出）。
 *
 * §18.2 规则 5：默认 DOM 渲染器（画布 CSS 缩放下文字始终清晰）。`webgl` 与
 * `auto` 档按需异步装；丢上下文就卸掉退回 DOM，不重建终端。
 *
 * addon 的挂载条件是**渲染名额**（设计 §7.1），不是 `active`：WebGL 上下文是
 * 设备级的稀缺资源，浏览器给的数量有限，超了之后它会强制驱逐一个——表现是
 * 某个终端毫无征兆地黑屏或画成 "lost context" 占位。名额由模块级协调器统一
 * 发（`render-budget.ts`），`auto` 只是把上限压低（`renderer-policy.ts`）。
 * 丢名额不动 `Terminal` 实例；实例只在生命周期走到 `released` 时整块销毁
 * （`use-lifecycle.ts`），PTY 不受影响。
 *
 * 丢上下文（休眠唤醒、GPU 进程重启）时除了卸 addon，还要**上报**：可见性一点
 * 没变，没有这一声协调器不会知道，终端就无限期停在 DOM 渲染器上。
 *
 * 返回 addon 此刻是否真的装着（`data-renderer` 诊断属性用）。
 */
export function useWebglRenderer(
  refs: SurfaceRefs,
  options: {
    mounted: boolean;
    generation: number;
    renderer: TerminalRenderer;
    budgeted: boolean;
    reportContextLoss: () => void;
  },
): boolean {
  const { mounted, generation, renderer, budgeted, reportContextLoss } =
    options;
  const wanted = wantsWebgl(renderer, budgeted);
  const [loaded, setLoaded] = React.useState(false);
  // 上报走 ref：回调换了引用不该把 addon 拆掉重装。
  const lossRef = React.useRef(reportContextLoss);
  lossRef.current = reportContextLoss;

  React.useEffect(() => {
    const terminal = refs.terminalRef.current;
    if (!terminal || !mounted || !wanted) return;
    let addon: { dispose: () => void } | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        if (cancelled) return;
        const instance = new WebglAddon();
        instance.onContextLoss(() => {
          instance.dispose();
          if (addon === instance) addon = null;
          setLoaded(false);
          lossRef.current();
        });
        terminal.loadAddon(instance);
        addon = instance;
        setLoaded(true);
      } catch {
        // WebGL 不可用（软件渲染、驱动黑名单）：留在 DOM 渲染器上。
      }
    })();
    return () => {
      cancelled = true;
      setLoaded(false);
      if (!addon) return;
      // canvas 必须在 dispose **之前**抓：dispose 会把它们从 DOM 上摘掉。
      const canvases = refs.containerRef.current?.querySelectorAll("canvas");
      const held = canvases ? Array.from(canvases) : [];
      // 这一句就是「字距散开」的源头：它跑在 cleanup 里，元素已被 React 摘掉，
      // 新的 DOM 渲染器按 0 宽推字距。治它的门在 `useRefit`（`dom-spacing.ts`）。
      addon.dispose();
      // dispose 既不 GC 也不弄丢上下文，不补这一刀就会留下占着名额的僵尸。
      loseWebglContexts(held);
    };
    // `generation`：显示层重建后要给新实例重新装 addon。
  }, [refs, mounted, generation, wanted]);

  return loaded && wanted;
}

/**
 * 画布缩放是否低于限帧阈值。开关关着时**不订阅**画布 store——几十个终端各挂
 * 一个选择器，每次画布变动都要跑一遍，白付。值是布尔，跨过阈值才重渲染；
 * 视口由 `useViewportSync` 节流 300 ms 写回画布 store。
 */
export function useLowZoom(enabled: boolean): boolean {
  const subscribe = React.useCallback(
    (notify: () => void) =>
      enabled ? useCanvasStore.subscribe(notify) : () => undefined,
    [enabled],
  );
  const read = () =>
    enabled &&
    isLowZoom(useCanvasStore.getState().document?.board.viewport?.zoom);
  return React.useSyncExternalStore(subscribe, read, read);
}
