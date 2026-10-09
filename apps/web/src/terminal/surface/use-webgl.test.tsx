import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const webgl = vi.hoisted(() => ({
  instances: [] as Array<{
    dispose: ReturnType<typeof vi.fn>;
    lose: () => void;
  }>,
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    dispose = vi.fn();
    private loss: (() => void) | null = null;
    constructor() {
      webgl.instances.push({
        dispose: this.dispose,
        lose: () => this.loss?.(),
      });
    }
    onContextLoss(listener: () => void) {
      this.loss = listener;
    }
  },
}));

import type { TerminalRenderer } from "@/app/preferences/terminal";
import { useCanvasStore } from "@/store/canvas-store";
import type { SurfaceRefs } from "./refs";
import { useLowZoom, useWebglRenderer } from "./use-webgl";

afterEach(() => {
  cleanup();
  webgl.instances.length = 0;
});

function fakeRefs() {
  const loadAddon = vi.fn();
  const refs = {
    terminalRef: { current: { loadAddon } },
    containerRef: { current: document.createElement("div") },
  } as unknown as SurfaceRefs;
  return { refs, loadAddon };
}

function Probe(props: {
  refs: SurfaceRefs;
  renderer: TerminalRenderer;
  budgeted: boolean;
  onLoss?: () => void;
  onActive: (active: boolean) => void;
}) {
  const active = useWebglRenderer(props.refs, {
    mounted: true,
    generation: 0,
    renderer: props.renderer,
    budgeted: props.budgeted,
    reportContextLoss: props.onLoss ?? (() => undefined),
  });
  props.onActive(active);
  return null;
}

/** 等动态 import 落地。 */
const settle = () => act(async () => await new Promise((r) => setTimeout(r)));

describe("useWebglRenderer", () => {
  it("dom 档有名额也不装", async () => {
    const { refs, loadAddon } = fakeRefs();
    const seen: boolean[] = [];
    render(
      <Probe
        refs={refs}
        renderer="dom"
        budgeted
        onActive={(v) => seen.push(v)}
      />,
    );
    await settle();
    expect(loadAddon).not.toHaveBeenCalled();
    expect(seen.at(-1)).toBe(false);
  });

  it("auto 档有名额装、丢名额卸", async () => {
    const { refs, loadAddon } = fakeRefs();
    const seen: boolean[] = [];
    const view = render(
      <Probe
        refs={refs}
        renderer="auto"
        budgeted
        onActive={(v) => seen.push(v)}
      />,
    );
    await settle();
    expect(loadAddon).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toBe(true);
    view.rerender(
      <Probe
        refs={refs}
        renderer="auto"
        budgeted={false}
        onActive={(v) => seen.push(v)}
      />,
    );
    await settle();
    expect(webgl.instances[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toBe(false);
  });

  it("auto 档没名额留在 DOM", async () => {
    const { refs, loadAddon } = fakeRefs();
    render(
      <Probe
        refs={refs}
        renderer="auto"
        budgeted={false}
        onActive={() => undefined}
      />,
    );
    await settle();
    expect(loadAddon).not.toHaveBeenCalled();
  });

  it("丢上下文：卸 addon、上报、退回 DOM", async () => {
    const { refs } = fakeRefs();
    const onLoss = vi.fn();
    const seen: boolean[] = [];
    render(
      <Probe
        refs={refs}
        renderer="webgl"
        budgeted
        onLoss={onLoss}
        onActive={(v) => seen.push(v)}
      />,
    );
    await settle();
    act(() => webgl.instances[0]!.lose());
    expect(webgl.instances[0]!.dispose).toHaveBeenCalled();
    expect(onLoss).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toBe(false);
  });
});

describe("useLowZoom", () => {
  function ZoomProbe(props: {
    enabled: boolean;
    onValue: (v: boolean) => void;
  }) {
    props.onValue(useLowZoom(props.enabled));
    return null;
  }

  function setZoom(zoom: number) {
    useCanvasStore.setState((state) => ({
      document: {
        ...(state.document ?? ({} as never)),
        board: {
          ...(state.document?.board ?? ({} as never)),
          viewport: { x: 0, y: 0, zoom },
        },
      },
    }));
  }

  it("开关开着且缩放 < 0.5 才为真", () => {
    const seen: boolean[] = [];
    setZoom(0.3);
    const view = render(<ZoomProbe enabled onValue={(v) => seen.push(v)} />);
    expect(seen.at(-1)).toBe(true);
    act(() => setZoom(0.8));
    expect(seen.at(-1)).toBe(false);
    act(() => setZoom(0.3));
    view.rerender(<ZoomProbe enabled={false} onValue={(v) => seen.push(v)} />);
    expect(seen.at(-1)).toBe(false);
  });
});
