import {
  isServerShellServed,
  resolveRuntimeUrl,
  resolveSocketBase,
} from "./runtime-url";

/*
 * 构建配置（`import.meta.env`）只在这里读：`runtime-url.ts` 也被手机壳的类型
 * 检查带进去，那边没有 Vite 的类型。
 */

/** 页面所在这台 core 的地址与会话方式（`api/source.ts` 的本机源）。 */
export interface LocalRuntime {
  /** `http(s)://host:port`，不带尾斜杠。 */
  readonly httpBase: string;
  /** 流的基址：桌面壳另报的回环 `ws://`，别处同 `httpBase`。 */
  readonly wsBase: string;
  /** 页面由服务器壳托管：Cookie 会话，写请求带 CSRF。 */
  readonly viaServerShell: boolean;
}

let cachedLocal: LocalRuntime | null = null;

function pageUrl(): string {
  return typeof window === "undefined"
    ? "http://localhost/"
    : window.location.href;
}

/**
 * 本机源的地址：第一次用到时按构建配置、壳与页面地址算一次，之后不变（页面的
 * 来源与壳给的端口在一次加载里都不会变）。原生 App 换了 Gateway 之后由连接页
 * 重新加载页面，所以这里不必感知。
 */
export function localRuntime(): LocalRuntime {
  if (cachedLocal === null) {
    const configured = import.meta.env.VITE_RUNTIME_URL as string | undefined;
    const page = pageUrl();
    const httpBase = resolveRuntimeUrl(configured, page);
    cachedLocal = {
      httpBase,
      wsBase: resolveSocketBase(httpBase),
      viaServerShell: isServerShellServed(configured, page),
    };
  }
  return cachedLocal;
}

/** 测试换了页面地址、壳或构建配置之后重算。 */
export function resetLocalRuntime(): void {
  cachedLocal = null;
}
