import { create } from "zustand";

import { isNativeApp } from "../mobile/native-bridge";

/**
 * 「切换服务」的去处（A7-1，多端入口设计 §1.4）：原生 App 回选择页（地址换成
 * `#connections` 再重载，原生源地址一次加载只算一次）；桌面与服务器壳的页面
 * 所有源同时挂着，开「切换服务」对话框换当前源。
 */
interface ServiceSwitcherState {
  readonly open: boolean;
  setOpen(open: boolean): void;
}

export const useServiceSwitcher = create<ServiceSwitcherState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** 回到选择页（原生 App）。 */
export function returnToPicker(
  reload: () => void = () => globalThis.location.reload(),
): void {
  try {
    globalThis.history?.replaceState(
      null,
      "",
      `${location.pathname}${location.search}#connections`,
    );
  } catch {
    /* 写不进地址栏：重载后照样落在选择页（缺省就是它）。 */
  }
  reload();
}

export function switchService(): void {
  if (isNativeApp()) {
    returnToPicker();
    return;
  }
  useServiceSwitcher.getState().setOpen(true);
}

/** 桌面壳能另开窗口。 */
export function canOpenSourceWindow(): boolean {
  const bridge = typeof window === "undefined" ? undefined : window.armadra;
  return typeof bridge?.windows?.openSource === "function";
}

/** 在新窗口打开一个源；壳拒了或没有壳答 `false`。 */
export async function openSourceWindow(sourceId: string): Promise<boolean> {
  const bridge = typeof window === "undefined" ? undefined : window.armadra;
  if (typeof bridge?.windows?.openSource !== "function") return false;
  try {
    return (await bridge.windows.openSource({ sourceId })).opened === true;
  } catch {
    return false;
  }
}

/** 新窗口地址里的初始当前源（`?source=`）；没有是 `null`。 */
export function initialSourceParam(
  search: string = globalThis.location?.search ?? "",
): string | null {
  try {
    const value = new URLSearchParams(search).get("source");
    return value !== null && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
      ? value
      : null;
  } catch {
    return null;
  }
}
