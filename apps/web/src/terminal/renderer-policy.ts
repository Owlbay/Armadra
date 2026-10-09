/**
 * 渲染器策略（性能设计 §2.5 B1）：DOM / WebGL / 自动，以及缩小时的限帧重绘。
 *
 * 只有纯函数与常量，没有 React——三个档位各自的规矩要靠单测钉死：
 *
 *  - `dom`：不装 WebGL addon；渲染名额与档位无关，看得见就直写。
 *  - `webgl`：持有名额的装 addon；没抢到名额的可见终端按 `offscreen` 批写
 *    （§2.4 B3 最后一条：名额只约束 WebGL，P3 定下的语义不变）。
 *  - `auto`（实验）：焦点终端 + 至多 `AUTO_WEBGL_SLOTS` 个可见终端用 WebGL，
 *    其余可见终端留在 DOM 渲染器上**照样直写**。名额由同一个协调器发
 *    （`render-budget.ts`），只是上限压到 `AUTO_WEBGL_SLOTS`：焦点不受上限约束，
 *    可见的新来者先拿隐藏持有者让出的名额，全部可见时老住户优先。
 */

import type {
  TerminalRenderer,
  TerminalRepaintThrottle,
} from "@/app/preferences/terminal";

/**
 * `auto` 下同时用 WebGL 的可见终端数（焦点另算）。
 *
 * 忙碌的通常就那几个；Oilpan 堆主要来自持续输出的 DOM 终端（基准 §3.3），
 * 而每多一个 WebGL 上下文 GPU 就多约 11 MiB（20 个 434 vs 212）。4 是设计里
 * 的假设值，对照实验见 `docs/status/completion-progress.md` 的 P4 一节。
 */
export const AUTO_WEBGL_SLOTS = 4;

/** 画布缩放低于它时，`lowZoom` 档对非焦点的可见 DOM 终端限帧。 */
export const LOW_ZOOM_THRESHOLD = 0.5;

/** 限帧时的灌写节奏：100 ms，即 10 fps。 */
export const THROTTLED_REPAINT_MS = 100;

/** 这个档位会不会去装 WebGL addon。 */
export function rendererUsesWebgl(renderer: TerminalRenderer): boolean {
  return renderer !== "dom";
}

/**
 * 渲染名额决不决定档位：只有纯 `webgl` 档是。`auto` 下没名额的可见终端用 DOM
 * 直写，不该被降成离屏批写。
 */
export function rendererGatesRender(renderer: TerminalRenderer): boolean {
  return renderer === "webgl";
}

/** 此刻该不该给这个终端装 WebGL addon。 */
export function wantsWebgl(
  renderer: TerminalRenderer,
  budgeted: boolean,
): boolean {
  return rendererUsesWebgl(renderer) && budgeted;
}

/** 协调器实际用的上限：`auto` 压到 `AUTO_WEBGL_SLOTS`，其余照设置。 */
export function effectiveRenderBudget(
  budget: number,
  renderer: TerminalRenderer,
): number {
  return renderer === "auto" ? Math.min(budget, AUTO_WEBGL_SLOTS) : budget;
}

/** 缩放够不够低，值得限帧。 */
export function isLowZoom(zoom: number | undefined): boolean {
  return typeof zoom === "number" && zoom > 0 && zoom < LOW_ZOOM_THRESHOLD;
}

/**
 * 这一帧的写入要不要合并到 `THROTTLED_REPAINT_MS`（E2）。
 *
 * 只限「看得见、没焦点、用 DOM 渲染器」的终端：焦点终端的输入回显不能慢；
 * WebGL 渲染器本来就按帧画，不做 `replaceChildren`，限它没有收益。
 */
export function repaintThrottled(inputs: {
  throttle: TerminalRepaintThrottle;
  lowZoom: boolean;
  visible: boolean;
  focused: boolean;
  webglActive: boolean;
}): boolean {
  return (
    inputs.throttle === "lowZoom" &&
    inputs.lowZoom &&
    inputs.visible &&
    !inputs.focused &&
    !inputs.webglActive
  );
}
