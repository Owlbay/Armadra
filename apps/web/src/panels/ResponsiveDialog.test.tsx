import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

let compact = false;
vi.mock("@/platform/layout", () => ({
  useCompactLayout: () => compact,
  isCompactLayout: () => compact,
}));

import { installDomPolyfills } from "../app/test-harness";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogDescription,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
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

function confirm(onOpenChange = vi.fn(), onAction = vi.fn()) {
  render(
    <ResponsiveAlertDialog open onOpenChange={onOpenChange}>
      <ResponsiveAlertDialogContent className="sm:max-w-[420px]">
        <ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogTitle>remove</ResponsiveAlertDialogTitle>
          <ResponsiveAlertDialogDescription>
            description
          </ResponsiveAlertDialogDescription>
        </ResponsiveAlertDialogHeader>
        <ResponsiveAlertDialogFooter>
          <ResponsiveAlertDialogCancel>cancel</ResponsiveAlertDialogCancel>
          <ResponsiveAlertDialogAction onClick={onAction}>
            ok
          </ResponsiveAlertDialogAction>
        </ResponsiveAlertDialogFooter>
      </ResponsiveAlertDialogContent>
    </ResponsiveAlertDialog>,
  );
  return { onOpenChange, onAction };
}

describe("ResponsiveAlertDialog", () => {
  it("桌面宽度是居中的确认框，不带拖柄", () => {
    confirm();
    const dialog = screen.getByRole("alertdialog", { name: "remove" });
    expect(dialog.getAttribute("data-slot")).toBe("alert-dialog-content");
    expect(dialog.getAttribute("data-responsive")).toBeNull();
    expect(dialog.className).toContain("top-1/2");
    expect(dialog.className).toContain("sm:max-w-[420px]");
    expect(
      dialog.querySelector('[data-slot="responsive-dialog-handle"]'),
    ).toBeNull();
  });

  it("≤767 贴底：拖柄、顶部圆角、让出安全区、按钮竖排全宽", () => {
    compact = true;
    confirm();
    // 仍是 alertdialog：确认框的语义与「点遮罩不关」不随宽度变。
    const dialog = screen.getByRole("alertdialog", { name: "remove" });
    expect(dialog.getAttribute("data-responsive")).toBe("sheet");
    expect(dialog.className).toContain("bottom-0");
    expect(dialog.className).not.toContain("top-1/2");
    expect(dialog.className).toContain("rounded-t-[14px]");
    expect(dialog.className).toContain("safe-area-inset-bottom");
    expect(dialog.className).not.toContain("sm:max-w-[420px]");
    expect(
      dialog.querySelector('[data-slot="responsive-dialog-handle"]'),
    ).not.toBeNull();
    const footer = dialog.querySelector('[data-slot="alert-dialog-footer"]');
    expect(footer?.className).toContain("*:w-full");
    expect(footer?.className).toContain("sm:flex-col-reverse");
    const header = dialog.querySelector('[data-slot="alert-dialog-header"]');
    expect(header?.className).toContain("text-left");
  });

  it("两种形态的按钮行为一致：取消关闭、确认回调", () => {
    for (const mode of [false, true]) {
      compact = mode;
      const { onOpenChange, onAction } = confirm();
      fireEvent.click(screen.getByRole("button", { name: "ok" }));
      expect(onAction).toHaveBeenCalledTimes(1);
      expect(onOpenChange).toHaveBeenCalledWith(false);
      cleanup();
      const second = confirm();
      fireEvent.click(screen.getByRole("button", { name: "cancel" }));
      expect(second.onAction).not.toHaveBeenCalled();
      expect(second.onOpenChange).toHaveBeenCalledWith(false);
      cleanup();
    }
  });
});
