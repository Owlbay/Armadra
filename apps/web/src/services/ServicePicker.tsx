import * as React from "react";
import { ExternalLink, Pencil, Trash2 } from "lucide-react";

import { useT } from "../app/preferences-store";
import { formatRelativeTime } from "../lib/format";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Alert, AlertTitle } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/ui/empty";
import { IconButton } from "@/ui/icon-button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/ui/item";
import { Spinner } from "@/ui/spinner";
import { StatusPill, type StatusTone } from "@/ui/status-pill";
import type { ServiceStatus } from "./probe";
import { RenameDialog } from "./RenameDialog";
import { type ServiceGroup, type ServiceRow, layoutServices } from "./rows";

/** 挂在某一行下方的失败（进入失败、需要重新登录）。 */
export interface ServiceRowFailure {
  readonly sourceId: string;
  readonly message: string;
  readonly action?: { readonly label: string; readonly run: () => void };
}

export interface ServicePickerProps {
  /**
   * `page`：原生 App 与中继托管页面的整页，点一行即进入，行尾移除。
   * `dialog`：桌面「切换服务」对话框，行尾「切换」与「在新窗口打开」。
   */
  readonly variant: "page" | "dialog";
  readonly rows: readonly ServiceRow[];
  /** 最近使用的 `sourceId`（新的在前）。 */
  readonly recent?: readonly string[];
  readonly currentId?: string | undefined;
  readonly statuses?: Readonly<Record<string, ServiceStatus>>;
  /** 登录失效的远程服务（签发方）：组头显示「已登出」与「登录」。 */
  readonly signedOut?: readonly string[];
  readonly failure?: ServiceRowFailure | null;
  /** 正在进入的那一行（行尾转圈，整表不可点）。 */
  readonly busyId?: string | null;
  readonly disabled?: boolean;
  /** 离线的行点不了（目录答的在线状态是准的：中继托管页面）。 */
  readonly disableOffline?: boolean;
  readonly onEnter: (sourceId: string) => void;
  readonly onRemove?: (sourceId: string) => void;
  /** 桌面壳才给：在新窗口打开这个源。 */
  readonly onOpenWindow?: (sourceId: string) => void;
  readonly onSignIn?: (issuer: string) => void;
  /**
   * 给了才有「重命名」（契约 §61）：名字只存在这台设备上，空串 = 恢复缺省名。
   * 失败时抛，消息显示在对话框里。
   */
  readonly onRename?: (sourceId: string, label: string) => Promise<void> | void;
}

const STATUS_TONE: Record<ServiceStatus, StatusTone> = {
  online: "done",
  offline: "idle",
  unknown: "queued",
};

function ServiceStatusPill({ status }: { status: ServiceStatus }) {
  const t = useT();
  const label = t(`services.status.${status}`);
  return (
    <StatusPill
      data-service-status={status}
      tone={STATUS_TONE[status]}
      // 未知时只呼吸不写字；读屏仍读到「未知」。
      label={
        status === "unknown" ? <span className="sr-only">{label}</span> : label
      }
      pulse={status === "unknown"}
      className={status === "unknown" ? "px-1" : undefined}
    />
  );
}

function routeLine(
  row: ServiceRow,
  t: ReturnType<typeof useT>,
  now: number,
): string {
  const parts = row.routes.map((route) =>
    route.via === "direct"
      ? t("services.via.direct")
      : t("services.via.relay", { name: route.serviceName }),
  );
  if (row.lastUsedAt !== null)
    parts.push(formatRelativeTime(row.lastUsedAt, now));
  return parts.join(" · ");
}

function groupTitle(group: ServiceGroup, t: ReturnType<typeof useT>): string {
  if (group.kind === "local") return t("services.group.local");
  if (group.kind === "direct") return t("services.group.direct");
  return t("services.group.relay", { name: group.name });
}

const HEADING =
  "px-1 text-[length:var(--text-caption)] font-medium text-muted-foreground";

/**
 * 选择服务（A7-1，多端入口设计 §1.3）：原生 App 的整页、中继托管页面登录后
 * 那一步、桌面「切换服务」对话框，三处同一个列表。
 */
