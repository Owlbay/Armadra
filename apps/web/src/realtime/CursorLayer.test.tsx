import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import * as React from "react";
import { useStoreApi } from "@xyflow/react";

import { TestProviders, installDomPolyfills } from "@/app/test-harness";
import { emptyWhiteboard, type Item } from "@/canvas/whiteboard/model";
import { useCanvasStore } from "@/store/canvas-store";
import type { Peer } from "./awareness";
import {
  CURSOR_FADE_MS,
  CursorLayer,
  FOLLOW_DURATION_MS,
  itemBox,
  nextCursors,
} from "./CursorLayer";
import { BOARD, ONE, TWO, boardDocument, terminal } from "./realtime.fixture";
import { useRealtimeStore } from "./session";

/**
 * 成员光标与选区（设计系统 §4、§5.6）。
 */

/** React Flow 实例换成桩：只看跟随往相机发了什么。 */
const flow = vi.hoisted(() => ({
  setCenter: vi.fn(() => Promise.resolve(true)),
  getZoom: vi.fn(() => 0.8),
  screenToFlowPosition: vi.fn((point: { x: number; y: number }) => point),
}));
vi.mock("@xyflow/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xyflow/react")>()),
  useReactFlow: () => flow,
}));

/** 给 React Flow 的 store 一个根元素（跟随描边挂在它上面）。 */
function WithDomNode({ children }: { children: React.ReactNode }) {
  const api = useStoreApi();
  const [ready, setReady] = React.useState(false);
  React.useLayoutEffect(() => {
    const root = document.createElement("div");
    root.dataset.testid = "flow-root";
    document.body.appendChild(root);
    api.setState({ domNode: root as HTMLDivElement });
    setReady(true);
    return () => root.remove();
  }, [api]);
  return ready ? <>{children}</> : null;
}

function shape(id: string, patch: Partial<Item> = {}): Item {
  return {
    id,
    kind: "shape",
    geo: "rectangle",
    x: 50,
    y: 60,
    w: 120,
    h: 80,
    z: 1,
    style: {},
    ...patch,
  } as Item;
}

function peer(clientId: number, patch: Partial<Peer["state"]> = {}): Peer {
  return {
    clientId,
    state: {
      principalId: "",
      deviceId: `d${clientId}`,
      name: `Peer ${clientId}`,
      color: clientId + 1,
      ...patch,
    },
  };
}

describe("nextCursors", () => {
  it("有光标的画，光标没了或人走了转成淡出", () => {
    const first = nextCursors(new Map(), [
      peer(1, { cursor: { x: 1, y: 2 } }),
      peer(2, { cursor: { x: 3, y: 4 } }),
      peer(3),
    ]);
    expect([...first.keys()]).toEqual([1, 2]);
    expect(first.get(1)!.leaving).toBe(false);

    const second = nextCursors(first, [peer(1)]);
    expect(second.get(1)).toMatchObject({
      leaving: true,
      cursor: { x: 1, y: 2 },
    });
    expect(second.get(2)).toMatchObject({
      leaving: true,
      cursor: { x: 3, y: 4 },
    });

    const back = nextCursors(second, [peer(1, { cursor: { x: 9, y: 9 } })]);
    expect(back.get(1)).toMatchObject({
      leaving: false,
      cursor: { x: 9, y: 9 },
    });
  });
});

