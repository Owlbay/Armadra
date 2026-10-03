import * as React from "react";

import { usePreferencesStore, useT } from "../../../../app/preferences-store";
import type { IdentityDevicePage } from "../../../../api/identity";
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
import { Badge } from "@/ui/badge";
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

/**
 * 已配对设备（设计系统 §5.12）：名称 · 添加时间 · 权限 · 撤销。
 *
 * 和对外服务开没开无关：关掉监听不会让已经配过的设备失效，所以列表照样在，
 * 撤销也照样能做。撤销中那一行显示 Spinner，失败由调用方弹 sonner。
 */
export function GatewayDevices({
  devices,
  revoking,
  onRevoke,
}: {
  devices: readonly GatewayDevice[];
  /** 正在撤销的设备 id。 */
  revoking: string | null;
  onRevoke(device: GatewayDevice): void;
}) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const [confirm, setConfirm] = React.useState<GatewayDevice | null>(null);
  const trigger = React.useRef<HTMLButtonElement | null>(null);
  const date = React.useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );
  const active = devices.filter((device) => device.revokedAtMs === 0);
  if (active.length === 0) return null;

  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="px-0.5 text-[13px] font-medium">{t("gateway.devices")}</h3>
      <div className="rounded-lg border border-border/70 bg-card px-2">
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow>
              <TableHead>{t("gateway.devices.name")}</TableHead>
              <TableHead>{t("gateway.devices.added")}</TableHead>
              <TableHead>{t("gateway.devices.role")}</TableHead>
              <TableHead className="w-0">
                <span className="sr-only">{t("gateway.devices.revoke")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {active.map((device) => (
              <TableRow key={device.deviceId}>
                <TableCell className="max-w-[16rem] truncate font-medium">
                  {device.name || device.deviceId}
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {device.createdAtMs > 0
                    ? date.format(device.createdAtMs)
                    : "—"}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={device.role === "owner" ? "secondary" : "outline"}
                  >
                    {t(
                      device.role === "owner"
                        ? "gateway.devices.role.owner"
                        : "gateway.devices.role.member",
                    )}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  {revoking === device.deviceId ? (
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
          </TableBody>
        </Table>
      </div>
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent
          className="z-[var(--z-dialog)]"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (trigger.current?.isConnected) trigger.current.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("gateway.devices.confirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("gateway.devices.confirmNote")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="break-words text-[13px] font-medium">
            {confirm?.name || confirm?.deviceId}
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("gateway.devices.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const device = confirm;
                setConfirm(null);
                if (device) onRevoke(device);
              }}
            >
              {t("gateway.devices.revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
