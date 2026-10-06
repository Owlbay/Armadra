import { isNativeAppPage } from "../api/runtime-url";

/**
 * 原生 App 的状态栏文字颜色跟着页面主题走（设计系统 §5.13：原生状态栏取 `--bg` 色）。
 *
 * 页面铺到状态栏下面（`viewport-fit=cover`），状态栏底下就是 `--bg`。系统默认按设备
 * 的深浅色选文字颜色，App 里选的主题与系统不一致时会是深底深字。这里经 Capacitor
 * 自带的 `SystemBars` 插件定死：深色主题 `DARK`（浅色文字），浅色主题 `LIGHT`（深色
 * 文字）。不在原生 App 里什么也不做；插件不在或调用失败也不影响页面。
 */
interface SystemBarsPlugin {
  setStyle(options: {
    style: "DARK" | "LIGHT";
    bar?: "StatusBar";
  }): Promise<void>;
}

function systemBars(): SystemBarsPlugin | null {
  if (!isNativeAppPage()) return null;
  const found = (
    globalThis as {
      Capacitor?: { Plugins?: { SystemBars?: SystemBarsPlugin } };
    }
  ).Capacitor?.Plugins?.SystemBars;
  return found && typeof found.setStyle === "function" ? found : null;
}

let applied: "dark" | "light" | null = null;

export function syncNativeStatusBar(theme: "dark" | "light"): void {
  if (applied === theme) return;
  const plugin = systemBars();
  if (!plugin) return;
  applied = theme;
  void plugin
    .setStyle({ style: theme === "dark" ? "DARK" : "LIGHT", bar: "StatusBar" })
    .catch(() => {
      applied = null;
    });
}

/** 测试用：清掉记下的上一次主题。 */
export function resetNativeStatusBarForTest(): void {
  applied = null;
}
