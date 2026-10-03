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

import { TestProviders, installDomPolyfills } from "@/app/test-harness";
import { useCanvasStore } from "@/store/canvas-store";
import type { Peer } from "./awareness";
import { CURSOR_FADE_MS, CursorLayer, nextCursors } from "./CursorLayer";
import { BOARD, ONE, TWO, boardDocument, terminal } from "./realtime.fixture";
import { useRealtimeStore } from "./session";

/**
 * 成员光标与选区（设计系统 §4、§5.6）。
 */

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
    useRealtimeStore.setState({ boardId: null, peers: [], status: "off" });
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
});