describe("<CursorLayer />", () => {
  beforeAll(installDomPolyfills);

  beforeEach(() => {
    vi.useFakeTimers();
    const store = useCanvasStore.getState();
    store.selectBoard(BOARD.id);
    store.setDocument(boardDocument([terminal(ONE, 0), terminal(TWO, 400)]));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    flow.setCenter.mockClear();
    useRealtimeStore.setState({
      boardId: null,
      peers: [],
      status: "off",
      following: null,
    });
    useCanvasStore.setState({ whiteboard: emptyWhiteboard() });
    useCanvasStore.getState().selectBoard(null);
  });

  it("非实时板什么都不画", () => {
    const { container } = render(<CursorLayer />, { wrapper: TestProviders });
    expect(container.innerHTML).toBe("");
  });

  it("画别人的光标（成员色、名字）与选区外框；多人选同一个节点一圈套一圈", () => {
    useRealtimeStore.setState({
      boardId: BOARD.id,
      status: "online",
      peers: [
        peer(1, { cursor: { x: 10, y: 20 }, selection: [ONE] }),
        peer(2, { selection: [ONE, "wb:item", "missing"] }),
      ],
    });
    const { container } = render(<CursorLayer />, { wrapper: TestProviders });
    const cursors = container.querySelectorAll("[data-peer-cursor]");
    expect(cursors).toHaveLength(1);
    expect(cursors[0]!.textContent).toBe("Peer 1");
    expect((cursors[0] as HTMLElement).style.transform).toContain(
      "translate(10px, 20px)",
    );
    const rings = [
      ...container.querySelectorAll<HTMLElement>("[data-peer-selection]"),
    ];
    expect(rings.map((ring) => ring.dataset.peerSelection)).toEqual([ONE, ONE]);
    expect(rings[0]!.style.border).toContain("dashed");
    expect(rings[0]!.style.border).toContain("var(--member-2)");
    expect(rings[1]!.style.border).toContain("var(--member-3)");
    // 第二圈在第一圈外面 2px。
    expect(Number.parseFloat(rings[1]!.style.left)).toBeLessThan(
      Number.parseFloat(rings[0]!.style.left),
    );
  });

  it("人走了原地淡出，5 秒后摘掉", () => {
    useRealtimeStore.setState({
      boardId: BOARD.id,
      status: "online",
      peers: [peer(1, { cursor: { x: 10, y: 20 } })],
    });
    const { container } = render(<CursorLayer />, { wrapper: TestProviders });
    act(() => useRealtimeStore.setState({ peers: [] }));
    const cursor = container.querySelector<HTMLElement>("[data-peer-cursor]");
    expect(cursor?.dataset.leaving).toBe("true");
    expect(cursor?.style.opacity).toBe("0");
    act(() => vi.advanceTimersByTime(CURSOR_FADE_MS));
    expect(container.querySelector("[data-peer-cursor]")).toBeNull();
  });

  it("白板对象（wb:）按 item 的包围盒画选区外框；在 Frame 里的加上 Frame 的位置", () => {
    useCanvasStore.setState({
      whiteboard: {
        ...emptyWhiteboard(),
        items: [shape("a"), shape("b", { parentId: TWO, x: 10, y: 5 })],
      },
    });
    useRealtimeStore.setState({
      boardId: BOARD.id,
      status: "online",
      peers: [peer(1, { selection: ["wb:a", "wb:b", "wb:gone"] })],
    });
    const { container } = render(<CursorLayer />, { wrapper: TestProviders });
    const rings = [
      ...container.querySelectorAll<HTMLElement>("[data-peer-selection]"),
    ];
    expect(rings.map((ring) => ring.dataset.peerSelection)).toEqual([
      "wb:a",
      "wb:b",
    ]);
    // 外偏 2px：item (50, 60, 120×80)。
    expect(rings[0]!.style.left).toBe("48px");
    expect(rings[0]!.style.top).toBe("58px");
    expect(rings[0]!.style.width).toBe("124px");
    expect(rings[0]!.style.height).toBe("84px");
    expect(rings[0]!.style.border).toContain("dashed");
    // TWO 在 (400, 0)：item 相对它 (10, 5)。
    expect(rings[1]!.style.left).toBe("408px");
    expect(rings[1]!.style.top).toBe("3px");
  });

  it("itemBox：父 Frame 不在了按自己的坐标", () => {
    expect(itemBox([], shape("x", { parentId: "missing" }))).toEqual({
      x: 50,
      y: 60,
      width: 120,
      height: 80,
    });
  });

  it("跟随：对方报了视口就对上它的中心与缩放（120ms），画布描一圈成员色", () => {
    useRealtimeStore.setState({
      boardId: BOARD.id,
      status: "online",
      following: 1,
      peers: [
        peer(1, {
          viewport: { x: 300, y: -40, zoom: 1.5 },
          cursor: { x: 9, y: 9 },
        }),
      ],
    });
    render(
      <WithDomNode>
        <CursorLayer />
      </WithDomNode>,
      { wrapper: TestProviders },
    );
    expect(flow.setCenter).toHaveBeenLastCalledWith(300, -40, {
      zoom: 1.5,
      duration: FOLLOW_DURATION_MS,
    });
    const frame = document.querySelector<HTMLElement>(
      '[data-testid="flow-root"] [data-slot="follow-frame"]',
    );
    expect(frame?.style.boxShadow).toContain("var(--member-2)");

    act(() =>
      useRealtimeStore.setState({
        peers: [peer(1, { viewport: { x: 0, y: 10, zoom: 0.5 } })],
      }),
    );
    expect(flow.setCenter).toHaveBeenLastCalledWith(0, 10, {
      zoom: 0.5,
      duration: FOLLOW_DURATION_MS,
    });

    act(() => useRealtimeStore.setState({ following: null }));
    expect(document.querySelector('[data-slot="follow-frame"]')).toBeNull();
  });

  it("跟随：对方没报视口时退回跟光标，缩放不变；人走了停止跟随", () => {
    useRealtimeStore.setState({
      boardId: BOARD.id,
      status: "online",
      following: 1,
      peers: [peer(1, { cursor: { x: 70, y: 80 } })],
    });
    render(<CursorLayer />, { wrapper: TestProviders });
    expect(flow.setCenter).toHaveBeenLastCalledWith(70, 80, {
      zoom: 0.8,
      duration: FOLLOW_DURATION_MS,
    });
    act(() => useRealtimeStore.setState({ peers: [] }));
    expect(useRealtimeStore.getState().following).toBeNull();
  });
});
