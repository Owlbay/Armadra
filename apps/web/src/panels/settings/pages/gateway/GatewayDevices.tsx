import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { usePreferencesStore, useT } from "../../../../app/preferences-store";
import type { IdentityDevicePage } from "../../../../api/identity";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogDescription,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Badge } from "@/ui/badge";
import { Card } from "@/ui/card";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";

export type GatewayDevice = IdentityDevicePage["devices"][number];

export interface GatewayDevicesProps {
  devices: readonly GatewayDevice[];
  /** 正在撤销的设备 id。 */
  revoking: string | null;
  onRevoke(device: GatewayDevice): void;
  /** 这台设备自己的 id（有身份会话时）。 */
  currentDeviceId?: string | null;
  /** 没有管理权时撤销列不出现。 */
  canRevoke?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  onMore?(): void;
  /** 设备所属主体的来源名；没有中转来源时答 null，表不分组。 */
  originOf?(principalId: string): string | null;
}

/**
 * 已配对设备（设计系统 §5.12）：名称 · 平台 · 添加时间 · 最近访问 · 权限 · 撤销。
 * 平台与最近访问由 core 从会话里归出（契约 §18.4），没有会话的设备两格是「—」。
 *
 * 这一页唯一的一份设备表：对外服务配对的设备与「设备登录」配对的设备是同一
 * 张身份表，以前两处各画一份，现在只在这里画（G3-11）。当前这台带「当前」，
 * 不止一页时底部「加载更多」。
 *
 * 和对外服务开没开无关：关掉监听不会让已经配过的设备失效，所以列表照样在，
 * 撤销也照样能做。撤销中那一行显示 Spinner，失败由调用方弹 sonner。
 */
export function GatewayDevices({
  devices,
  revoking,
  onRevoke,
  currentDeviceId = null,
  canRevoke = true,
  hasMore = false,
  loadingMore = false,
  onMore,
  originOf,
}: GatewayDevicesProps) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const [confirm, setConfirm] = React.useState<GatewayDevice | null>(null);
  const trigger = React.useRef<HTMLButtonElement | null>(null);
  const date = React.useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );
  const dateTime = React.useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [locale],
  );
  const [folded, setFolded] = React.useState<ReadonlySet<string>>(new Set());
  const active = devices.filter((device) => device.revokedAtMs === 0);
  if (active.length === 0) return null;
  const groups: { origin: string | null; devices: GatewayDevice[] }[] = [];
  for (const device of active) {
    const origin = originOf?.(device.principalId) ?? null;
    const group = groups.find((one) => one.origin === origin);
    if (group) group.devices.push(device);
    else groups.push({ origin, devices: [device] });
  }
  const grouped = groups.some((group) => group.origin !== null);

  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="px-0.5 text-[13px] font-medium">{t("gateway.devices")}</h3>
      <Card className="gap-0 overflow-visible rounded-lg border border-border/70 py-0 text-[length:inherit] ring-0 px-2">
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow>
              <TableHead>{t("gateway.devices.name")}</TableHead>
              <TableHead>{t("gateway.devices.platform")}</TableHead>
              <TableHead>{t("gateway.devices.added")}</TableHead>
              <TableHead>{t("gateway.devices.lastSeen")}</TableHead>
              <TableHead>{t("gateway.devices.role")}</TableHead>
              <TableHead className="w-0">
                <span className="sr-only">{t("gateway.devices.revoke")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) => (
              <React.Fragment key={group.origin ?? ""}>
                {grouped && group.origin !== null && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="-ml-2 gap-1 text-[12px] text-muted-foreground"
                        aria-expanded={!folded.has(group.origin)}
                        onClick={() =>
                          setFolded((previous) => {
                            const next = new Set(previous);
                            const origin = group.origin as string;
                            if (!next.delete(origin)) next.add(origin);
                            return next;
                          })
                        }
                      >
                        {folded.has(group.origin) ? (
                          <ChevronRight />
                        ) : (
                          <ChevronDown />
                        )}
                        {group.origin} · {group.devices.length}
                      </Button>
                    </TableCell>
                  </TableRow>
                )}
                {!(group.origin !== null && folded.has(group.origin)) &&
                  group.devices.map((device) => (
                    <TableRow key={device.deviceId}>
                      <TableCell className="max-w-[16rem] truncate font-medium">
                        {device.name || device.deviceId}
                        {device.deviceId === currentDeviceId && (
                          <Badge variant="secondary" className="ml-2">
                            {t("gateway.devices.current")}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {device.platform
                          ? t(`gateway.devices.platform.${device.platform}`)
                          : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {device.createdAtMs > 0
                          ? date.format(device.createdAtMs)
                          : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {device.lastSeenAtMs !== undefined &&
                        device.lastSeenAtMs > 0
                          ? dateTime.format(device.lastSeenAtMs)
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            device.role === "owner" ? "secondary" : "outline"
                          }
                        >
                          {t(
                            device.role === "owner"
                              ? "gateway.devices.role.owner"
                              : "gateway.devices.role.member",
                          )}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {!canRevoke ? null : revoking === device.deviceId ? (
                          <Spinner
                            className="ml-auto"
                            aria-label={t("gateway.devices.revoke")}
                          />
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            disabled={revoking !== null}
                            aria-label={t("gateway.devices.revokeNamed", {
                              name: device.name || device.deviceId,
                            })}
                            onClick={(event) => {
                              trigger.current = event.currentTarget;
                              setConfirm(device);
                            }}
                          >
                            {t("gateway.devices.revoke")}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
              </React.Fragment>
            ))}
          </TableBody>
        </Table>
      </Card>
      {hasMore && onMore && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          disabled={loadingMore}
          onClick={onMore}
        >
          {loadingMore && <Spinner role="presentation" aria-hidden />}
          {t("gateway.devices.more")}
        </Button>
      )}
      <ResponsiveAlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <ResponsiveAlertDialogContent
          className="z-[var(--z-dialog)]"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (trigger.current?.isConnected) trigger.current.focus();
          }}
        >
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("gateway.devices.confirmTitle")}
            </ResponsiveAlertDialogTitle>
            <ResponsiveAlertDialogDescription>
              {t("gateway.devices.confirmNote")}
            </ResponsiveAlertDialogDescription>
          </ResponsiveAlertDialogHeader>
          <p className="break-words text-[13px] font-medium">
            {confirm?.name || confirm?.deviceId}
          </p>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("gateway.devices.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              variant="destructive"
              onClick={() => {
                const device = confirm;
                setConfirm(null);
                if (device) onRevoke(device);
              }}
            >
              {t("gateway.devices.revoke")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </section>
  );
}
