import * as React from "react";

/** 可视视口（`window.visualViewport` 的子集；测试换成假的）。 */
interface ViewportLike {
  readonly height: number;
  readonly offsetTop: number;
  addEventListener(type: "resize" | "scroll", listener: () => void): void;
  removeEventListener(type: "resize" | "scroll", listener: () => void): void;
}

export interface VisibleArea {
  readonly height: number;
  readonly top: number;
}

/**
 * 软键盘弹起时剩下的那块可视区域（设计系统 §5.13「焦点页 PromptBox 固定
 * 底部」）。
 *
 * Android 上键盘会缩布局视口，`100dvh` 就够；iOS Safari 不缩，键盘盖在页面
 * 上，固定在底部的输入框会被挡住。那时可视视口比窗口矮，按它的高度与偏移
 * 摆整页，输入框与终端按键条就都坐在键盘上沿。键盘没弹时返回 `null`，交回
 * `100dvh`。
 */
export function useVisibleArea(): VisibleArea | null {
  const [area, setArea] = React.useState<VisibleArea | null>(null);
  React.useEffect(() => {
    const viewport = (globalThis as { visualViewport?: ViewportLike | null })
      .visualViewport;
    if (!viewport) return;
    const update = () => {
      // 1px 的差是缩放取整，不是键盘。
      const covered = globalThis.innerHeight - viewport.height > 1;
      setArea((previous) => {
        if (!covered) return previous === null ? previous : null;
        const next = {
          height: Math.round(viewport.height),
          top: Math.round(viewport.offsetTop),
        };
        return previous?.height === next.height && previous.top === next.top
          ? previous
          : next;
      });
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return area;
}
