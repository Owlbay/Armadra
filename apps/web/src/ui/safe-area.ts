import * as React from "react";

/**
 * 浮层的安全区（设计系统 §3.1）。
 *
 * 弹出层（Popover、DropdownMenu、Select、Tooltip、HoverCard、ContextMenu）由
 * Radix 按视口算位置，躲边只认 `collisionPadding` 的数字，不认 CSS 变量；这里把
 * `--safe-*` 与 iPadOS 窗口控件（`--window-controls-top`）量成像素交给它。
 * 桌面壳与普通浏览器里这些变量都是 0，结果也是 0——与之前逐像素一致。
 *
 * 量法：一个看不见的探针，`padding` 取那几个变量，读算好的像素。`env()` 留在
 * 自定义属性里是原样的记号，只有落到真实属性上才会被算成数。
 */

/**
 * 居中的对话框让开安全区与窗口控件（`--overlay-inset-top`、`--safe-*`）：中心点
 * 挪到可用区域的中心，宽高各减去两边的安全区。桌面与普通浏览器里变量都是 0，
 * 与原来的 `top-1/2 left-1/2 max-w-[calc(100%-2rem)]` 一致。AlertDialog 共用。
 */
export const SAFE_CENTERED =
  "top-[calc(50%+(var(--overlay-inset-top)-var(--safe-bottom))/2)] left-[calc(50%+(var(--safe-left)-var(--safe-right))/2)] max-h-[calc(100dvh-2rem-var(--overlay-inset-top)-var(--safe-bottom))] max-w-[calc(100%-2rem-var(--safe-left)-var(--safe-right))]";

export interface EdgeInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** 有安全区的那条边，浮层再离它多远。 */
export const OVERLAY_SAFE_GAP = 4;

const ZERO: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** 直接读根上的自定义属性：只认已经是像素的（原生层写的、测试里给的）。 */
function declared(root: HTMLElement, name: string): number {
  return px(getComputedStyle(root).getPropertyValue(name).trim());
}

/** 量此刻四条边的安全区；顶边取安全区与窗口控件里高的那个。 */
export function measureSafeInsets(doc: Document = document): EdgeInsets {
  const root = doc.documentElement;
  if (doc.body === null) return ZERO;
  const probe = doc.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
    "padding-top:max(var(--safe-top,0px),var(--window-controls-top,0px));" +
    "padding-right:var(--safe-right,0px);padding-bottom:var(--safe-bottom,0px);" +
    "padding-left:var(--safe-left,0px)";
  doc.body.append(probe);
  const style = getComputedStyle(probe);
  const measured = {
    top: px(style.paddingTop),
    right: px(style.paddingRight),
    bottom: px(style.paddingBottom),
    left: px(style.paddingLeft),
  };
  probe.remove();
  return {
    top:
      measured.top ||
      Math.max(
        declared(root, "--safe-top"),
        declared(root, "--window-controls-top"),
      ),
    right: measured.right || declared(root, "--safe-right"),
    bottom: measured.bottom || declared(root, "--safe-bottom"),
    left: measured.left || declared(root, "--safe-left"),
  };
}

let snapshot: EdgeInsets | null = null;
const listeners = new Set<() => void>();
let teardown: (() => void) | null = null;

function same(a: EdgeInsets, b: EdgeInsets): boolean {
  return (
    a.top === b.top &&
    a.right === b.right &&
    a.bottom === b.bottom &&
    a.left === b.left
  );
}

function refresh(): void {
  const next = measureSafeInsets();
  if (snapshot !== null && same(snapshot, next)) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (teardown === null) {
    // 横竖屏、分屏、台前调度改窗口形状时 `env()` 跟着变；原生层写窗口控件时
    // 改的是根元素的内联样式。
    snapshot = null;
    const onChange = () => refresh();
    window.addEventListener("resize", onChange);
    window.addEventListener("orientationchange", onChange);
    window.visualViewport?.addEventListener("resize", onChange);
    const observer =
      typeof MutationObserver === "function"
        ? new MutationObserver(onChange)
        : null;
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    teardown = () => {
      window.removeEventListener("resize", onChange);
      window.removeEventListener("orientationchange", onChange);
      window.visualViewport?.removeEventListener("resize", onChange);
      observer?.disconnect();
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      teardown?.();
      teardown = null;
    }
  };
}

function current(): EdgeInsets {
  // 还没人订阅时没有事件来更新，只能每次量；量出来没变就还给同一个对象——
  // useSyncExternalStore 要求快照稳定。
  if (snapshot === null || teardown === null) {
    const next = measureSafeInsets();
    if (snapshot === null || !same(snapshot, next)) snapshot = next;
  }
  return snapshot;
}

function server(): EdgeInsets {
  return ZERO;
}

/** 此刻的安全区，窗口形状或原生层写的变量变了会重渲染。 */
export function useSafeInsets(): EdgeInsets {
  return React.useSyncExternalStore(subscribe, current, server);
}

type CollisionPadding = number | Partial<Record<keyof EdgeInsets, number>>;

/**
 * 给 Radix 弹出层的 `collisionPadding`：有安全区的边让开它再加
 * {@link OVERLAY_SAFE_GAP}，没有的边是 0。调用方自己给了就用调用方的。
 */
export function useOverlayCollisionPadding(
  override?: CollisionPadding,
): CollisionPadding {
  const insets = useSafeInsets();
  const { top, right, bottom, left } = insets;
  const computed = React.useMemo(() => {
    const pad = (value: number) => (value > 0 ? value + OVERLAY_SAFE_GAP : 0);
    return {
      top: pad(top),
      right: pad(right),
      bottom: pad(bottom),
      left: pad(left),
    };
  }, [top, right, bottom, left]);
  return override ?? computed;
}

/** 有没有任何一条边有安全区。 */
export function hasSafeInsets(insets: EdgeInsets): boolean {
  return (
    insets.top > 0 || insets.right > 0 || insets.bottom > 0 || insets.left > 0
  );
}
