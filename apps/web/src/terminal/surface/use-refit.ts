import * as React from "react";

import { shouldRefit } from "../compat";
import { resyncDomRendererSpacing } from "./dom-spacing";
import type { SurfaceRefs } from "./refs";

/**
 * §18.2 规则 2：**唯一**允许调 `fit()` 的地方。
 *
 * 先问 `proposeDimensions()`，只有算出来的整数列/行和当前不一样才动手，
 * 也才发 `resize`。这一条就是「终端一直跳」的解药：`fit()` 会让 tmux
 * 整屏重绘、重绘可能让容器再抖一个亚像素，如果不比较就会无限循环。
 */
export function useRefit(refs: SurfaceRefs): () => void {
  return React.useCallback(() => {
    const terminal = refs.terminalRef.current;
    const fit = refs.fitRef.current;
    if (!terminal || !fit || !refs.visibleRef.current) return;
    /*
     * 字距重算门。丢名额 / 折叠时 `WebglAddon.dispose()` 跑在 cleanup 里，
     * 那会儿元素已经被 React 摘掉，新建的 DOM 渲染器按 `offsetWidth === 0`
     * 推出「一整格」的 `letter-spacing`——就是「字母散开」那一下。这里是它第一
     * 次重新量得出尺寸的时刻。字距已经对得上就完全不碰（见 `dom-spacing.ts`）。
     *
     * 放在 `shouldRefit` 的早退之前：列/行没变也要治，而多数情况下正是没变。
     */
    if (resyncDomRendererSpacing(terminal)) {
      terminal.refresh(0, terminal.rows - 1);
    }
    let proposed: { cols: number; rows: number } | undefined;
    try {
      proposed = fit.proposeDimensions();
    } catch {
      return;
    }
    // 容器量不出尺寸（折叠的 `display:none`、字体还没就绪、显示层刚在离屏
    // 重建）：不 fit、不发 resize。下一次回到全速时 `TerminalSurface` 会补一次。
    if (!measurable(proposed)) return;
    if (!shouldRefit(proposed, { cols: terminal.cols, rows: terminal.rows })) {
      return;
    }
    try {
      fit.fit();
    } catch {
      return;
    }
    refs.gridRef.current = { cols: terminal.cols, rows: terminal.rows };
    refs.transportRef.current?.resize(terminal.cols, terminal.rows);
  }, [refs]);
}

/** `proposeDimensions()` 的结果能不能当真：0×0 容器会给出 `undefined` 或 1 列。 */
export function measurable(
  proposed: { cols: number; rows: number } | undefined,
): proposed is { cols: number; rows: number } {
  if (!proposed) return false;
  if (!Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows))
    return false;
  return proposed.cols >= 2 && proposed.rows >= 1;
}
