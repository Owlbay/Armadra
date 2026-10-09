import {
  DEFAULT_RELEASE_AFTER,
  RELEASE_AFTER_OPTIONS,
  type ReleaseAfter,
} from "@/terminal/lifecycle";
import { readStored, storedBoolean, storedEnum, storedNumber } from "./storage";

const TERM_FONT_FAMILY_KEY = "armadra.terminal.fontFamily";
const TERM_FONT_SIZE_KEY = "armadra.terminal.fontSize";
const TERM_LINE_HEIGHT_KEY = "armadra.terminal.lineHeight";
const TERM_LETTER_SPACING_KEY = "armadra.terminal.letterSpacing";
const TERM_CURSOR_STYLE_KEY = "armadra.terminal.cursorStyle";
const TERM_CURSOR_BLINK_KEY = "armadra.terminal.cursorBlink";
const TERM_OPTION_META_KEY = "armadra.terminal.macOptionIsMeta";
const TERM_COPY_ON_SELECT_KEY = "armadra.terminal.copyOnSelect";
const TERM_RENDERER_KEY = "armadra.terminal.renderer";
const TERM_REPAINT_THROTTLE_KEY = "armadra.terminal.repaintThrottle";
const TERM_RELEASE_AFTER_KEY = "armadra.terminal.releaseAfter";

/* ------------------------------- 终端外观 --------------------------------- */

export const TERMINAL_CURSOR_STYLES = ["block", "bar", "underline"] as const;
export type TerminalCursorStyle = (typeof TERMINAL_CURSOR_STYLES)[number];

/**
 * 渲染器（性能设计 §2.5 B1）。取代旧的布尔 `armadra.terminal.webgl`：旧键不读，
 * 开过 WebGL 的用户重新选一次。`auto` 是实验档，规则见 `terminal/renderer-policy.ts`。
 */
export const TERMINAL_RENDERERS = ["dom", "webgl", "auto"] as const;
export type TerminalRenderer = (typeof TERMINAL_RENDERERS)[number];

/** 缩小时限帧重绘（实验，E2）：`lowZoom` 在缩放 < 0.5 时把非焦点 DOM 终端合并到 10 fps。 */
export const TERMINAL_REPAINT_THROTTLES = ["off", "lowZoom"] as const;
export type TerminalRepaintThrottle =
  (typeof TERMINAL_REPAINT_THROTTLES)[number];

/**
 * 终端外观偏好（计划书 §18.3）。
 *
 * 单独成型是因为 `TerminalSurface` 要把整块当依赖：任何一项变化都要
 * 重设 xterm options 再 fit 一次，而不是每项各挂一个 effect。
 * `fontFamily` 为空表示「跟随 `--font-code`」。
 */
export interface TerminalPreferences {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  /** macOS 上 Option 当 Meta；默认关，否则 ⌥ 组合字符打不出来（§18.3 键盘行）。 */
  macOptionIsMeta: boolean;
  /** 选中即复制。默认关：选错一次就会把剪贴板冲掉。 */
  copyOnSelect: boolean;
  /** 渲染器；默认 DOM，画布缩放下文字更清晰、整机内存更低（§18.2 规则 5）。 */
  renderer: TerminalRenderer;
  /** 缩小时限帧重绘；默认关。 */
  repaintThrottle: TerminalRepaintThrottle;
  /**
   * 离屏多久后释放终端画面（性能设计 §2.4）：只销毁页面里的 xterm 实例，
   * 会话继续运行，回到视口时重新接上。`never` 退回不释放。
   */
  releaseAfter: ReleaseAfter;
}

export const TERMINAL_FONT_SIZE_RANGE = [10, 20] as const;
export const TERMINAL_LINE_HEIGHT_RANGE = [1, 1.6] as const;
export const TERMINAL_LETTER_SPACING_RANGE = [-2, 4] as const;

/**
 * 默认字号与行高（契约 §3.4，2026-09-19：13/1.2 → 12/1.15）。
 *
 * 一个 960×600 的终端在 12px 下排得下约 120×36——120 列正好是 CLI 排版的
 * 惯用宽度，13px 只有约 110 列，很多工具的表格会被折行。
 *
 * **只是默认值**：`storedNumber` 先读 localStorage，已经调过字号的用户
 * 一个字都不会被改（`readStored` 拿到值就不看这里）。
 */
export const TERMINAL_DEFAULT_FONT_SIZE = 12;
export const TERMINAL_DEFAULT_LINE_HEIGHT = 1.15;

export const TERMINAL_KEYS: Record<keyof TerminalPreferences, string> = {
  fontFamily: TERM_FONT_FAMILY_KEY,
  fontSize: TERM_FONT_SIZE_KEY,
  lineHeight: TERM_LINE_HEIGHT_KEY,
  letterSpacing: TERM_LETTER_SPACING_KEY,
  cursorStyle: TERM_CURSOR_STYLE_KEY,
  cursorBlink: TERM_CURSOR_BLINK_KEY,
  macOptionIsMeta: TERM_OPTION_META_KEY,
  copyOnSelect: TERM_COPY_ON_SELECT_KEY,
  renderer: TERM_RENDERER_KEY,
  repaintThrottle: TERM_REPAINT_THROTTLE_KEY,
  releaseAfter: TERM_RELEASE_AFTER_KEY,
};

export function storedTerminalPreferences(): TerminalPreferences {
  return {
    fontFamily: readStored(TERM_FONT_FAMILY_KEY) ?? "",
    fontSize: storedNumber(
      TERM_FONT_SIZE_KEY,
      TERMINAL_DEFAULT_FONT_SIZE,
      TERMINAL_FONT_SIZE_RANGE[0],
      TERMINAL_FONT_SIZE_RANGE[1],
    ),
    lineHeight: storedNumber(
      TERM_LINE_HEIGHT_KEY,
      TERMINAL_DEFAULT_LINE_HEIGHT,
      TERMINAL_LINE_HEIGHT_RANGE[0],
      TERMINAL_LINE_HEIGHT_RANGE[1],
    ),
    letterSpacing: storedNumber(
      TERM_LETTER_SPACING_KEY,
      0,
      TERMINAL_LETTER_SPACING_RANGE[0],
      TERMINAL_LETTER_SPACING_RANGE[1],
    ),
    cursorStyle: storedEnum(
      TERM_CURSOR_STYLE_KEY,
      TERMINAL_CURSOR_STYLES,
      "block",
    ),
    cursorBlink: storedBoolean(TERM_CURSOR_BLINK_KEY, true),
    macOptionIsMeta: storedBoolean(TERM_OPTION_META_KEY, false),
    copyOnSelect: storedBoolean(TERM_COPY_ON_SELECT_KEY, false),
    renderer: storedEnum(TERM_RENDERER_KEY, TERMINAL_RENDERERS, "dom"),
    repaintThrottle: storedEnum(
      TERM_REPAINT_THROTTLE_KEY,
      TERMINAL_REPAINT_THROTTLES,
      "off",
    ),
    releaseAfter: storedEnum(
      TERM_RELEASE_AFTER_KEY,
      RELEASE_AFTER_OPTIONS,
      DEFAULT_RELEASE_AFTER,
    ),
  };
}
