import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Link2Off } from "lucide-react";
import { toast } from "sonner";

import { SHARE_ROLES, type ShareRole } from "../../api/accounts";
import {
  type RemoteService,
  createShareLink,
  listShareLinks,
  revokeShareLink,
  shareStatus,
  shareThisMachine,
  stopSharing,
} from "../../api/remote-services";
import { usePreferencesStore, useT } from "../../app/preferences-store";
import { useWorkspacesQuery } from "../../app/workspaces-query";
import { useCanvasStore } from "../../store/canvas-store";
import { QrImage } from "./pages/gateway/PairingCard";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Button } from "@/ui/button";
import { Field, FieldLabel } from "@/ui/field";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Separator } from "@/ui/separator";
import { Spinner } from "@/ui/spinner";
import { StatusPill, type StatusTone } from "@/ui/status-pill";

/** 隧道状态 → 胶囊色调与文案（协议包 `tunnelStatusSchema`）。 */
export function tunnelPill(state: string): { tone: StatusTone; key: string } {
  switch (state) {
    case "ready":
      return { tone: "done", key: "remote.status.ready" };
    case "connecting":
    case "authenticating":
      return { tone: "working", key: "remote.status.connecting" };
    case "backoff":
      return { tone: "attention", key: "remote.status.backoff" };
    case "draining":
      return { tone: "paused", key: "remote.status.draining" };
    default:
      return { tone: "idle", key: "remote.status.disabled" };
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_DAYS = [1, 7, 30] as const;

export const SHARE_STATUS_KEY = ["identity", "cloud", "status"] as const;

interface CreatedLink {
  readonly linkId: string;
  readonly invitationId: string;
  readonly url: string;
  readonly expiresAtMs: number;
}

/**
 * 分享本机（客户端包 §3.2）：登记到这个远程服务、看隧道状态、停用；登记之后
 * 生成分享链接（指向一个工作空间、一个权限、一段有效期）——链接、二维码、
 * 复制、停用。链接里的秘密只在这一次显示：关掉对话框就只剩「生效中的链接」
 * 一列，能停用、不能再看。
 */
export function ShareDialog({
  remote,
  localLabel,
  onClose,
}: {
  remote: RemoteService | null;
  localLabel: string;
  onClose(): void;
}) {
  const t = useT();
  return (
    <ResponsiveDialog
      open={remote !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ResponsiveDialogContent className="z-[var(--z-dialog)] sm:max-w-[480px]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{t("remote.share")}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        {remote && <ShareBody remote={remote} localLabel={localLabel} />}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function ShareBody({
  remote,
  localLabel,
}: {
  remote: RemoteService;
  localLabel: string;
}) {
  const t = useT();
  const client = useQueryClient();
  const status = useQuery({
    queryKey: SHARE_STATUS_KEY,
    queryFn: shareStatus,
    retry: false,
    // 隧道状态跟着 core 变；对话框开着时跟上它。
    refetchInterval: 5_000,
  });
  const registration = status.data?.registrations.find(
    (one) => one.issuer === remote.issuer,
  );
  const sourceId = status.data?.sourceId ?? "";
  const refresh = () => {
    void client.invalidateQueries({ queryKey: SHARE_STATUS_KEY });
    void client.invalidateQueries({ queryKey: ["sources"] });
  };

  const start = useMutation({
    mutationFn: () =>
      shareThisMachine({
        serviceId: remote.serviceId,
        issuer: remote.issuer,
        label: localLabel,
      }),
    onSuccess: refresh,
    onError: (error: Error) => toast.error(error.message),
  });
  const stop = useMutation({
    mutationFn: () => stopSharing(remote.issuer),
    onSuccess: () => {
      refresh();
      toast.success(t("remote.share.stopped"));
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (status.isPending) {
    return (
      <div className="flex justify-center py-6">
        <Spinner aria-label={t("remote.share")} />
      </div>
    );
  }

  if (!registration) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[13px] break-words">{remote.label}</p>
        <Button
          type="button"
          className="w-full sm:w-fit"
          disabled={start.isPending}
          onClick={() => start.mutate()}
        >
          {start.isPending && <Spinner data-icon="inline-start" aria-hidden />}
          {t("remote.share.start")}
        </Button>
      </div>
    );
  }

  const pill = tunnelPill(registration.tunnel.state);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px]">{remote.label}</span>
          <StatusPill tone={pill.tone} label={t(pill.key)} />
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={stop.isPending}
          onClick={() => stop.mutate()}
        >
          {t("remote.share.stop")}
        </Button>
      </div>
      <Separator />
      <InviteSection serviceId={remote.serviceId} sourceId={sourceId} />
    </div>
  );
}

function InviteSection({
  serviceId,
  sourceId,
}: {
  serviceId: string;
  sourceId: string;
}) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const client = useQueryClient();
  const workspaces = useWorkspacesQuery();
  const current = useCanvasStore((state) => state.workspace);
  const [workspaceId, setWorkspaceId] = React.useState(current?.id ?? "");
  const [role, setRole] = React.useState<ShareRole>("viewer");
  const [days, setDays] = React.useState<number>(7);
  const [created, setCreated] = React.useState<CreatedLink | null>(null);
  const linksKey = ["remote", "links", serviceId, sourceId];
  const links = useQuery({
    queryKey: linksKey,
    queryFn: () => listShareLinks(serviceId, sourceId),
    enabled: sourceId !== "",
    retry: false,
  });

  const list = workspaces.data ?? [];
  const chosen = list.find((one) => one.id === workspaceId) ?? list[0];
  const format = (ms: number) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(ms);

  const create = useMutation({
    mutationFn: () =>
      createShareLink({
        serviceId,
        sourceId,
        workspaceId: chosen?.id ?? "",
        role,
        ttlMs: days * DAY_MS,
        label: chosen?.name ?? "",
      }),
    onSuccess: (link) => {
      setCreated(link);
      void client.invalidateQueries({ queryKey: linksKey });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const revoke = useMutation({
    mutationFn: (input: { linkId: string; invitationId?: string }) =>
      revokeShareLink({ serviceId, ...input }),
    onSuccess: (_, input) => {
      if (created?.linkId === input.linkId) setCreated(null);
      void client.invalidateQueries({ queryKey: linksKey });
      toast.success(t("remote.invite.revoked"));
    },
    onError: (error: Error) => toast.error(error.message),
  });

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("remote.invite.copied"));
    } catch {
      toast.error(t("remote.invite.copyFailed"));
    }
  }

  const others = (links.data ?? []).filter(
    (link) => link.linkId !== created?.linkId,
  );

  return (
    <section
      aria-label={t("remote.invite.title")}
      className="flex min-w-0 flex-col gap-3"
    >
      <h3 className="text-[13px] font-medium">{t("remote.invite.title")}</h3>
      {created ? (
        <div data-slot="share-link" className="flex min-w-0 flex-col gap-3">
          <div className="flex justify-center">
            <QrImage text={created.url} label={t("remote.invite.qr")} />
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <Input
              readOnly
              aria-label={t("remote.invite.link")}
              value={created.url}
              className="min-w-0 font-mono text-[12px]"
              onFocus={(event) => event.target.select()}
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => void copy(created.url)}
            >
              <Copy data-icon="inline-start" />
              {t("remote.invite.copy")}
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12px] text-muted-foreground tabular-nums">
              {t("remote.invite.until", { time: format(created.expiresAtMs) })}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={revoke.isPending}
              onClick={() =>
                revoke.mutate({
                  linkId: created.linkId,
                  invitationId: created.invitationId,
                })
              }
            >
              {t("remote.invite.revoke")}
            </Button>
          </div>
        </div>
      ) : list.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          {t("remote.invite.noWorkspace")}
        </p>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
          <Field className="min-w-0 gap-1.5">
            <FieldLabel className="text-[12px] text-muted-foreground">
              {t("remote.invite.workspace")}
            </FieldLabel>
            <Select
              value={chosen?.id ?? ""}
              onValueChange={(value) => setWorkspaceId(value)}
            >
              <SelectTrigger
                size="sm"
                aria-label={t("remote.invite.workspace")}
                className="w-full min-w-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
                {list.map((one) => (
                  <SelectItem key={one.id} value={one.id}>
                    {one.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field className="min-w-0 gap-1.5">
            <FieldLabel className="text-[12px] text-muted-foreground">
              {t("remote.invite.role")}
            </FieldLabel>
            <Select
              value={role}
              onValueChange={(value) => setRole(value as ShareRole)}
            >
              <SelectTrigger
                size="sm"
                aria-label={t("remote.invite.role")}
                className="w-full min-w-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
                {SHARE_ROLES.map((one) => (
                  <SelectItem key={one} value={one}>
                    {t(`sharing.role.${one}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field className="min-w-0 gap-1.5">
            <FieldLabel className="text-[12px] text-muted-foreground">
              {t("remote.invite.expires")}
            </FieldLabel>
            <Select
              value={String(days)}
              onValueChange={(value) => setDays(Number(value))}
            >
              <SelectTrigger
                size="sm"
                aria-label={t("remote.invite.expires")}
                className="w-full min-w-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
                {EXPIRY_DAYS.map((one) => (
                  <SelectItem key={one} value={String(one)}>
                    {t(`remote.invite.day${one}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Button
            type="button"
            className="sm:col-span-3 sm:justify-self-end"
            disabled={create.isPending || sourceId === "" || !chosen}
            onClick={() => create.mutate()}
          >
            {create.isPending && (
              <Spinner data-icon="inline-start" aria-hidden />
            )}
            {t("remote.invite.create")}
          </Button>
        </div>
      )}
      {others.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1">
          <h4 className="text-[12px] text-muted-foreground">
            {t("remote.invite.active")}
          </h4>
          <ul className="flex flex-col">
            {others.map((link) => (
              <li
                key={link.linkId}
                className="flex min-w-0 items-center justify-between gap-2 py-1"
              >
                <span className="min-w-0 truncate text-[13px]">
                  {link.label}
                  {link.role ? ` · ${t(`sharing.role.${link.role}`)}` : ""}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <span className="text-[12px] text-muted-foreground tabular-nums">
                    {format(link.expiresAtMs)}
                  </span>
                  <IconButton
                    label={t("remote.invite.revoke")}
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate({ linkId: link.linkId })}
                  >
                    <Link2Off />
                  </IconButton>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
