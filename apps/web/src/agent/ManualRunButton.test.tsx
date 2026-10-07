import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ManualRunButton } from "./ManualRunButton";
const mocked = vi.hoisted(() => ({ start: vi.fn(), member: false }));
vi.mock("@/api/client", () => ({
  runtimeApi: { startManualRun: mocked.start },
}));
vi.mock("@/app/use-access", () => ({
  useAccess: () => ({ member: mocked.member }),
}));
vi.mock("@/app/preferences-store", () => ({
  useT: () => (key: string) => key,
}));
vi.mock("@/store/canvas-store", () => ({
  useCanvasStore: {
    getState: () => ({
      workspace: { id: "workspace" },
      document: { board: { id: "board", updatedAt: "revision" } },
    }),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
beforeEach(() => {
  mocked.member = false;
  mocked.start.mockReset().mockResolvedValue({ runId: "run", state: "queued" });
});
afterEach(cleanup);
it("mount creates no session; an explicit task invokes core with the current revision and a stable request key", async () => {
  render(<ManualRunButton nodeId="node" />);
  expect(mocked.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "run.manual.open" }));
  fireEvent.change(screen.getByLabelText("run.manual.prompt"), {
    target: { value: "Implement this approved task" },
  });
  fireEvent.click(screen.getByRole("button", { name: "run.manual.start" }));
  await waitFor(() => expect(mocked.start).toHaveBeenCalledTimes(1));
  expect(mocked.start).toHaveBeenCalledWith(
    "workspace",
    "board",
    "node",
    expect.objectContaining({
      prompt: "Implement this approved task",
      expectedUpdatedAt: "revision",
      key: expect.any(String),
    }),
  );
});
it("hides the owner-only manual entry for a member", () => {
  mocked.member = true;
  const view = render(<ManualRunButton nodeId="node" />);
  expect(view.container.textContent).toBe("");
});
