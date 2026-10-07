import * as React from "react";
import { toast } from "sonner";

import { runtimeApi } from "../api/client";
import { LOCAL_SOURCE_ID } from "../api/source";
import { useT } from "../app/preferences-store";
import { useOpenWorkspace } from "../app/workspace-actions";
import { PUSH_OPEN_MESSAGE } from "../push/service-worker";
import { sourceRegistry } from "../sources/registry";
import { useCanvasStore } from "../store/canvas-store";
import {
  activeConnection,
  loadConnections,
  setActiveConnection,
} from "./connections";
import { isNativeApp } from "./native-bridge";

export interface DeepLinkTarget {
  readonly workspaceId: string;
  readonly nodeId: string | null;
  /** 签发这条通知的源（core 的 `hostId`，契约 §19.4）；旧格式没有，是 `null`。 */
  readonly sourceId: string | null;
}

/**
 * `armadra://w/<workspaceId>[/n/<nodeId>][?s=<sourceId>]` → 三段 id；认不出是
 * `null`。不带 `s` 的旧格式照认（源为 `null`，按当前连接打开）。
 */
export function parseDeepLink(link: string): DeepLinkTarget | null {
  const found =
    /^armadra:\/\/w\/([^/?#]+)(?:\/n\/([^/?#]+))?\/?(?:\?s=([^/?#&]+))?$/.exec(
      link,
    );
  if (!found) return null;
  try {
    return {
      workspaceId: decodeURIComponent(found[1]!),
      nodeId: found[2] === undefined ? null : decodeURIComponent(found[2]),
      sourceId: found[3] === undefined ? null : decodeURIComponent(found[3]),
    };
  } catch {
    return null;
  }
}

/**
 * 通知该在哪儿打开：
 *
 * - `here`：就在这一页。`sourceId` 是页面源表里的源（本机源是
 *   {@link LOCAL_SOURCE_ID}），打开前先切到它。
 * - `switch`：原生 App 连着别的主机，而连接表里有签发它的那一个：记为当前、带着
 *   深链重载（本机源的地址在一次加载里只算一次）。
 * - `unknown`：原生 App 的连接表里没有签发它的主机——提示，不乱开。
 */
export type PushRoute =
  | { readonly kind: "here"; readonly sourceId: string }
  | { readonly kind: "switch"; readonly sourceId: string }
  | { readonly kind: "unknown" };

export interface PushRouteContext {
  /** 原生 App（有连接表）。 */
  readonly native: boolean;
  /** 当前连接（本机源就是它）；没有连接表是 `null`。 */
  readonly activeId: string | null;
  /** 连接表里的源。 */
  readonly connections: readonly string[];
  /** 页面源表里一起挂着、已经连上的远程源。 */
  readonly mounted: (sourceId: string) => boolean;
}

export function pushRouteOf(
  sourceId: string | null,
  context: PushRouteContext,
): PushRoute {
  const local = { kind: "here", sourceId: LOCAL_SOURCE_ID } as const;
  if (sourceId === null || sourceId === context.activeId) return local;
  if (context.mounted(sourceId)) return { kind: "here", sourceId };
  // 网页、桌面与中继托管的页面：通知来自给这一页供数的那台（订阅按来源登记）。
  if (!context.native || context.activeId === null) return local;
  return context.connections.includes(sourceId)
    ? { kind: "switch", sourceId }
    : { kind: "unknown" };
}

function routeContext(): PushRouteContext {
  const native = isNativeApp();
  const registry = sourceRegistry();
  return {
    native,
    activeId: native ? (activeConnection()?.sourceId ?? null) : null,
    connections: native ? loadConnections().map((row) => row.sourceId) : [],
    mounted: (sourceId) => {
      const connection = registry.get(sourceId);
      return (
        connection !== undefined &&
        connection.descriptor.kind !== "local" &&
        connection.status.state === "ready"
      );
    },
  };
}

/** 切到签发它的连接：记为当前，深链留在 `#push=` 里，重载后接着打开。 */
export function switchConnectionFor(
  link: string,
  sourceId: string,
  reload: () => void = () => globalThis.location.reload(),
): void {
  setActiveConnection(sourceId);
  try {
    globalThis.history?.replaceState(
      null,
      "",
      `${location.pathname}${location.search}#push=${encodeURIComponent(link)}`,
    );
  } catch {
    /* 写不进地址栏就只切连接。 */
  }
  reload();
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
  const t = useT();
  const tRef = React.useRef(t);
  tRef.current = t;

  React.useEffect(() => {
    let cancelFocus: () => void = () => undefined;
    let disposed = false;

    const open = async (link: string) => {
      const target = parseDeepLink(link);
      if (target === null) return;
      cancelFocus();
      const route = pushRouteOf(target.sourceId, routeContext());
      if (route.kind === "unknown") {
        toast(tRef.current("mobile.push.unknownSource"));
        return;
      }
      if (route.kind === "switch") {
        switchConnectionFor(link, route.sourceId);
        return;
      }
      const state = useCanvasStore.getState();
      const sourceId = route.sourceId;
      if (
        state.workspace?.id !== target.workspaceId ||
        state.sourceId !== sourceId
      ) {
        // 先切当前源：列表、打开与事件流都跟着它走（同侧栏从别的源组里打开）。
        const registry = sourceRegistry();
        if (registry.current().descriptor.sourceId !== sourceId)
          registry.setCurrent(sourceId);
        const list = await runtimeApi.listWorkspaces().catch(() => null);
        const workspace = list?.find((item) => item.id === target.workspaceId);
        if (disposed || workspace === undefined) return;
        openRef.current(workspace, sourceId);
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
