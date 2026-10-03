import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const access = vi.hoisted(() => ({ member: false }));
const settings = vi.hoisted(() => ({
  mutate: vi.fn(),
  load: vi.fn(),
  data: { collab: { realtime: true } } as Record<string, unknown>,
}));

vi.mock("@/app/use-access", () => ({ useAccess: () => access }));
vi.mock("@/panels/settings/use-runtime-settings", () => ({
  useRuntimeSettings: () => {
    settings.load();
    return {
      settings: { data: settings.data },
      save: { mutate: settings.mutate, isPending: false },
    };
  },
}));

import { RealtimeSetting } from "./RealtimeSetting";

/** 设置里的「实时协同」开关（`collab.realtime`，补全架构 §14 Q2）。 */
describe("RealtimeSetting", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    access.member = false;
    settings.data = { collab: { realtime: true } };
  });

  it("缺省开；关掉写 collab.realtime = false", () => {
    render(<RealtimeSetting />);
    const toggle = screen.getByRole("switch", { name: "实时协同" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(settings.mutate).toHaveBeenCalledWith({
      collab: { realtime: false },
    });
  });

  it("设置里关着就显示关", () => {
    settings.data = { collab: { realtime: false } };
    render(<RealtimeSetting />);
    expect(
      screen
        .getByRole("switch", { name: "实时协同" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("成员不显示，也不去读设置文档", () => {
    access.member = true;
    const { container } = render(<RealtimeSetting />);
    expect(container.innerHTML).toBe("");
    expect(settings.load).not.toHaveBeenCalled();
  });
});
