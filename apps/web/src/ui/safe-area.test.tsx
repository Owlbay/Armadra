import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";

import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";
import {
  OVERLAY_SAFE_GAP,
  SAFE_CENTERED,
  measureSafeInsets,
  useOverlayCollisionPadding,
  useSafeInsets,
} from "@/ui/safe-area";

/**
 * 浮层让开安全区（设计系统 §3.1）。jsdom 不算 `env()` 与 `calc()`，这里把变量
 * 直接写成像素放在根上——与 iPadOS 原生层写窗口控件的方式一样；真实几何在
 * Chromium 里另测（`tools/probes/overlay-safe-area.mjs`）。
 */

const VARS = [
  "--safe-top",
  "--safe-right",
  "--safe-bottom",
  "--safe-left",
  "--window-controls-top",
];

function setInsets(values: Partial<Record<string, string>>): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }
}

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  const element = Element.prototype as unknown as Record<string, unknown>;
  if (!("hasPointerCapture" in element)) {
    element.hasPointerCapture = () => false;
    element.setPointerCapture = () => {};
    element.releasePointerCapture = () => {};
  }
  if (!("scrollIntoView" in element)) element.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  for (const name of VARS) document.documentElement.style.removeProperty(name);
});

describe("measureSafeInsets", () => {
  it("没有安全区时四边都是 0（桌面与普通浏览器）", () => {
    expect(measureSafeInsets()).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });

  it("顶边取安全区与窗口控件里高的那个", () => {
    setInsets({
      "--safe-top": "24px",
      "--safe-bottom": "20px",
      "--safe-left": "47px",
      "--window-controls-top": "40px",
    });
    expect(measureSafeInsets()).toEqual({
      top: 40,
      right: 0,
      bottom: 20,
      left: 47,
    });
  });
});

describe("useOverlayCollisionPadding", () => {
  it("有安全区的边让开再加一点间隙，没有的边是 0", () => {
    setInsets({ "--safe-top": "47px", "--safe-bottom": "34px" });
    const { result } = renderHook(() => useOverlayCollisionPadding());
    expect(result.current).toEqual({
      top: 47 + OVERLAY_SAFE_GAP,
      right: 0,
      bottom: 34 + OVERLAY_SAFE_GAP,
      left: 0,
    });
  });

  it("调用方给了就用调用方的", () => {
    setInsets({ "--safe-top": "47px" });
    const { result } = renderHook(() => useOverlayCollisionPadding(8));
    expect(result.current).toBe(8);
  });

  it("原生层改了根上的变量，跟着重算", async () => {
    const { result } = renderHook(() => useSafeInsets());
    expect(result.current.top).toBe(0);
    await act(async () => {
      setInsets({ "--window-controls-top": "40px" });
      // MutationObserver 是微任务。
      await Promise.resolve();
    });
    expect(result.current.top).toBe(40);
  });
});

describe("Select", () => {
  function open() {
    render(
      <Select defaultValue="a" open>
        <SelectTrigger aria-label="pick" />
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
          <SelectItem value="b">B</SelectItem>
        </SelectContent>
      </Select>,
    );
    return document.querySelector("[data-slot=select-content]");
  }

  it("没有安全区时照旧对齐选中项", () => {
    expect(open()?.getAttribute("data-align-trigger")).toBe("true");
  });

  it("有安全区时贴着触发器弹出，才认 collisionPadding", () => {
    setInsets({ "--safe-left": "47px" });
    expect(open()?.getAttribute("data-align-trigger")).toBe("false");
  });
});

describe("Dialog / AlertDialog / Sheet", () => {
  it("居中的对话框让开安全区与窗口控件", () => {
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>t</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const content = document.querySelector("[data-slot=dialog-content]");
    for (const name of SAFE_CENTERED.split(" ")) {
      expect(content?.classList.contains(name), name).toBe(true);
    }
    expect(content?.className).not.toMatch(/\btop-1\/2\b/);
  });

  it("警示对话框同一套", () => {
    render(
      <AlertDialog open>
        <AlertDialogContent aria-describedby={undefined}>
          <AlertDialogTitle>t</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>,
    );
    const content = document.querySelector("[data-slot=alert-dialog-content]");
    expect(content?.className).toContain("var(--overlay-inset-top)");
  });

  it("抽屉按贴着的边让开，关闭钮跟着挪", () => {
    render(
      <Sheet open>
        <SheetContent side="right" aria-describedby={undefined}>
          <SheetTitle>t</SheetTitle>
        </SheetContent>
      </Sheet>,
    );
    const content = document.querySelector("[data-slot=sheet-content]");
    expect(content?.className).toContain("pt-[var(--safe-top)]");
    expect(content?.className).toContain("pr-[var(--safe-right)]");
    expect(content?.className).toContain("pb-[var(--safe-bottom)]");
    expect(content?.className).not.toContain("pl-[var(--safe-left)]");
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.className).toContain("top-[calc(0.75rem+var(--safe-top))]");
  });

  it("调用方给了内边距就用调用方的", () => {
    render(
      <Sheet open>
        <SheetContent side="left" className="p-0" aria-describedby={undefined}>
          <SheetTitle>t</SheetTitle>
        </SheetContent>
      </Sheet>,
    );
    const content = document.querySelector("[data-slot=sheet-content]");
    expect(content?.className).not.toContain("--overlay-inset-top");
    expect(content?.className).toContain("p-0");
  });
});
