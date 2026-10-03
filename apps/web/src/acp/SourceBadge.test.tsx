import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/** 来源徽标：「来自 · 节点名」，点一下跳回；来源不在画布上时不画。 */
const gotoNode = vi.hoisted(() => vi.fn());
vi.mock("@/sidebar/goto-node", () => ({ gotoNode }));

const store = vi.hoisted(() => ({
  document: {
    board: { id: "b1" },
    nodes: [{ id: "11111111-1111-4111-8111-111111111111", title: "Codex" }],
  },
}));
vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

import { SourceBadge } from "./SourceBadge";

afterEach(cleanup);

describe("SourceBadge", () => {
  it("写出来源节点名，点一下跳回去", () => {
    render(
      <SourceBadge
        source={{
          nodeId: "11111111-1111-4111-8111-111111111111",
          sessionId: "s1",
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "跳回来源 Codex" }));
    expect(screen.getByText("来自 · Codex")).toBeTruthy();
    expect(gotoNode).toHaveBeenCalledWith(
      "b1",
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("来源节点不在了就不画", () => {
    const { container } = render(
      <SourceBadge
        source={{
          nodeId: "22222222-2222-4222-8222-222222222222",
          sessionId: "s1",
        }}
      />,
    );
    expect(container.innerHTML).toBe("");
  });
});
