import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { TerminalNodeData } from "@armadra/shared";
import type { TerminalTransportHandlers } from "./transport";
import { installDomPolyfills } from "../app/test-harness";

/**
 * 后台渲染预算（终端宿主设计 §7.1）在真实表面上的行为。
 *
 * 判定逻辑本身在 `render-state.test.ts` / `render-budget.test.ts` 里钉死，
 * 这里只验两件靠纯函数验不了的事：
 *
 *  1. 窗口切到后台之后，每一帧输出**不再**写进 xterm，而是攒起来，回到前台
 *     时按原顺序一次灌完——设计里那句「不能因 `display:none` 仍让几十个终端
 *     每帧 fit 和重绘」；
 *  2. 后台待够 `HIDDEN_DETACH_MS` 会主动收掉 socket，回到前台重新 attach，
 *     **不新建会话**。
 */

const fixture = vi.hoisted(() => ({
  data: { kind: "terminal", sessionId: "session" } as TerminalNodeData,
  handlers: null as TerminalTransportHandlers | null,
  writes: [] as string[],
  urls: [] as string[],
  close: vi.fn(),
  /** 每条传输收到的输入与 resize，按创建顺序。 */
  inputs: [] as string[][],
  resizes: [] as [number, number][],
  /** 每个 `new Terminal` 的构造参数；`disposed` 记销毁次数。 */
  terminals: [] as { cols?: number; rows?: number }[],
  disposed: 0,
  proposed: { cols: 80, rows: 24 } as
    | { cols: number; rows: number }
    | undefined,
  getTerminal: vi.fn(),
  createTerminal: vi.fn(),
  wakeTerminal: vi.fn(),
}));

vi.mock("@/store/canvas-store", () => ({
  useCanvasStore: {
    getState: () => ({
      workspace: { id: "workspace", rootPath: "/repo" },
      document: {
        board: { id: "board" },
        nodes: [{ id: "node", data: fixture.data }],
      },
      updateNodeData: vi.fn(),
      updateNode: vi.fn(),
    }),
  },
}));
vi.mock("@/api/client", () => ({
  terminalWebSocketUrl: (sessionId: string) => `ws://runtime/${sessionId}`,
  runtimeApi: {
    getTerminal: (...args: unknown[]) => fixture.getTerminal(...args),
    createTerminal: (...args: unknown[]) => fixture.createTerminal(...args),
    wakeTerminal: (...args: unknown[]) => fixture.wakeTerminal(...args),
    agents: vi.fn(async () => []),
  },
}));
vi.mock("@/agent/status-store", () => ({
  useAgentStatusStore: {
    getState: () => ({ statuses: {}, markRead: vi.fn() }),
  },
}));
vi.mock("@/agent/pending-launch", () => ({
  armPendingLaunch: vi.fn(),
  usePendingLaunchWatcher: vi.fn(),
  usePendingLaunchStore: { getState: () => ({ entries: {} }) },
  disarmPendingLaunch: vi.fn(),
}));
vi.mock("./platform", () => ({
  runtimePlatform: () => "unix",
  loadRuntimePlatform: async () => "unix",
}));
vi.mock("./transport", () => ({
  createTerminalTransport: (
    url: string,
    handlers: TerminalTransportHandlers,
  ) => {
    fixture.urls.push(url);
    fixture.handlers = handlers;
    const inputs: string[] = [];
    fixture.inputs.push(inputs);
    return {
      state: "live",
      generation: 3,
      input: (data: string) => inputs.push(data),
      resize: (cols: number, rows: number) =>
        fixture.resizes.push([cols, rows]),
      close: fixture.close,
      terminate: vi.fn(),
    };
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    constructor(options: { cols?: number; rows?: number } = {}) {
      fixture.terminals.push({ cols: options.cols, rows: options.rows });
      if (options.cols) this.cols = options.cols;
      if (options.rows) this.rows = options.rows;
    }
    unicode = { activeVersion: "" };
    parser = { registerOscHandler: () => ({ dispose() {} }) };
    textarea = undefined;
    loadAddon(addon: { activate?: (terminal: unknown) => void }) {
      addon.activate?.(this);
    }
    open() {}
    reset() {}
    write(chunk: string, done?: () => void) {
      fixture.writes.push(chunk);
      done?.();
    }
    dispose() {
      fixture.disposed += 1;
    }
    focus() {}
    attachCustomKeyEventHandler() {}
    onData() {
      return { dispose() {} };
    }
    onSelectionChange() {
      return { dispose() {} };
    }
    onBell() {
      return { dispose() {} };
    }
    onTitleChange() {
      return { dispose() {} };
    }
    hasSelection() {
      return false;
    }
    paste() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    terminal: { cols: number; rows: number } | null = null;
    activate(terminal: { cols: number; rows: number }) {
      this.terminal = terminal;
    }
    proposeDimensions() {
      return fixture.proposed;
    }
    fit() {
      if (this.terminal && fixture.proposed) {
        this.terminal.cols = fixture.proposed.cols;
        this.terminal.rows = fixture.proposed.rows;
      }
    }
  },
}));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-clipboard", () => ({ ClipboardAddon: class {} }));

