import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactFlowProvider } from "@xyflow/react";
import { fireEvent, screen } from "@testing-library/react";
import { TooltipProvider } from "@/ui/tooltip";

/**
 * 壳的测试外壳。Radix 的 Popper/ScrollArea 依赖 `ResizeObserver`，
 * jsdom 没有；`scrollIntoView` 同理。这里一次补齐，测试文件不再各自打补丁。
 */
export function installDomPolyfills() {
  if (!("ResizeObserver" in globalThis)) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      value: ResizeObserverStub,
      writable: true,
    });
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => undefined;
  }
  // input-otp 定时探测口令管理器的浮标位置。
  if (typeof document.elementFromPoint !== "function") {
    document.elementFromPoint = () => null;
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => undefined;
    Element.prototype.releasePointerCapture = () => undefined;
  }
}

/**
 * 与 `app/App.tsx` 同一组 provider。`<ReactFlowProvider>` 也在里面：
 * Dock 的缩放档位用 `useViewport()`，那个 hook 在 provider 之外会抛。
 */
export function TestProviders({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={client}>
      <ReactFlowProvider>
        <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
      </ReactFlowProvider>
    </QueryClientProvider>
  );
}

/**
 * Radix 的 Select：jsdom 里没有真实指针，要先用键盘打开触发器才会渲染选项，
 * 再点选项。`name` 是选项的可见文字。
 */
export async function chooseOption(
  trigger: HTMLElement,
  name: string | RegExp,
): Promise<void> {
  installDomPolyfills();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name }));
}

/** 打开 Radix 的 Select 读出全部选项的可见文字，然后按 Esc 收起。 */
export async function optionLabels(trigger: HTMLElement): Promise<string[]> {
  installDomPolyfills();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const options = await screen.findAllByRole("option");
  const labels = options.map((option) => option.textContent ?? "");
  fireEvent.keyDown(options[0]!, { key: "Escape" });
  return labels;
}
