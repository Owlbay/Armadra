import * as React from "react";

import { runtimeApi } from "../api/client";
import { useOpenWorkspace } from "../app/workspace-actions";
import { PUSH_OPEN_MESSAGE } from "../push/service-worker";
import { useCanvasStore } from "../store/canvas-store";

/** `armadra://w/<workspaceId>[/n/<nodeId>]` → 两段 id；认不出是 `null`。 */
export function parseDeepLink(
  link: string,
): { workspaceId: string; nodeId: string | null } | null {
  const found = /^armadra:\/\/w\/([^/?#]+)(?:\/n\/([^/?#]+))?\/?$/.exec(link);
  if (!found) return null;
  try {
    return {
      workspaceId: decodeURIComponent(found[1]!),
      nodeId: found[2] === undefined ? null : decodeURIComponent(found[2]),
    };
  } catch {
    return null;
  }
}

const FRAGMENT = /^#push=(.+)$/;

/** 地址栏里的 `#push=<深链>`（service worker 开新窗口、原生 App 收到深链时）。取走即抹掉。 */
export function takePushFragment(): string | null {
  const location = globalThis.location;
  const found = FRAGMENT.exec(location?.hash ?? "");
  if (!found) return null;
  try {
    globalThis.history?.replaceState(
      null,
      "",
      `${location.pathname}${location.search}`,
    );
  } catch {
    /* 抹不掉不影响打开。 */
  }
  try {
    return decodeURIComponent(found[1]!);
  } catch {
    return null;
  }
}

/** 节点出现在当前画布上就进焦点页；等不到（在别的画板上、已删）就算了。 */
const FOCUS_WAIT_MS = 15_000;

function focusWhenPresent(nodeId: string): () => void {
  const store = useCanvasStore;
  const tryFocus = () => {
    const found = store
      .getState()
      .document?.nodes.some((node) => node.id === nodeId);
    if (!found) return false;
    store.getState().selectNodes([nodeId]);
    store.getState().setFocusNode(nodeId);
    return true;
  };
  if (tryFocus()) return () => undefined;
  const stop = store.subscribe(() => {
    if (tryFocus()) cancel();
  });
  const timer = setTimeout(() => cancel(), FOCUS_WAIT_MS);
  const cancel = () => {
    stop();
    clearTimeout(timer);
  };
  return cancel;
}

/**
 * 点通知 → 节点焦点页（设计系统 §5.13「推送点开直接进焦点页」，架构 §10）。
 *
 * 三条入口同一个处理：页面已开着时 service worker 发来的消息、没开时
 * worker 打开的 `#push=` 地址、原生 App 收到深链后改写的 `#push=` 片段。
 */
export function usePushOpen(): void {
  const openWorkspace = useOpenWorkspace();
  const openRef = React.useRef(openWorkspace);
  openRef.current = openWorkspace;

  React.useEffect(() => {
    let cancelFocus: () => void = () => undefined;
    let disposed = false;

    const open = async (link: string) => {
      const target = parseDeepLink(link);
      if (target === null) return;
      cancelFocus();
      const current = useCanvasStore.getState().workspace;
      if (current?.id !== target.workspaceId) {
        const list = await runtimeApi.listWorkspaces().catch(() => null);
        const workspace = list?.find((item) => item.id === target.workspaceId);
        if (disposed || workspace === undefined) return;
        openRef.current(workspace);
      }
      if (target.nodeId !== null) cancelFocus = focusWhenPresent(target.nodeId);
    };

    const fromFragment = () => {
      const link = takePushFragment();
      if (link !== null) void open(link);
    };
    fromFragment();
    globalThis.addEventListener?.("hashchange", fromFragment);

    const worker = globalThis.navigator?.serviceWorker;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (data?.type === PUSH_OPEN_MESSAGE && typeof data.url === "string")
        void open(data.url);
    };
    worker?.addEventListener?.("message", onMessage);

    return () => {
      disposed = true;
      cancelFocus();
      globalThis.removeEventListener?.("hashchange", fromFragment);
      worker?.removeEventListener?.("message", onMessage);
    };
  }, []);
}