import * as React from "react";
import { HIDDEN_DETACH_MS, OFFSCREEN_FLUSH_MS } from "./render-state";
import { resetRenderBudget } from "./render-budget";
import {
  LIFECYCLE_RECHECK_MS,
  OFFSCREEN_DETACH_MS,
  releaseAfterMs,
} from "./lifecycle";
import { emitMemoryPressure } from "./pressure-bus";
import {
  TerminalSurface,
  type TerminalSurfaceHandle,
  type TerminalSurfaceStatus,
} from "./TerminalSurface";

installDomPolyfills();

/** jsdom 里 `document.hidden` 是只读的；换掉它再手动派发一次事件。 */
function setPageHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

const hello = {
  sessionId: "session",
  generation: 3,
  backend: "direct" as const,
  rows: 24,
  cols: 80,
  alive: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetRenderBudget();
  fixture.data = { kind: "terminal", sessionId: "session" };
  fixture.handlers = null;
  fixture.writes = [];
  fixture.urls = [];
  fixture.inputs = [];
  fixture.resizes = [];
  fixture.terminals = [];
  fixture.disposed = 0;
  fixture.proposed = { cols: 80, rows: 24 };
  fixture.getTerminal.mockImplementation(async () => ({
    id: "session",
    workspaceId: "workspace",
    shell: "/bin/sh",
    generation: 3,
    status: "running",
    command: null,
    agentId: null,
  }));
});
afterEach(() => {
  cleanup();
  setPageHidden(false);
});

describe("离屏时的输出", () => {
  it("窗口在后台时攒着，回到前台按原顺序一次灌完", async () => {
    const changed = vi.fn<(status: TerminalSurfaceStatus) => void>();
    render(
      <TerminalSurface
        nodeId="node"
        data={fixture.data}
        collapsed={false}
        onStatusChange={changed}
      />,
    );
    await waitFor(() => expect(fixture.handlers).not.toBeNull());
    act(() => fixture.handlers!.onHello!(hello));

    // 看得见：每一帧直接写穿。
    act(() => fixture.handlers!.onOutput!("live"));
    expect(fixture.writes).toEqual(["live"]);

    act(() => setPageHidden(true));
    act(() => fixture.handlers!.onOutput!("a"));
    act(() => fixture.handlers!.onOutput!("b"));
    act(() => fixture.handlers!.onOutput!("c"));
    // 一个字节都没进 xterm——三帧输出没有变成三次重绘。
    expect(fixture.writes).toEqual(["live"]);

    act(() => setPageHidden(false));
    expect(fixture.writes).toEqual(["live", "abc"]);

    // 没有键盘焦点，但看得见且拿到了名额：全速渲染。
    expect(changed.mock.calls.at(-1)?.[0].render).toBe("visible");
  });
});

