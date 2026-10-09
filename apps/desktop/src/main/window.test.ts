import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The main window, against a stand-in `BrowserWindow`.
 *
 * Three things only exist once `window-rules.ts` meets Electron:
 *
 *   1. **Close means hide**, so the Runtime, the Host and the user's
 *      terminals survive a ⌘W or a click on the close button;
 *   2. a FULLSCREEN window leaves fullscreen first (electron/electron#20263 —
 *      hiding from fullscreen leaves a black desktop space behind);
 *   3. **every send resolves the window at send time.** macOS can close the
 *      window and recreate it from the dock, and a captured reference then
 *      points at a destroyed window while every message is silently dropped.
 */

interface Options {
  webPreferences?: Record<string, unknown>;
  show?: boolean;
  title?: string;
  icon?: string;
}

const windows: FakeWindow[] = [];

class FakeWindow {
  destroyed = false;
  hidden = 0;
  shown = 0;
  focused = 0;
  restored = 0;
  minimized = false;
  fullScreen = false;
  fullScreenCalls: boolean[] = [];
  loaded: string[] = [];
  readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  readonly onceHandlers = new Map<string, ((...args: unknown[]) => void)[]>();
  readonly sent: { channel: string; args: unknown[] }[] = [];
  readonly webContents = {
    on: () => undefined,
    send: (channel: string, ...args: unknown[]) =>
      this.sent.push({ channel, args }),
  };

  constructor(readonly options: Options) {
    windows.push(this);
  }

  on(event: string, listener: (...args: unknown[]) => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
  }
  once(event: string, listener: (...args: unknown[]) => void) {
    const list = this.onceHandlers.get(event) ?? [];
    list.push(listener);
    this.onceHandlers.set(event, list);
  }
  emit(event: string, ...args: unknown[]) {
    for (const listener of this.handlers.get(event) ?? []) listener(...args);
    for (const listener of this.onceHandlers.get(event) ?? [])
      listener(...args);
    this.onceHandlers.delete(event);
  }
  isDestroyed() {
    return this.destroyed;
  }
  isFullScreen() {
    return this.fullScreen;
  }
  setFullScreen(value: boolean) {
    this.fullScreenCalls.push(value);
    this.fullScreen = value;
  }
  isMinimized() {
    return this.minimized;
  }
  restore() {
    this.restored += 1;
    this.minimized = false;
  }
  hide() {
    this.hidden += 1;
  }
  show() {
    this.shown += 1;
  }
  focus() {
    this.focused += 1;
  }
  async loadURL(url: string) {
    this.loaded.push(url);
  }

  /** What Electron does when something calls `close()`. */
  close() {
    let prevented = false;
    for (const listener of this.handlers.get("close") ?? [])
      listener({ preventDefault: () => (prevented = true) });
    if (!prevented) {
      this.destroyed = true;
      this.emit("closed");
    }
  }
}

vi.mock("electron", () => ({
  BrowserWindow: class {
    constructor(options: Options) {
      return new FakeWindow(options) as unknown as object;
    }
  },
  session: {
    defaultSession: {
      webRequest: { onHeadersReceived: () => undefined },
    },
  },
}));

vi.mock("./branding", () => ({
  APP_NAME: "Armadra",
  iconPath: () => "/repo/icon.png",
}));

vi.mock("./trace", () => ({ traceLifecycle: () => undefined }));

import {
  closeWindow,
  createMainWindow,
  getMainWindow,
  loadRenderer,
  markQuitting,
  onWindowCreated,
  openSourceWindow,
  revealWindow,
  sendToWindow,
  setPageUrl,
  sourceWindowUrl,
} from "./window";

beforeEach(() => {
  windows.length = 0;
  setPageUrl("http://127.0.0.1:5173/");
});

function open(): FakeWindow {
  // The close-means-hide rule is macOS's; the suite states it explicitly so
  // it holds on the Linux runner too.
  createMainWindow("darwin");
  return windows.at(-1) as FakeWindow;
}

describe("closing the window", () => {
  it("hides it instead, so the background services keep running", () => {
    const window = open();
    closeWindow();
    expect(window.hidden).toBe(1);
    expect(window.destroyed).toBe(false);
  });

  it("leaves fullscreen first, then hides", () => {
    const window = open();
    window.fullScreen = true;
    closeWindow();

    // Hiding straight from fullscreen leaves a black desktop space behind.
    expect(window.hidden).toBe(0);
    expect(window.fullScreenCalls).toEqual([false]);
    window.emit("leave-full-screen");
    expect(window.hidden).toBe(1);
  });
});

