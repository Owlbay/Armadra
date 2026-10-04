import * as React from "react";
import { createPortal } from "react-dom";
import { useReactFlow, useStore } from "@xyflow/react";
import { MousePointer2 } from "lucide-react";
import type { CanvasNode } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { nodeBox, type Box } from "@/canvas/geometry";
import { isItemId, toItemId, type Item } from "@/canvas/whiteboard/model";
import { useCanvasStore } from "@/store/canvas-store";
import { memberColorVar } from "@/ui/member-dot";
import type { Peer } from "./awareness";
import {
  broadcastCursor,
  broadcastViewport,
  useRealtimeStore,
} from "./session";
import { followTarget, viewportCenter } from "./viewport";

/**
 * 成员光标与选区外框（设计系统 §4、§5.6；补全架构 §6.4）。
 *
 * 挂在 React Flow 的 `<ViewportPortal>` 里：坐标是画布坐标，相机变换由它
 * 做。光标与标签按 `1 / zoom` 反缩放，屏幕上永远是 16px 箭头 + 11px 标签；
 * 位置变化 120ms 线性插值（减少动效时 tokens 把时长压到 0），人走了或指针
 * 离开画布后原地 5 秒淡出。选区是节点（或白板对象的包围盒）外 1.5px 成员色
 * 虚线，多人选同一个对象时一圈套一圈、各偏 2px。
 *
 * 同时负责把自己的指针位置与视口写进 awareness（节流在 `awareness.ts`），
 * 以及跟随：对方报了视口就让自己的视口中心与缩放对上它（120ms 插值），没报
 * 就退回跟它的光标；跟随中画布四周描一圈对方的成员色。
 */

/** 跟随时相机过渡的时长。 */
export const FOLLOW_DURATION_MS = 120;

/** 人走了之后光标留多久（淡出时长）。 */
export const CURSOR_FADE_MS = 5_000;

interface Shown {
  peer: Peer;
  cursor: { x: number; y: number };
  leaving: boolean;
}

/** 上一份光标表 + 这一份在场者 → 这一帧要画的（含正在淡出的）。 */
export function nextCursors(
  previous: ReadonlyMap<number, Shown>,
  peers: readonly Peer[],
): Map<number, Shown> {
  const next = new Map<number, Shown>();
  for (const peer of peers) {
    const cursor = peer.state.cursor;
    if (cursor) {
      next.set(peer.clientId, { peer, cursor, leaving: false });
      continue;
    }
    const before = previous.get(peer.clientId);
    if (before) next.set(peer.clientId, { ...before, peer, leaving: true });
  }
  for (const [clientId, shown] of previous) {
    if (next.has(clientId)) continue;
    next.set(clientId, { ...shown, leaving: true });
  }
  return next;
}

const NO_PEERS: Peer[] = [];

export function CursorLayer() {
  const active = useRealtimeStore((view) => view.boardId !== null);
  if (!active) return null;
  return <Cursors />;
}

function Cursors() {
  const t = useT();
  const allPeers = useRealtimeStore((view) => view.peers);
  const offline = useRealtimeStore((view) => view.status !== "online");
  // 断线时别人的光标与选区都是旧的：淡出，重连后再画（在线条照样列人）。
  const peers = offline ? NO_PEERS : allPeers;
  const following = useRealtimeStore((view) => view.following);
  const follow = useRealtimeStore((view) => view.follow);
  const zoom = useStore((state) => state.transform[2]);
  const nodes = useCanvasStore((state) => state.document?.nodes);
  const items = useCanvasStore((state) => state.whiteboard.items);
  const flow = useReactFlow();
  const panX = useStore((state) => state.transform[0]);
  const panY = useStore((state) => state.transform[1]);
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);

  const [shown, setShown] = React.useState<Map<number, Shown>>(new Map());
  React.useEffect(() => {
    setShown((previous) => nextCursors(previous, peers));
  }, [peers]);

  // 淡出的那些 5 秒后摘掉。
  const leavingKey = [...shown.values()]
    .filter((entry) => entry.leaving)
    .map((entry) => entry.peer.clientId)
    .join(",");
  React.useEffect(() => {
    if (leavingKey === "") return;
    const timer = window.setTimeout(() => {
      setShown((current) => {
        const next = new Map(current);
        for (const [id, entry] of current) if (entry.leaving) next.delete(id);
        return next;
      });
    }, CURSOR_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [leavingKey]);

  // 自己的指针 → awareness。
  const domNode = useStore((state) => state.domNode);
  React.useEffect(() => {
    const target = domNode;
    if (!target) return;
    const move = (event: PointerEvent) => {
      broadcastCursor(
        flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      );
    };
    const leave = () => broadcastCursor(null);
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerleave", leave);
    return () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerleave", leave);
      broadcastCursor(null);
    };
  }, [domNode, flow]);

  // 自己的视口 → awareness（中心的画布坐标 + 缩放）。
  React.useEffect(() => {
    const center = viewportCenter(
      { x: panX, y: panY, zoom },
      { width, height },
    );
    if (center) broadcastViewport(center);
  }, [panX, panY, zoom, width, height]);
  React.useEffect(() => () => broadcastViewport(null), []);

  // 跟随：对方的视口（没报就是光标）变了，相机跟过去；人走了就停。
  const followed = allPeers.find((peer) => peer.clientId === following);
  const target = followTarget(followed);
  const targetKind = target?.kind;
  const targetX = target?.x;
  const targetY = target?.y;
  const targetZoom = target?.kind === "viewport" ? target.zoom : undefined;
  React.useEffect(() => {
    if (following === null) return;
    if (!allPeers.some((peer) => peer.clientId === following)) {
      follow(null);
      return;
    }
    if (targetX === undefined || targetY === undefined) return;
    void flow.setCenter(targetX, targetY, {
      zoom: targetKind === "viewport" ? targetZoom : flow.getZoom(),
      duration: FOLLOW_DURATION_MS,
    });
  }, [
    allPeers,
    flow,
    follow,
    following,
    targetKind,
    targetX,
    targetY,
    targetZoom,
  ]);

  const scale = zoom > 0 ? 1 / zoom : 1;

  return (
    <div
      data-slot="cursor-layer"
      aria-label={t("realtime.cursors")}
      className="pointer-events-none absolute top-0 left-0"
      style={{ zIndex: "var(--z-canvas-overlay)" }}
    >
      <Selections
        peers={peers}
        nodes={nodes ?? []}
        items={items}
        scale={scale}
      />
      {[...shown.values()].map((entry) => (
        <PeerCursor
          key={entry.peer.clientId}
          color={memberColorVar(entry.peer.state.color)}
          name={entry.peer.state.name}
          x={entry.cursor.x}
          y={entry.cursor.y}
          scale={scale}
          leaving={entry.leaving}
        />
      ))}
      {followed &&
        domNode &&
        createPortal(
          <FollowFrame color={memberColorVar(followed.state.color)} />,
          domNode,
        )}
    </div>
  );
}

