import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

let compact = false;
vi.mock("@/platform/layout", () => ({
  useCompactLayout: () => compact,
  isCompactLayout: () => compact,
}));

import { installDomPolyfills } from "../app/test-harness";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "./ResponsiveDialog";

installDomPolyfills();
afterEach(() => {
  cleanup();
  compact = false;
});

function open(onOpenChange = vi.fn()) {
  render(
    <ResponsiveDialog open onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-[520px]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>title</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>description</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <input aria-label="field" />
        <ResponsiveDialogFooter>
          <button type="button">ok</button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>,
  );
  return onOpenChange;
}

describe("ResponsiveDialog", () => {
  it("桌面宽度是居中的 Dialog", () => {
    open();
    const dialog = screen.getByRole("dialog", { name: "title" });
    expect(dialog.getAttribute("data-slot")).toBe("dialog-content");
    expect(dialog.className).toContain("sm:max-w-[520px]");
    expect(
      document.querySelector('[data-slot="dialog-footer"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-slot="responsive-dialog-handle"]'),
    ).toBeNull();
  });

  it("≤767 换成底部 Sheet：拖柄、顶部圆角、限高、让出安全区", () => {
    compact = true;
    open();
    const dialog = screen.getByRole("dialog", { name: "title" });
    expect(dialog.getAttribute("data-slot")).toBe("sheet-content");
    expect(dialog.getAttribute("data-side")).toBe("bottom");
    expect(dialog.getAttribute("data-responsive")).toBe("sheet");
    expect(dialog.className).toContain("rounded-t-[14px]");
    expect(dialog.className).toContain("max-h-[calc(100dvh-48px)]");
    expect(dialog.className).toContain("safe-area-inset-bottom");
    // 桌面宽度的限宽被手机形态压掉
    expect(dialog.className).not.toContain("sm:max-w-[520px]");
    expect(
      dialog.querySelector('[data-slot="responsive-dialog-handle"]'),
    ).not.toBeNull();
    expect(dialog.querySelector('[data-slot="sheet-header"]')).not.toBeNull();
    expect(dialog.querySelector('[data-slot="sheet-footer"]')).not.toBeNull();
    expect(screen.getByText("description")).toBeTruthy();
  });

  it("两种形态都由同一个根控制开关：Esc 关闭", () => {
    for (const mode of [false, true]) {
      compact = mode;
      const onOpenChange = open();
      fireEvent.keyDown(screen.getByLabelText("field"), { key: "Escape" });
      expect(onOpenChange).toHaveBeenCalledWith(false);
      cleanup();
    }
  });
});