describe("talking to the window", () => {
  it("resolves it at send time", () => {
    const window = open();
    sendToWindow("some:channel", { a: 1 });
    expect(window.sent).toEqual([
      { channel: "some:channel", args: [{ a: 1 }] },
    ]);
  });

  it("drops the message rather than throwing when the window is gone", () => {
    const window = open();
    window.destroyed = true;
    expect(() => sendToWindow("some:channel")).not.toThrow();
    expect(getMainWindow()).toBe(null);
  });
});

describe("the per-window wiring", () => {
  it("runs for every window, not only the first", () => {
    // macOS recreates the window from the dock after a close; anything
    // installed only on the first window silently stops working after that.
    const seen: number[] = [];
    onWindowCreated(() => seen.push(1));
    open();
    open();
    expect(seen).toEqual([1, 1]);
  });

  it("opens on the canvas rather than on a white flash", () => {
    const window = open();
    expect(window.options.show).toBe(false);
    window.emit("ready-to-show");
    expect(window.shown).toBe(1);
  });

  it("keeps the preferences the dropped-file path and browser nodes need", () => {
    // `webUtils.getPathForFile` is unavailable in a sandboxed preload, and a
    // browser node is a <webview> guest.
    const window = open();
    expect(window.options.webPreferences?.sandbox).toBe(false);
    expect(window.options.webPreferences?.contextIsolation).toBe(true);
    expect(window.options.webPreferences?.nodeIntegration).toBe(false);
    expect(window.options.webPreferences?.webviewTag).toBe(true);
  });
});

describe("bringing the window back", () => {
  it("restores a minimized window and focuses it", () => {
    const window = open();
    window.minimized = true;
    revealWindow();
    expect(window.restored).toBe(1);
    expect(window.shown).toBe(1);
    expect(window.focused).toBe(1);
  });
});

describe("loading the page", () => {
  it("always goes through a URL, never a file", async () => {
    // A `file:` page is an opaque origin, and the Runtime's CORS grant and the
    // Host's `--allow-origin` both need a name.
    const window = open();
    await loadRenderer(window as never);
    expect(window.loaded).toEqual(["http://127.0.0.1:5173/"]);
  });

  it("refuses to load before the page source was resolved", async () => {
    setPageUrl("");
    const window = open();
    await expect(loadRenderer(window as never)).rejects.toThrow(/page source/);
  });
});

describe("a window opened on one source (window:open)", () => {
  it("loads the same page with `?source=` and stays out of `sendToWindow`", () => {
    const main = open();
    const second = openSourceWindow(
      "a1b2c3",
      "darwin",
    ) as unknown as FakeWindow;
    expect(second).not.toBe(null);
    expect(second.loaded).toEqual(["http://127.0.0.1:5173/?source=a1b2c3"]);
    expect(second.options.webPreferences?.contextIsolation).toBe(true);
    expect(getMainWindow()).toBe(main);
    sendToWindow("x:y");
    expect(main.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(0);
    // Closing it really closes it: nothing to keep alive behind it.
    second.close();
    expect(second.destroyed).toBe(true);
    expect(getMainWindow()).toBe(main);
  });

  it("runs the all-window wiring but not the main-only kind", () => {
    const seen: string[] = [];
    onWindowCreated(() => seen.push("all"));
    onWindowCreated(() => seen.push("main"), "main");
    open();
    seen.length = 0;
    openSourceWindow("a1b2c3", "darwin");
    expect(seen).toContain("all");
    expect(seen).not.toContain("main");
  });

  it("refuses ids that do not look like one", () => {
    for (const bad of ["", "../x", "a b", 7, null, "x".repeat(129)])
      expect(openSourceWindow(bad, "darwin")).toBe(null);
  });

  it("keeps the page's own query and replaces an old `source`", () => {
    expect(
      sourceWindowUrl("http://127.0.0.1:5173/?a=1&source=old", "new"),
    ).toBe("http://127.0.0.1:5173/?a=1&source=new");
  });
});

/**
 * Last on purpose: `markQuitting()` is a one-way switch for the whole module
 * — there is no un-quitting — so anything after it would run against a shell
 * that has already decided to exit.
 */
describe("closing after the quit sequence has started", () => {
  it("really closes, because `close` stops meaning `hide`", () => {
    const window = open();
    markQuitting();
    closeWindow();
    expect(window.destroyed).toBe(true);
    expect(window.hidden).toBe(0);
  });

  it("refuses to bring a window back while quitting", () => {
    expect(revealWindow()).toBe(null);
  });
});