export function ServicePicker({
  variant,
  rows,
  recent = [],
  currentId,
  statuses = {},
  signedOut = [],
  failure = null,
  busyId = null,
  disabled = false,
  disableOffline = false,
  onEnter,
  onRemove,
  onOpenWindow,
  onSignIn,
  onRename,
}: ServicePickerProps) {
  const t = useT();
  const [removing, setRemoving] = React.useState<ServiceRow | null>(null);
  const [renaming, setRenaming] = React.useState<ServiceRow | null>(null);
  const layout = React.useMemo(
    () => layoutServices(rows, recent),
    [rows, recent],
  );
  const now = Date.now();
  const locked = disabled || busyId !== null;

  if (rows.length === 0) {
    return (
      <Empty data-slot="service-picker" className="py-8">
        <EmptyHeader>
          <EmptyTitle>{t("services.empty")}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  const renderRow = (row: ServiceRow, section: string) => {
    const current = row.sourceId === currentId;
    const status = statuses[row.sourceId] ?? "unknown";
    const line = routeLine(row, t, now);
    const rowFailure = failure?.sourceId === row.sourceId ? failure : null;
    const content = (
      <>
        <ItemContent className="min-w-0">
          <ItemTitle className="max-w-full truncate">{row.name}</ItemTitle>
          {line !== "" && (
            <ItemDescription className="truncate text-[length:var(--text-caption)]">
              {line}
            </ItemDescription>
          )}
        </ItemContent>
        {current && (
          <Badge variant="outline">{t("mobileConnect.current")}</Badge>
        )}
        {!row.local && <ServiceStatusPill status={status} />}
        {busyId === row.sourceId && (
          <Spinner aria-label={t("remote.status.connecting")} />
        )}
      </>
    );
    return (
      <div
        role="listitem"
        key={`${section}:${row.sourceId}`}
        className="flex flex-col gap-2"
      >
        <Item
          variant="outline"
          data-service-row={row.sourceId}
          aria-current={current || undefined}
          className="flex-nowrap p-0"
        >
          {variant === "page" ? (
            <Button
              type="button"
              variant="ghost"
              disabled={locked || (disableOffline && status === "offline")}
              className="h-auto min-h-12 min-w-0 flex-1 justify-start gap-2.5 rounded-lg px-3 py-2 text-left font-normal whitespace-normal"
              onClick={() => onEnter(row.sourceId)}
            >
              {content}
            </Button>
          ) : (
            <div className="flex min-h-12 min-w-0 flex-1 items-center gap-2.5 px-3 py-2">
              {content}
            </div>
          )}
          <ItemActions className="gap-1 pr-2">
            {onRename &&
              (variant === "page" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-11"
                  disabled={locked}
                  aria-label={t("services.renameRow", { name: row.name })}
                  onClick={() => setRenaming(row)}
                >
                  <Pencil />
                </Button>
              ) : (
                <IconButton
                  size="cluster"
                  label={t("services.renameRow", { name: row.name })}
                  disabled={locked}
                  onClick={() => setRenaming(row)}
                >
                  <Pencil />
                </IconButton>
              ))}
            {variant === "dialog" && !current && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={locked}
                onClick={() => onEnter(row.sourceId)}
              >
                {t("services.select")}
              </Button>
            )}
            {variant === "dialog" && onOpenWindow && !row.local && (
              <IconButton
                size="cluster"
                label={t("services.openWindow")}
                disabled={locked}
                onClick={() => onOpenWindow(row.sourceId)}
              >
                <ExternalLink />
              </IconButton>
            )}
            {variant === "page" && onRemove && !row.local && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-11"
                disabled={locked}
                aria-label={t("mobileConnect.remove", { name: row.name })}
                onClick={() => setRemoving(row)}
              >
                <Trash2 />
              </Button>
            )}
          </ItemActions>
        </Item>
        {rowFailure && (
          <Alert variant="destructive" data-service-failure={row.sourceId}>
            <AlertTitle>{rowFailure.message}</AlertTitle>
            {rowFailure.action && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="col-start-2 mt-2 w-fit"
                onClick={rowFailure.action.run}
              >
                {rowFailure.action.label}
              </Button>
            )}
          </Alert>
        )}
      </div>
    );
  };

  const showGroupHeads = layout.groups.length > 1 || variant === "dialog";

  return (
    <div data-slot="service-picker" className="flex flex-col gap-4">
      {layout.recent.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className={HEADING}>{t("services.recent")}</h2>
          <ItemGroup className="gap-2">
            {layout.recent.map((row) => renderRow(row, "recent"))}
          </ItemGroup>
        </section>
      )}
      {layout.recent.length > 0 && (
        <h2 className={`${HEADING} -mb-2`}>{t("services.all")}</h2>
      )}
      {layout.groups.map((group) => {
        const out = group.kind === "relay" && signedOut.includes(group.issuer);
        return (
          <section
            key={group.key}
            data-service-group={group.key}
            className="flex flex-col gap-2"
          >
            {(showGroupHeads || out) && (
              <div className="flex min-h-6 items-center gap-2">
                <h3 className={`${HEADING} min-w-0 flex-1 truncate`}>
                  {groupTitle(group, t)}
                </h3>
                {out && (
                  <>
                    <Badge variant="outline">{t("remote.signedOut")}</Badge>
                    {onSignIn && (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={locked}
                        onClick={() => onSignIn(group.issuer)}
                      >
                        {t("remote.signIn")}
                      </Button>
                    )}
                  </>
                )}
              </div>
            )}
            <ItemGroup className="gap-2">
              {group.rows.map((row) => renderRow(row, group.key))}
            </ItemGroup>
          </section>
        );
      })}
      {onRename && (
        <RenameDialog
          target={renaming}
          onClose={() => setRenaming(null)}
          onSave={async (label) => {
            if (renaming) await onRename(renaming.sourceId, label);
          }}
        />
      )}
      <ResponsiveAlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <ResponsiveAlertDialogContent>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("mobileConnect.removeTitle", { name: removing?.name ?? "" })}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("mobileConnect.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing) onRemove?.(removing.sourceId);
                setRemoving(null);
              }}
            >
              {t("mobileConnect.removeConfirm")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </div>
  );
}