/** 跟随中：画布四周一圈 2px 对方的成员色（屏幕坐标，不随相机缩放）。 */
export function FollowFrame({ color }: { color: string }) {
  return (
    <div
      data-slot="follow-frame"
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{
        boxShadow: `inset 0 0 0 2px ${color}`,
        zIndex: "var(--z-canvas-overlay)",
      }}
    />
  );
}

/** 他人光标：16px 箭头成员色 + 右下名字标签（设计系统 §4）。 */
export function PeerCursor({
  color,
  name,
  x,
  y,
  scale = 1,
  leaving = false,
}: {
  color: string;
  name: string;
  x: number;
  y: number;
  scale?: number;
  leaving?: boolean;
}) {
  return (
    <div
      data-peer-cursor
      data-leaving={leaving ? "true" : undefined}
      className="absolute top-0 left-0 flex origin-top-left items-start"
      style={{
        transform: `translate(${x}px, ${y}px) scale(${scale})`,
        opacity: leaving ? 0 : 1,
        transition: leaving
          ? `opacity ${CURSOR_FADE_MS}ms linear`
          : "transform var(--dur-fast) linear",
      }}
    >
      <MousePointer2
        aria-hidden
        className="size-4"
        style={{ color, fill: color }}
        strokeWidth={1.5}
      />
      {name !== "" && (
        <span
          className="mt-3 rounded-[var(--r-pill)] border bg-card px-1.5 text-[length:var(--text-caption)] leading-4 whitespace-nowrap text-foreground"
          style={{ borderColor: color }}
        >
          {name}
        </span>
      )}
    </div>
  );
}

/** 白板对象在画布上的绝对包围盒（`parentId` 指向 Frame 时相对那个 Frame）。 */
export function itemBox(nodes: readonly CanvasNode[], item: Item): Box {
  let x = item.x;
  let y = item.y;
  if (item.parentId) {
    const parent = nodes.find((node) => node.id === item.parentId);
    if (parent) {
      const base = nodeBox(nodes, parent);
      x += base.x;
      y += base.y;
    }
  }
  return { x, y, width: item.w, height: item.h };
}

/**
 * 他人的选区：节点外 1.5px 虚线成员色；白板对象（`wb:`）按 item 的包围盒画；
 * 同一个对象上多人一圈套一圈。
 */
function Selections({
  peers,
  nodes,
  items,
  scale,
}: {
  peers: readonly Peer[];
  nodes: readonly CanvasNode[];
  items: readonly Item[];
  scale: number;
}) {
  const byId = React.useMemo(
    () => new Map(nodes.map((node) => [node.id, node] as const)),
    [nodes],
  );
  const itemsById = React.useMemo(
    () => new Map(items.map((item) => [toItemId(item.id), item] as const)),
    [items],
  );
  const rings: {
    key: string;
    id: string;
    color: string;
    ring: number;
    box: Box;
  }[] = [];
  const depth = new Map<string, number>();
  for (const peer of peers) {
    for (const id of peer.state.selection ?? []) {
      let box: Box | null = null;
      if (isItemId(id)) {
        const item = itemsById.get(id);
        if (item) box = itemBox(nodes, item);
      } else {
        const node = byId.get(id);
        if (node) box = nodeBox(nodes, node);
      }
      if (!box) continue;
      const ring = depth.get(id) ?? 0;
      depth.set(id, ring + 1);
      rings.push({
        key: `${peer.clientId}:${id}`,
        id,
        color: memberColorVar(peer.state.color),
        ring,
        box,
      });
    }
  }
  return (
    <>
      {rings.map(({ key, id, color, ring, box }) => {
        const offset = (2 + ring * 2) * scale;
        const width = 1.5 * scale;
        return (
          <div
            key={key}
            data-peer-selection={id}
            className="absolute rounded-[var(--r-card)]"
            style={{
              left: box.x - offset,
              top: box.y - offset,
              width: box.width + offset * 2,
              height: box.height + offset * 2,
              border: `${width}px dashed ${color}`,
            }}
          />
        );
      })}
    </>
  );
}
