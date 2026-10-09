import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { guardPointerRelease } from "./pointer-release";

/**
 * xterm 选区的那份约定（`SelectionService`）：`mousedown` 时往 `document` 挂
 * `mousemove` / `mouseup`，`mousemove` 不看 `buttons` 一律扩选区，`mouseup`
 * 才摘掉。这里用一个同样行为的替身，外加画布平移（d3-zoom）那种在 `window`
 * 捕获相位吞掉 `mouseup` 的祖先。
 */
function fakeSelection(screen: HTMLElement) {
  const state = {
    dragging: false,
    end: null as null | { x: number; y: number },
    ups: [] as { button: number; buttons: number }[],
  };
  const move = (event: MouseEvent) => {
    state.end = { x: event.clientX, y: event.clientY };
  };
  const up = (event: MouseEvent) => {
    state.ups.push({ button: event.button, buttons: event.buttons });
    state.dragging = false;
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
  };
  screen.addEventListener("mousedown", () => {
    state.dragging = true;
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  return state;
}

/** d3-zoom 平移：按下后在 window 捕获相位吞掉 mouseup。 */
function swallowingPanner(pane: HTMLElement) {
  const swallow = (event: MouseEvent) => {
    event.stopImmediatePropagation();
    window.removeEventListener("mouseup", swallow, true);
  };
  pane.addEventListener("mousedown", () =>
    window.addEventListener("mouseup", swallow, true),
  );
}

const mouse = (target: EventTarget, type: string, init: MouseEventInit = {}) =>
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, ...init }),
  );
const pointer = (target: EventTarget, type: string, init: MouseEventInit) => {
  // jsdom 没有 PointerEvent；`pointerup` 的处理只读 MouseEvent 的字段。
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
};

describe("terminal pointer release (#227)", () => {
  let pane: HTMLElement;
  let body: HTMLElement;
  let screen: HTMLElement;
  let outside: HTMLElement;
  let dispose: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    pane = document.createElement("div");
    body = document.createElement("div");
    screen = document.createElement("div");
    outside = document.createElement("div");
    body.append(screen);
    pane.append(body, outside);
    document.body.append(pane);
    dispose = guardPointerRelease(body);
  });

  afterEach(() => {
    dispose();
    pane.remove();
    vi.useRealTimers();
  });

  test("a normal drag inside the node is left alone", () => {
    const selection = fakeSelection(screen);
    mouse(screen, "mousedown", { button: 0, buttons: 1 });
    mouse(screen, "mousemove", { buttons: 1, clientX: 40, clientY: 10 });
    pointer(screen, "pointerup", { button: 0, buttons: 0 });
    mouse(screen, "mouseup", { button: 0, buttons: 0 });
    vi.runAllTimers();
    expect(selection.dragging).toBe(false);
    // 只有真的那一次，没有补派。
    expect(selection.ups).toHaveLength(1);
    expect(selection.end).toEqual({ x: 40, y: 10 });
  });

  test("released outside the node: the selection ends there", () => {
    const selection = fakeSelection(screen);
    mouse(screen, "mousedown", { button: 0, buttons: 1 });
    mouse(outside, "mousemove", { buttons: 1, clientX: 600, clientY: 40 });
    pointer(outside, "pointerup", { button: 0, buttons: 0 });
    mouse(outside, "mouseup", { button: 0, buttons: 0 });
    vi.runAllTimers();
    expect(selection.dragging).toBe(false);
    mouse(outside, "mousemove", { buttons: 0, clientX: 600, clientY: 300 });
    expect(selection.end).toEqual({ x: 600, y: 40 });
  });

  test("a swallowed mouseup is replayed once the pointerup round is over", () => {
    swallowingPanner(pane);
    const selection = fakeSelection(screen);
    mouse(screen, "mousedown", { button: 0, buttons: 1 });
    mouse(outside, "mousemove", { buttons: 1, clientX: 600, clientY: 40 });
    pointer(outside, "pointerup", {
      button: 0,
      buttons: 0,
      clientX: 610,
      clientY: 44,
    });
    mouse(outside, "mouseup", {
      button: 0,
      buttons: 0,
      clientX: 610,
      clientY: 44,
    });
    expect(selection.dragging).toBe(true);
    vi.runAllTimers();
    expect(selection.dragging).toBe(false);
    expect(selection.ups).toEqual([{ button: 0, buttons: 0 }]);
    // 不按键移动不再改选区。
    mouse(outside, "mousemove", { buttons: 0, clientX: 600, clientY: 300 });
    mouse(outside, "mousemove", { buttons: 0, clientX: 600, clientY: 10 });
    expect(selection.end).toEqual({ x: 600, y: 40 });
  });

  test("a move without the button ends the drag before it can extend it", () => {
    const selection = fakeSelection(screen);
    mouse(screen, "mousedown", { button: 0, buttons: 1 });
    mouse(outside, "mousemove", { buttons: 1, clientX: 600, clientY: 40 });
    // 松开既没有 pointerup 也没有 mouseup（窗口外松开、被吞）。
    mouse(outside, "mousemove", { buttons: 0, clientX: 600, clientY: 300 });
    expect(selection.dragging).toBe(false);
    expect(selection.end).toEqual({ x: 600, y: 40 });
    expect(selection.ups).toHaveLength(1);
  });

  test.each([
    ["blur", () => window.dispatchEvent(new Event("blur"))],
    [
      "pointercancel",
      () => pointer(outside, "pointercancel", { button: 0, buttons: 0 }),
    ],
    [
      "visibilitychange",
      () => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
        delete (document as { visibilityState?: unknown }).visibilityState;
      },
    ],
  ])("%s ends the drag", (_name, fire) => {
    const selection = fakeSelection(screen);
    mouse(screen, "mousedown", { button: 0, buttons: 1 });
    mouse(outside, "mousemove", { buttons: 1, clientX: 600, clientY: 40 });
    fire();
    expect(selection.dragging).toBe(false);
    expect(selection.ups).toHaveLength(1);
  });

  test("mouse reporting: a middle press swallowed by the pan still reports its release", () => {
    swallowingPanner(pane);
    const selection = fakeSelection(screen);
    mouse(screen, "mousedown", { button: 1, buttons: 4 });
    mouse(outside, "mousemove", { buttons: 4, clientX: 600, clientY: 40 });
    pointer(outside, "pointerup", { button: 1, buttons: 0 });
    mouse(outside, "mouseup", { button: 1, buttons: 0 });
    vi.runAllTimers();
    expect(selection.ups).toEqual([{ button: 1, buttons: 0 }]);
  });

  test("nothing is listened to while no button is held", () => {
    const add = vi.spyOn(window, "addEventListener");
    mouse(outside, "mousemove", { buttons: 0 });
    expect(add).not.toHaveBeenCalled();
    add.mockRestore();
  });

  test("disposing mid-drag removes the window listeners", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    mouse(screen, "mousedown", { button: 0, buttons: 1 });
    dispose();
    expect(remove).toHaveBeenCalledWith(
      "mousemove",
      expect.any(Function),
      true,
    );
    remove.mockRestore();
    dispose = () => undefined;
  });
});
