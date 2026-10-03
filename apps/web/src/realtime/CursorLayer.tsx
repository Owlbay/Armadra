import * as React from "react";
import { useReactFlow, useStore } from "@xyflow/react";
import { MousePointer2 } from "lucide-react";
import type { CanvasNode } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { nodeBox } from "@/canvas/geometry";
import { useCanvasStore } from "@/store/canvas-store";
import { memberColorVar } from "@/ui/member-dot";
import type { Peer } from "./awareness";
import { broadcastCursor, useRealtimeStore } from "./session";

/**
 * 成员光标与选区外框（设计系统 §4、§5.6；补全架构 §6.4）。
 *
 * 挂在 React Flow 的 `<ViewportPortal>` 里：坐标是画布坐标，相机变换由它
 * 做。光标与标签按 `1 / zoom` 反缩放，屏幕上永远是 16px 箭头 + 11px 标签；
 * 位置变化 120ms 线性插值（减少动效时 tokens 把时长压到 0），人走了或指针
 * 离开画布后原地 5 秒淡出。选区是节点外 1.5px 成员色虚线，多人选同一个节点
 * 时一圈套一圈、各偏 2px。
 *
 * 同时负责把自己的指针位置写进 awareness（节流在 `awareness.ts`）。
 */

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
  const flow = useReactFlow();

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

  // 跟随：相机跟着那个人的光标走；人走了就停。
  const followed = allPeers.find((peer) => peer.clientId === following);
  const followX = followed?.state.cursor?.x;
  const followY = followed?.state.cursor?.y;
  React.useEffect(() => {
    if (following === null) return;
    if (!allPeers.some((peer) => peer.clientId === following)) {
      follow(null);
      return;
    }
    if (followX === undefined || followY === undefined) return;
    void flow.setCenter(followX, followY, {
      zoom: flow.getZoom(),
      duration: 120,
    });
  }, [allPeers, flow, follow, followX, followY, following]);

  const scale = zoom > 0 ? 1 / zoom : 1;

  return (
    <div
      data-slot="cursor-layer"
      aria-label={t("realtime.cursors")}
      className="pointer-events-none absolute top-0 left-0"
      style={{ zIndex: "var(--z-canvas-overlay)" }}
    >
      <Selections peers={peers} nodes={nodes ?? []} scale={scale} />
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
    </div>
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
          className="mt-3 rounded-[var(--r-pill)] border bg-card px-1.5 text-[length:var(--text-caption)] leading-4 whitespace-nowrap text-foreground shadow-[var(--shadow-overlay)]"
          style={{ borderColor: color }}
        >
          {name}
        </span>
      )}
    </div>
  );
}

/** 他人的选区：节点外 1.5px 虚线成员色；同一个节点上多人一圈套一圈。 */
function Selections({
  peers,
  nodes,
  scale,
}: {
  peers: readonly Peer[];
  nodes: readonly CanvasNode[];
  scale: number;
}) {
  const byId = React.useMemo(
    () => new Map(nodes.map((node) => [node.id, node] as const)),
    [nodes],
  );
  const rings: {
    key: string;
    color: string;
    ring: number;
    node: CanvasNode;
  }[] = [];
  const depth = new Map<string, number>();
  for (const peer of peers) {
    for (const id of peer.state.selection ?? []) {
      const node = byId.get(id);
      if (!node) continue;
      const ring = depth.get(id) ?? 0;
      depth.set(id, ring + 1);
      rings.push({
        key: `${peer.clientId}:${id}`,
        color: memberColorVar(peer.state.color),
        ring,
        node,
      });
    }
  }
  return (
    <>
      {rings.map(({ key, color, ring, node }) => {
        const box = nodeBox(nodes, node);
        const offset = (2 + ring * 2) * scale;
        const width = 1.5 * scale;
        return (
          <div
            key={key}
            data-peer-selection={node.id}
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