describe("后台过久后 detach", () => {
  it("收掉 socket 再回来时重新 attach，不新建会话", async () => {
    vi.useFakeTimers();
    try {
      const changed = vi.fn<(status: TerminalSurfaceStatus) => void>();
      render(
        <TerminalSurface
          nodeId="node"
          data={fixture.data}
          collapsed={false}
          onStatusChange={changed}
        />,
      );
      // 假计时器下不能用 `waitFor`：会话查询挂在微任务上，冲两轮即可。
      await act(async () => {});
      await act(async () => {});
      expect(fixture.handlers).not.toBeNull();
      act(() => fixture.handlers!.onHello!(hello));

      act(() => setPageHidden(true));
      // 宽限期内什么都不做：切出去回条消息不该掉连接。
      act(() => vi.advanceTimersByTime(HIDDEN_DETACH_MS - 1_000));
      expect(fixture.close).not.toHaveBeenCalled();

      act(() => vi.advanceTimersByTime(2_000));
      expect(fixture.close).toHaveBeenCalledTimes(1);
      expect(changed.mock.calls.at(-1)?.[0].render).toBe("detached");

      fixture.handlers = null;
      act(() => setPageHidden(false));
      await act(async () => {});
      // 重新 attach 用的是同一个 sessionId，没有人去建第二个 PTY。
      expect(fixture.handlers).not.toBeNull();
      expect(fixture.createTerminal).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("core 替节点起的会话", () => {
  it("节点数据换了会话 id，挂着的表面跟过去，不新建也不重敲启动行", async () => {
    const changed = vi.fn<(status: TerminalSurfaceStatus) => void>();
    const view = render(
      <TerminalSurface
        nodeId="node"
        data={fixture.data}
        collapsed={false}
        onStatusChange={changed}
      />,
    );
    await waitFor(() => expect(fixture.urls).toEqual(["ws://runtime/session"]));
    act(() => fixture.handlers!.onHello!(hello));
    // 旧会话退出：表面停在「已退出」。
    act(() => fixture.handlers!.onStatus!("exited", 0));
    expect(changed.mock.calls.at(-1)?.[0].connection).toBe("exited");

    // 冷启动写回节点数据，合并进 store 后作为新的 data 传进来。
    const next = { kind: "terminal", sessionId: "cold" } as TerminalNodeData;
    view.rerender(
      <TerminalSurface
        nodeId="node"
        data={next}
        collapsed={false}
        onStatusChange={changed}
      />,
    );
    await waitFor(() =>
      expect(fixture.urls).toEqual([
        "ws://runtime/session",
        "ws://runtime/cold",
      ]),
    );
    act(() =>
      fixture.handlers!.onHello!({
        ...hello,
        sessionId: "cold",
        generation: 1,
      }),
    );
    expect(changed.mock.calls.at(-1)?.[0].connection).toBe("live");
    expect(fixture.createTerminal).not.toHaveBeenCalled();
  });

  it("节点数据没变时不因手里的会话不同而被拽回去", async () => {
    // 挂载时 `find` 找到的是比节点数据更新的那个会话。
    fixture.getTerminal.mockImplementation(async () => ({
      id: "newer",
      workspaceId: "workspace",
      shell: "/bin/sh",
      generation: 1,
      status: "running",
      command: null,
      agentId: null,
    }));
    const view = render(
      <TerminalSurface nodeId="node" data={fixture.data} collapsed={false} />,
    );
    await waitFor(() => expect(fixture.urls.at(-1)).toBe("ws://runtime/newer"));
    const seen = [...fixture.urls];
    // 改标题之类的重渲：data 是新对象，但会话 id 没变。
    view.rerender(
      <TerminalSurface
        nodeId="node"
        data={{ ...fixture.data, title: "renamed" } as TerminalNodeData}
        collapsed={false}
      />,
    );
    await act(async () => {});
    expect(fixture.urls).toEqual(seen);
  });
});

describe("节能休眠", () => {
  const row = {
    id: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000002",
    cwd: "/repo",
    shell: "/bin/sh",
    command: null,
    exitCode: null,
    createdAt: "2026-09-26T00:00:00Z",
    endedAt: null,
  };

  it("读到休眠的会话不新建、不连 socket；点一下唤醒后照原样重连", async () => {
    fixture.data = { kind: "terminal", sessionId: row.id };
    fixture.getTerminal.mockImplementation(async () => ({
      ...row,
      status: "terminated",
      generation: 1,
      hibernation: "hibernated",
    }));
    fixture.wakeTerminal.mockImplementation(async () => {
      // 醒来之后那一行就是 running 了，挂载时的那次读也会这么答。
      fixture.getTerminal.mockImplementation(async () => ({
        ...row,
        status: "running",
        generation: 2,
        hibernation: null,
      }));
      return { ...row, status: "running", generation: 2, hibernation: null };
    });
    const changed = vi.fn<(status: TerminalSurfaceStatus) => void>();
    render(
      <TerminalSurface
        nodeId="node"
        data={fixture.data}
        collapsed={false}
        onStatusChange={changed}
      />,
    );
    await waitFor(() =>
      expect(changed.mock.calls.at(-1)?.[0].render).toBe("hibernated"),
    );
    // 挂载时抢先连上的那一条已经收掉；没有人去建第二个 PTY。
    expect(fixture.createTerminal).not.toHaveBeenCalled();
    fixture.handlers = null;

    fireEvent.click(screen.getByRole("button", { name: "唤醒" }));
    await waitFor(() =>
      expect(fixture.wakeTerminal).toHaveBeenCalledWith(row.id),
    );
    await waitFor(() => expect(fixture.handlers).not.toBeNull());
    expect(fixture.wakeTerminal).toHaveBeenCalledTimes(1);
    expect(fixture.createTerminal).not.toHaveBeenCalled();
    expect(changed.mock.calls.at(-1)?.[0].hibernation ?? null).toBeNull();
  });

  /**
   * 挂载时按节点数据里的会话 id 抢先连上的那条 socket，core 会答「没在跑」。
   * 这一帧要是落在「读到休眠」之后、那条连接收掉之前，以前会把表面改成
   * 「已退出」，节点上只剩「重新运行」——点下去就另起一个会话，休眠的那段
   * 再也接不回来（实浏览器探针里打开带休眠节点的画布时稳定复现）。
   */
  it("抢先连上的那条 socket 晚到的「已退出」不盖掉休眠", async () => {
    fixture.data = { kind: "terminal", sessionId: row.id };
    let answer: (value: unknown) => void = () => {};
    fixture.getTerminal.mockImplementation(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const changed = vi.fn<(status: TerminalSurfaceStatus) => void>();
    render(
      <TerminalSurface
        nodeId="node"
        data={fixture.data}
        collapsed={false}
        onStatusChange={changed}
      />,
    );
    await waitFor(() => expect(fixture.handlers).not.toBeNull());
    const early = fixture.handlers!;
    await act(async () => {
      answer({
        ...row,
        status: "terminated",
        generation: 1,
        hibernation: "hibernated",
      });
      await Promise.resolve();
      await Promise.resolve();
      early.onHello!({ ...hello, sessionId: row.id, alive: false });
      early.onStatus!("exited", null);
    });
    expect(changed.mock.calls.at(-1)?.[0].render).toBe("hibernated");
    expect(screen.getByRole("button", { name: "唤醒" })).toBeTruthy();
    expect(fixture.createTerminal).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* 分阶段生命周期（性能设计 §2.4）                                              */
/* -------------------------------------------------------------------------- */

/** 视口观测：jsdom 没有 `IntersectionObserver`，换一个能手动派发的。 */
const viewport = {
  callbacks: [] as ((entries: { isIntersecting: boolean }[]) => void)[],
};
class FakeIntersectionObserver {
  readonly #callback: (entries: { isIntersecting: boolean }[]) => void;
  constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
    this.#callback = callback;
  }
  observe() {
    viewport.callbacks.push(this.#callback);
  }
  disconnect() {
    viewport.callbacks = viewport.callbacks.filter(
      (item) => item !== this.#callback,
    );
  }
}
function setOnScreen(onScreen: boolean): void {
  for (const callback of viewport.callbacks)
    callback([{ isIntersecting: onScreen }]);
}

const RELEASE_MS = releaseAfterMs("10m")!;

describe("分阶段生命周期", () => {
  const original = (globalThis as { IntersectionObserver?: unknown })
    .IntersectionObserver;
  beforeEach(() => {
    viewport.callbacks = [];
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      FakeIntersectionObserver;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    emitMemoryPressure("normal");
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      original;
  });

  async function mount(handle?: React.RefObject<TerminalSurfaceHandle | null>) {
    const view = render(
      <TerminalSurface
        nodeId="node"
        data={fixture.data}
        collapsed={false}
        ref={handle}
      />,
    );
    await act(async () => {});
    await act(async () => {});
    expect(fixture.handlers).not.toBeNull();
    const body = view.container.querySelector<HTMLElement>(
      '[data-slot="terminal-body"]',
    )!;
    return { view, body };
  }

  async function releaseOffscreen(body: HTMLElement) {
    act(() => setOnScreen(false));
    expect(body.dataset.lifecycle).toBe("parked");
    act(() => vi.advanceTimersByTime(OFFSCREEN_DETACH_MS!));
    expect(body.dataset.lifecycle).toBe("detached");
    act(() => vi.advanceTimersByTime(RELEASE_MS));
    expect(body.dataset.lifecycle).toBe("released");
  }

  it("平移离屏：60 s 收 socket、10 min 销毁实例，回来按原行列重建并重连", async () => {
    fixture.proposed = { cols: 120, rows: 40 };
    const { body } = await mount();
    act(() => fixture.handlers!.onHello!({ ...hello, cols: 120, rows: 40 }));
    expect(body.dataset.lifecycle).toBe("live");
    expect(fixture.terminals).toHaveLength(1);

    act(() => setOnScreen(false));
    act(() => vi.advanceTimersByTime(OFFSCREEN_DETACH_MS! - 1_000));
    // 一分钟内什么都不做：平移一下又回来不该掉连接。
    expect(fixture.close).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1_000));
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(body.dataset.lifecycle).toBe("detached");
    // 断开时屏幕还在（保留最后一屏），实例没动。
    expect(fixture.disposed).toBe(0);
    // 节点头仍是「已断开（省电）」那一档。
    expect(body.dataset.render).toBe("detached");

    act(() => vi.advanceTimersByTime(RELEASE_MS));
    expect(body.dataset.lifecycle).toBe("released");
    expect(body.dataset.render).toBe("detached");
    expect(fixture.disposed).toBe(1);

    fixture.handlers = null;
    const resizes = fixture.resizes.length;
    act(() => setOnScreen(true));
    await act(async () => {});
    // 重建：新实例沿用释放前的行列数，同一个会话重新 attach。
    expect(fixture.terminals).toHaveLength(2);
    expect(fixture.terminals[1]).toEqual({ cols: 120, rows: 40 });
    expect(fixture.handlers).not.toBeNull();
    expect(fixture.urls).toEqual([
      "ws://runtime/session",
      "ws://runtime/session",
    ]);
    expect(fixture.createTerminal).not.toHaveBeenCalled();
    act(() => fixture.handlers!.onHello!({ ...hello, cols: 120, rows: 40 }));
    act(() => vi.advanceTimersByTime(100));
    expect(body.dataset.lifecycle).toBe("live");
    // 行列与 core 一致：一次 resize 都不多发。
    expect(fixture.resizes).toHaveLength(resizes);
  });

  it("容器量不出尺寸时不 fit、不发 resize", async () => {
    fixture.proposed = { cols: 1, rows: 1 };
    await mount();
    act(() => fixture.handlers!.onHello!(hello));
    fixture.proposed = undefined;
    act(() => fixture.handlers!.onHello!(hello));
    expect(fixture.resizes).toEqual([]);
  });

  it("已释放的终端收到输入：先复活重连，再把输入按序交给新传输", async () => {
    const handle = React.createRef<TerminalSurfaceHandle>();
    const { body } = await mount(handle);
    act(() => fixture.handlers!.onHello!(hello));
    await releaseOffscreen(body);
    expect(fixture.inputs).toHaveLength(1);

    act(() => {
      handle.current!.writeLine("echo a");
      handle.current!.sendKeys("x");
    });
    await act(async () => {});
    expect(fixture.terminals).toHaveLength(2);
    expect(fixture.inputs).toHaveLength(2);
    expect(fixture.inputs[1]).toEqual(["echo a\r", "x"]);
    // 仍然看不见：复活后停在 parked。还在连接时不收 socket，attach 之后
    // 断开计时从头算。
    expect(body.dataset.lifecycle).toBe("parked");
    act(() => vi.advanceTimersByTime(OFFSCREEN_DETACH_MS!));
    expect(body.dataset.lifecycle).toBe("parked");
    act(() => fixture.handlers!.onHello!(hello));
    act(() => vi.advanceTimersByTime(LIFECYCLE_RECHECK_MS));
    expect(body.dataset.lifecycle).toBe("detached");
  });

  it("离屏输出共用一个调度器按拍灌写，回到可见立刻灌完", async () => {
    const { body } = await mount();
    act(() => fixture.handlers!.onHello!(hello));
    act(() => setOnScreen(false));
    expect(body.dataset.render).toBe("offscreen");
    act(() => fixture.handlers!.onOutput!("a"));
    act(() => fixture.handlers!.onOutput!("b"));
    expect(fixture.writes).toEqual([]);
    act(() => vi.advanceTimersByTime(OFFSCREEN_FLUSH_MS));
    expect(fixture.writes).toEqual(["ab"]);
    act(() => fixture.handlers!.onOutput!("c"));
    act(() => setOnScreen(true));
    expect(fixture.writes).toEqual(["ab", "c"]);
  });

  it("内存压力：可见的不动；告警档只释放离屏够久的，紧急档全部", async () => {
    const { body } = await mount();
    act(() => fixture.handlers!.onHello!(hello));
    act(() => emitMemoryPressure("critical"));
    expect(body.dataset.lifecycle).toBe("live");
    act(() => emitMemoryPressure("normal"));

    act(() => setOnScreen(false));
    act(() => emitMemoryPressure("warning"));
    expect(body.dataset.lifecycle).toBe("parked");
    act(() => vi.advanceTimersByTime(31_000));
    act(() => emitMemoryPressure("warning"));
    expect(body.dataset.lifecycle).toBe("released");
    expect(fixture.disposed).toBe(1);
    expect(fixture.close).toHaveBeenCalledTimes(1);
  });

  it("紧急档：刚离屏的也释放；降回 normal 不重建", async () => {
    const { body } = await mount();
    act(() => fixture.handlers!.onHello!(hello));
    act(() => setOnScreen(false));
    act(() => emitMemoryPressure("critical"));
    expect(body.dataset.lifecycle).toBe("released");
    act(() => emitMemoryPressure("normal"));
    expect(body.dataset.lifecycle).toBe("released");
    expect(fixture.terminals).toHaveLength(1);
  });
});
