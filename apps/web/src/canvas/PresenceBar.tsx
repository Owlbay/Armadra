import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import { runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";
import { noDragProps } from "@/shell/window-region";
import { useCanvasStore } from "@/store/canvas-store";
import {
  applyPresence,
  currentPresence,
  isRealtimeBoard,
  isReadOnly,
  leaseOnThisDevice,
  presenceClientId,
  presenceDeviceName,
} from "@/store/canvas/presence";
import type { Peer } from "@/realtime/awareness";
import { useRealtimeStore } from "@/realtime/session";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { cn } from "@/lib/cn";
import { Avatar, AvatarFallback } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { ColorDot } from "@/ui/color-dot";
import { memberColorVar } from "@/ui/member-dot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

/**
 * 画布右上、工具簇左边的在线设备条（core JSON §9）。
 *
 * **只有自己时什么都不画**：单设备、单窗口是最常见的用法，那时这里一个像素
 * 都不占。有别的设备在看时每台一个小圆点，持有写租约的那台是主色；租约在
 * 别人手里时多一句「某设备正在编辑」和一个「接管」，接管要二次确认。
 * 持有者是同一台设备上的另一个窗口时说「本机另一个窗口正在编辑」，接管不再
 * 确认——那是同一个人，没有谁的改动需要替别人担心。
 * 这个人对这块工作空间没有写权限（服务器壳上的只读共享）时，哪怕只有自己
 * 也要画出来，写一句「只读」，不给「接管」——接管了也存不进去。
 */

/** 工具簇 14px 边距 + 38px 宽 + 8px 间距。 */
const RIGHT_OFFSET = "right-[60px]";

/**
 * 设备条画不画。顶部通知条与它同在标题带里，要按它让位（`shell/Banners`）；
 * 判据与下面的提前返回逐字一致。
 */
export function usePresenceBarVisible(): boolean {
  const presence = useCanvasStore(currentPresence);
  const realtime = useCanvasStore(isRealtimeBoard);
  const peers = useRealtimeStore((view) => view.peers.length);
  const readOnly = useCanvasStore(isReadOnly);
  if (realtime) return peers > 0 || readOnly;
  if (!presence) return false;
  const me = presenceClientId();
  return (
    presence.writable === false ||
    presence.clients.some((client) => client.clientId !== me)
  );
}

export function PresenceBar() {
  const realtime = useCanvasStore(isRealtimeBoard);
  return realtime ? <RealtimePresence /> : <LeasePresence />;
}

/** 头像堆叠里最多画几个（含自己），其余收成「+N」（设计系统 §5.6）。 */
export const MAX_AVATARS = 4;

const BAR_CLASS = `absolute top-[14px] ${RIGHT_OFFSET} z-[var(--z-cluster)] flex h-[38px] items-center gap-2 rounded-[var(--r-card)] border border-border bg-[var(--panel)]/90 px-2.5 shadow-[var(--shadow-pill)] backdrop-blur-[12px]`;

function initialOf(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toUpperCase() : "·";
}

/**
 * 实时板（补全架构 §6.4）：在线表来自 awareness，不再有租约与「接管」。
 * 头像堆叠，自己在最前（成员色 1），别人按 awareness 的颜色；点别人的头像
 * 跟随他的光标，再点取消。断线时头像置灰、写「已断开」；只读写「只读」。
 */
function RealtimePresence() {
  const peers = useRealtimeStore((view) => view.peers);
  const status = useRealtimeStore((view) => view.status);
  const following = useRealtimeStore((view) => view.following);
  const follow = useRealtimeStore((view) => view.follow);
  const readOnly = useCanvasStore(isReadOnly);
  if (peers.length === 0 && !readOnly) return null;
  return (
    <RealtimePresenceView
      peers={peers}
      offline={status === "offline"}
      readOnly={readOnly}
      following={following}
      onFollow={follow}
    />
  );
}

export interface RealtimePresenceViewProps {
  peers: readonly Peer[];
  offline: boolean;
  readOnly: boolean;
  following: number | null;
  onFollow: (clientId: number | null) => void;
  /** 缺省浮在画布右上；展示页里传 `relative` 一类的类名放进文档流。 */
  className?: string;
}

/** 在线条本体：不读任何 store，展示页与上面的实时条共用。 */
export function RealtimePresenceView({
  peers,
  offline,
  readOnly,
  following,
  onFollow: follow,
  className,
}: RealtimePresenceViewProps) {
  const t = useT();
  const visible = peers.slice(0, MAX_AVATARS - 1);
  const hidden = peers.length - visible.length;
  const nameOf = (peer: Peer) =>
    peer.state.name === "" ? t("presence.unnamed") : peer.state.name;

  return (
    <div
      data-slot="presence-bar"
      data-mode="realtime"
      data-offline={offline ? "true" : undefined}
      {...noDragProps()}
      aria-label={t("realtime.presence.label")}
      className={cn(BAR_CLASS, className)}
    >
      <div
        className={`flex items-center -space-x-1 ${offline ? "opacity-50 grayscale" : ""}`}
      >
        <MemberAvatar
          color={memberColorVar(1)}
          label={t("realtime.presence.self")}
        />
        {visible.map((peer) => {
          const name = nameOf(peer);
          const followed = following === peer.clientId;
          return (
            <Tooltip key={peer.clientId} delayDuration={300}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  data-peer={peer.clientId}
                  aria-pressed={followed}
                  aria-label={
                    followed
                      ? `${t("realtime.unfollow")} ${name}`
                      : `${t("realtime.follow")} ${name}`
                  }
                  className="rounded-[var(--r-pill)] p-0 hover:bg-transparent"
                  onClick={() => follow(followed ? null : peer.clientId)}
                >
                  <MemberAvatar
                    color={
                      followed
                        ? "var(--brand)"
                        : memberColorVar(peer.state.color)
                    }
                    label={name}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {followed ? t("realtime.unfollow") : name}
              </TooltipContent>
            </Tooltip>
          );
        })}
        {hidden > 0 && (
          <span
            aria-label={t("realtime.presence.more", { count: hidden })}
            className="ml-2 text-[length:var(--text-caption)] text-muted-foreground tabular-nums"
          >
            +{hidden}
          </span>
        )}
      </div>
      {offline ? (
        <span className="text-xs whitespace-nowrap text-muted-foreground">
          {t("realtime.disconnected")}
        </span>
      ) : null}
      {readOnly ? (
        <Badge variant="outline">{t("realtime.readOnly")}</Badge>
      ) : null}
    </div>
  );
}

/** 20px 头像：首字 + 2px 成员色环。 */
function MemberAvatar({ color, label }: { color: string; label: string }) {
  return (
    <Avatar
      size="sm"
      aria-label={label}
      className="size-5 after:hidden data-[size=sm]:size-5"
      style={{ boxShadow: `0 0 0 2px ${color}` }}
    >
      <AvatarFallback className="bg-card text-[length:var(--text-caption)] font-medium text-foreground">
        {initialOf(label)}
      </AvatarFallback>
    </Avatar>
  );
}

/** 租约模式（非实时板，core JSON §9）：设备点、租约持有者与「接管」。 */
function LeasePresence() {
  const t = useT();
  const queryClient = useQueryClient();
  const presence = useCanvasStore(currentPresence);
  const readOnly = useCanvasStore(isReadOnly);
  const sameDevice = useCanvasStore(leaseOnThisDevice);
  const workspaceId = useCanvasStore((state) => state.workspace?.id);
  const [confirming, setConfirming] = React.useState(false);
  const me = presenceClientId();

  const others = presence?.clients.filter((client) => client.clientId !== me);
  const denied = presence?.writable === false;
  if (!presence || !others || (others.length === 0 && !denied)) return null;

  const lease = presence.lease;
  const nameOf = (deviceName: string) =>
    deviceName === "" ? t("presence.unnamed") : deviceName;
  const holder = lease ? nameOf(lease.deviceName) : "";
  const selfKey = presence.deviceKey ?? "";
  const self = presence.clients.find((client) => client.clientId === me);
  const clients = self ? [self, ...others] : others;

  const takeOver = () => {
    if (!workspaceId) return;
    void runtimeApi
      .acquireLease(workspaceId, presence.boardId, {
        clientId: me,
        deviceName: presenceDeviceName(),
        takeover: true,
      })
      .then((snapshot) => {
        // 拿到租约的这一刻按远端重载：只读期间手里那份可能落后。
        if (applyPresence(snapshot).gained) {
          void queryClient.invalidateQueries({
            queryKey: ["board", workspaceId],
          });
        }
      })
      .catch(() => undefined);
  };

  return (
    <>
      <div
        data-slot="presence-bar"
        {...noDragProps()}
        aria-label={t("presence.label")}
        className={BAR_CLASS}
      >
        <div className="flex items-center gap-1.5">
          {clients.map((client) => {
            const editing = lease?.clientId === client.clientId;
            const label =
              client.clientId === me
                ? t("presence.thisDevice")
                : selfKey !== "" && client.deviceKey === selfKey
                  ? t("presence.otherWindow")
                  : nameOf(client.deviceName);
            return (
              <Tooltip key={client.clientId} delayDuration={300}>
                <TooltipTrigger asChild>
                  <span className="inline-flex p-0.5" aria-label={label}>
                    <ColorDot
                      size={8}
                      color={
                        editing ? "var(--primary)" : "var(--muted-foreground)"
                      }
                      selected={editing}
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {editing ? t("presence.editing", { device: label }) : label}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        {denied ? (
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {t("presence.readOnly")}
          </span>
        ) : readOnly && lease ? (
          <>
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {sameDevice
                ? t("presence.otherWindowEditing")
                : t("presence.editing", { device: holder })}
            </span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => (sameDevice ? takeOver() : setConfirming(true))}
            >
              {t("presence.takeover")}
            </Button>
          </>
        ) : null}
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("presence.takeoverTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("presence.takeoverDescription", { device: holder })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("delete.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={takeOver}>
              {t("presence.takeover")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
