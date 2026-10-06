/**
 * 分享链接加入（客户端包 §6.2）在页面里的两件待办，跨组件、跨一次重载传递：
 *
 * - **待填的链接**：桌面壳收到 `armadra://join` 深链、或页面带着 `#join=` 打开
 *   时，设置 → 远程服务里的「通过链接加入」对话框预填它，人点「加入」才挂载。
 *   只在内存里（链接带着秘密，不落存储）。
 * - **加入后打开**：挂载成功之后打开那个源的工作空间。桌面壳为放行新来源会重载
 *   页面（CSP），所以这一项记在 `sessionStorage`，重载后接着做；只存源标识。
 */

const OPEN_KEY = "armadra.sources.openAfterJoin";

type Listener = () => void;
const listeners = new Set<Listener>();
let offered: string | null = null;

function announce(): void {
  for (const listener of [...listeners]) listener();
}

/** 订阅两件待办的变化；返回退订。 */
export function onJoinIntent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 交来一条待填的分享链接（深链或 `#join=`）。 */
export function offerJoinLink(url: string): void {
  offered = url;
  announce();
}

/** 取走待填的链接（只取一次）。 */
export function takeJoinLink(): string | null {
  const url = offered;
  offered = null;
  return url;
}

export function hasOfferedJoinLink(): boolean {
  return offered !== null;
}

function session(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** 挂载成功：记下要打开的源，重载之后也还在。 */
export function openAfterJoin(sourceId: string): void {
  try {
    session()?.setItem(OPEN_KEY, sourceId);
  } catch {
    /* 记不下就停在设置页，侧栏里点一下即可。 */
  }
  announce();
}

/** 等着打开的源；没有是 `null`。 */
export function pendingJoinOpen(): string | null {
  try {
    return session()?.getItem(OPEN_KEY) ?? null;
  } catch {
    return null;
  }
}

export function clearJoinOpen(): void {
  try {
    session()?.removeItem(OPEN_KEY);
  } catch {
    /* 同上 */
  }
}
