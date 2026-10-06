import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Copy,
  Link2Off,
  Pencil,
  QrCode,
  RefreshCw,
  Share,
} from "lucide-react";
import { toast } from "sonner";
import { create } from "zustand";

import { SHARE_ROLES, type ShareRole } from "../../api/accounts";
import {
  type RemoteService,
  SHARE_LINK_MAX_USES,
  type ShareLink,
  createShareLink,
  listShareLinks,
  renameShareLink,
  revokeShareLink,
  shareLinkUrl,
  shareStatus,
  shareThisMachine,
  shareViaShell,
  shellCanShare,
  stopSharing,
} from "../../api/remote-services";
import { onWorkspaceConnection, onWorkspaceEvent } from "../../api/events";
import { localSource } from "../../api/source";
import { localizedFailure } from "../../api/request";
import {
  type Translate,
  usePreferencesStore,
  useT,
} from "../../app/preferences-store";
import { useWorkspacesQuery } from "../../app/workspaces-query";
import { useCanvasStore } from "../../store/canvas-store";
import { QrImage } from "./pages/gateway/PairingCard";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { Field, FieldGroup, FieldLabel } from "@/ui/field";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Spinner } from "@/ui/spinner";
import { StatusPill, type StatusTone } from "@/ui/status-pill";
import { Switch } from "@/ui/switch";

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
/** 新建链接的可用次数；缺省取 core 允许的上限（多次可用）。 */
export const USES_OPTIONS = [1, 10, 100, SHARE_LINK_MAX_USES] as const;

export const SHARE_STATUS_KEY = ["identity", "cloud", "status"] as const;
/** 已撤销、中继侧还欠着清理的登记（契约 §31.4）。 */
export const RELAY_PENDING_KEY = ["identity", "cloud", "relayPending"] as const;

export function shareLinksKey(serviceId: string) {
  return ["remote", "links", serviceId] as const;
}

const RELAY_PENDING_REASONS: Readonly<Record<string, string>> = {
  source_unauthorized: "remote.relayPending.source_unauthorized",
  source_unreachable: "remote.relayPending.source_unreachable",
};

/** 中继侧没清理掉的原因：按码取文案，认不出的码按通用错误文案。 */
export function relayPendingReason(t: Translate, code: string): string {
  const key = RELAY_PENDING_REASONS[code];
  return key === undefined ? localizedFailure(code, "") : t(key);
}

/** 停用分享之后的提示：中继侧没删掉时说「中继侧待清理」与原因。 */
export function announceStopped(t: Translate, pending: string | null): void {
  if (pending === null) {
    toast.success(t("remote.share.stopped"));
    return;
  }
  toast.warning(t("remote.share.stopped"), {
    description: [t("remote.relayPending"), relayPendingReason(t, pending)]
      .filter(Boolean)
      .join(" · "),
  });
}

/**
 * 有系统分享就出这个按钮：桌面壳的分享菜单（`app:share`），或浏览器的 Web
 * Share；都没有就只留复制。
 */
function canShareNatively(): boolean {
  return (
    shellCanShare() ||
    (typeof navigator !== "undefined" && typeof navigator.share === "function")
  );
}

async function copyText(t: Translate, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(t("remote.invite.copied"));
  } catch {
    toast.error(t("remote.invite.copyFailed"));
  }
}

/** 先交给桌面壳的分享菜单，壳不接就退回复制；浏览器用 Web Share。 */
export async function shareNatively(
  t: Translate,
  title: string,
  url: string,
): Promise<void> {
  if (shellCanShare()) {
    if (!(await shareViaShell(title, url))) await copyText(t, url);
    return;
  }
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function"
  ) {
    try {
      await navigator.share({ title, url });
    } catch {
      // 取消或系统拒绝：不打扰。
    }
    return;
  }
  await copyText(t, url);
}

/**
 * 隧道状态跟着 core 的 `cloud.tunnel` 事件走（契约 §32），不轮询：本机的事件
 * 一到就重读 `identity.cloud.status`；事件流（重新）连上时也重读一次，补上断开
 * 期间错过的变化（这个事件不进 outbox）。
 */
export function useTunnelEvents(): void {
  const client = useQueryClient();
  React.useEffect(() => {
    const local = localSource.sourceId;
    const refresh = () =>
      void client.invalidateQueries({ queryKey: SHARE_STATUS_KEY });
    const offEvent = onWorkspaceEvent(
      "cloud.tunnel",
      (_event, sourceId) => {
        if (sourceId === local) refresh();
      },
      { allSources: true },
    );
    const offConnection = onWorkspaceConnection(
      (_workspaceId, connected, sourceId) => {
        if (connected && sourceId === local) refresh();
      },
    );
    return () => {
      offEvent();
      offConnection();
    };
  }, [client]);
}

/**
 * 远程服务行展开后的「分享」区（客户端包 §3.2）：分享本机的开关与隧道状态；
 * 分享着时列出经它发出的链接——生效的可复制、看二维码、系统分享、撤销；失效的
 * 折进历史。整条链接存在本机 core 的 SecretStore（契约 §33.9），随时可再取。
 */
export function RemoteShareSection({
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
  });
  useTunnelEvents();
  const registration = status.data?.registrations.find(
    (one) => one.issuer === remote.issuer,
  );
  const [stopping, setStopping] = React.useState(false);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: SHARE_STATUS_KEY });
    void client.invalidateQueries({ queryKey: ["sources"] });
    void client.invalidateQueries({
      queryKey: shareLinksKey(remote.serviceId),
    });
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
    onSuccess: (pending) => {
      refresh();
      void client.invalidateQueries({ queryKey: RELAY_PENDING_KEY });
      announceStopped(t, pending);
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const busy = status.isPending || start.isPending || stop.isPending;
  const pill = registration ? tunnelPill(registration.tunnel.state) : null;

  return (
    <div
      data-slot="remote-share"
      className="flex min-w-0 flex-col gap-3 px-4 pb-4"
    >
      <div className="flex min-h-8 min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-[13px]">{t("remote.share")}</span>
          {pill && <StatusPill tone={pill.tone} label={t(pill.key)} />}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {busy && <Spinner aria-hidden />}
          <Switch
            aria-label={t("remote.share")}
            checked={registration !== undefined}
            disabled={busy}
            onCheckedChange={(on) => {
              if (on) start.mutate();
              else setStopping(true);
            }}
          />
        </div>
      </div>
      {registration && <ShareLinks remote={remote} />}
      <ResponsiveAlertDialog open={stopping} onOpenChange={setStopping}>
        <ResponsiveAlertDialogContent className="z-[var(--z-dialog)]">
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("remote.share.stopConfirm", { name: remote.label })}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("remote.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              variant="destructive"
              onClick={() => stop.mutate()}
            >
              {t("remote.share.stop")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </div>
  );
}

/** 一条链接要显示的名字：备注，没有就用工作空间名，再没有用 id 前几位。 */
function linkName(
  t: Translate,
  link: ShareLink,
  workspaceName: string | undefined,
): string {
  return (
    link.label ||
    workspaceName ||
    t("remote.link.unnamed", { id: link.linkId.slice(0, 6) })
  );
}

interface Showing {
  readonly linkId: string;
  readonly name: string;
  /** 刚建的链接直接带着整条链接；列表里的再向 core 取。 */
  readonly url?: string;
}

/**
 * 正在看的那条链接（二维码框），按远程服务记在组件外：窄屏 / 宽屏切换时设置框
 * 整个重新挂载，刚建好的链接不能跟着组件状态一起丢。只在内存里，关了就清。
 */
interface ShowingState {
  readonly byService: Readonly<Record<string, Showing>>;
  show(serviceId: string, showing: Showing | null): void;
}

export const useShowingStore = create<ShowingState>()((set) => ({
  byService: {},
  show: (serviceId, showing) =>
    set((state) => {
      const byService = { ...state.byService };
      if (showing === null) delete byService[serviceId];
      else byService[serviceId] = showing;
      return { byService };
    }),
}));

function ShareLinks({ remote }: { remote: RemoteService }) {
  const t = useT();
  const client = useQueryClient();
  const workspaces = useWorkspacesQuery();
  const key = shareLinksKey(remote.serviceId);
  const links = useQuery({
    queryKey: key,
    queryFn: () => listShareLinks(remote.serviceId),
    retry: false,
  });
  const [creating, setCreating] = React.useState(false);
  const showing = useShowingStore(
    (state) => state.byService[remote.serviceId] ?? null,
  );
  const show = useShowingStore((state) => state.show);
  const setShowing = (next: Showing | null) => show(remote.serviceId, next);
  const [revoking, setRevoking] = React.useState<{
    linkId: string;
    name: string;
  } | null>(null);
  const [renaming, setRenaming] = React.useState<{
    linkId: string;
    label: string;
    placeholder: string;
  } | null>(null);

  const names = new Map(
    (workspaces.data ?? []).map((one) => [one.id, one.name] as const),
  );
  const all = links.data ?? [];
  const active = all.filter((link) => link.state === "active");
  const history = all.filter((link) => link.state !== "active");

  const revoke = useMutation({
    mutationFn: (linkId: string) => revokeShareLink(remote.serviceId, linkId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: key });
      toast.success(t("remote.link.revoked"));
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const copy = useMutation({
    mutationFn: (linkId: string) => shareLinkUrl(remote.serviceId, linkId),
    onSuccess: (url) => void copyText(t, url),
    onError: (error: Error) => toast.error(error.message),
  });
  const send = useMutation({
    mutationFn: async (input: { linkId: string; name: string }) =>
      shareNatively(
        t,
        input.name,
        await shareLinkUrl(remote.serviceId, input.linkId),
      ),
    onError: (error: Error) => toast.error(error.message),
  });
  const rename = useMutation({
    mutationFn: (input: { linkId: string; label: string }) =>
      renameShareLink(remote.serviceId, input.linkId, input.label),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: key });
      setRenaming(null);
      toast.success(t("remote.link.renamed"));
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <section
      aria-label={t("remote.invite.title")}
      className="flex min-w-0 flex-col gap-2"
    >
      <div className="flex min-h-8 min-w-0 items-center justify-between gap-2">
        <h4 className="text-[13px] font-medium">{t("remote.invite.title")}</h4>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            size="cluster"
            label={t("remote.links.refresh")}
            disabled={links.isFetching}
            onClick={() => void links.refetch()}
          >
            {links.isFetching ? <Spinner aria-hidden /> : <RefreshCw />}
          </IconButton>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setCreating(true)}
          >
            {t("remote.links.new")}
          </Button>
        </div>
      </div>
      {links.isError ? (
        <p role="alert" className="text-[12px] text-destructive">
          {links.error.message}
        </p>
      ) : links.isPending ? null : active.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          {t("remote.links.empty")}
        </p>
      ) : (
        <ItemGroup className="gap-0">
          {active.map((link) => {
            const name = linkName(t, link, names.get(link.workspaceId));
            return (
              <LinkItem
                key={link.linkId}
                link={link}
                name={name}
                workspaceName={names.get(link.workspaceId)}
              >
                {link.copyable && (
                  <>
                    <IconButton
                      size="cluster"
                      label={t("remote.invite.copy")}
                      disabled={copy.isPending}
                      onClick={() => copy.mutate(link.linkId)}
                    >
                      <Copy />
                    </IconButton>
                    <IconButton
                      size="cluster"
                      label={t("remote.link.qr")}
                      onClick={() => setShowing({ linkId: link.linkId, name })}
                    >
                      <QrCode />
                    </IconButton>
                    {canShareNatively() && (
                      <IconButton
                        size="cluster"
                        label={t("remote.link.share")}
                        disabled={send.isPending}
                        onClick={() =>
                          send.mutate({ linkId: link.linkId, name })
                        }
                      >
                        <Share />
                      </IconButton>
                    )}
                  </>
                )}
                <IconButton
                  size="cluster"
                  label={t("remote.link.rename")}
                  onClick={() =>
                    setRenaming({
                      linkId: link.linkId,
                      label: link.label,
                      placeholder: names.get(link.workspaceId) ?? "",
                    })
                  }
                >
                  <Pencil />
                </IconButton>
                <IconButton
                  size="cluster"
                  label={t("remote.link.revoke")}
                  disabled={revoke.isPending}
                  onClick={() => setRevoking({ linkId: link.linkId, name })}
                >
                  <Link2Off />
                </IconButton>
              </LinkItem>
            );
          })}
        </ItemGroup>
      )}
      {history.length > 0 && <History links={history} names={names} />}

      <CreateLinkDialog
        open={creating}
        serviceId={remote.serviceId}
        onClose={() => setCreating(false)}
        onCreated={(created, name) => {
          setCreating(false);
          void client.invalidateQueries({ queryKey: key });
          setShowing({ linkId: created.link.linkId, name, url: created.url });
        }}
      />
      <LinkQrDialog
        serviceId={remote.serviceId}
        showing={showing}
        onClose={() => setShowing(null)}
      />
      <RenameLinkDialog
        renaming={renaming}
        pending={rename.isPending}
        onClose={() => setRenaming(null)}
        onSave={(label) => {
          if (renaming) rename.mutate({ linkId: renaming.linkId, label });
        }}
      />
      <ResponsiveAlertDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
      >
        <ResponsiveAlertDialogContent className="z-[var(--z-dialog)]">
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("remote.link.revokeConfirm", { name: revoking?.name ?? "" })}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("remote.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              variant="destructive"
              onClick={() => {
                if (revoking) revoke.mutate(revoking.linkId);
                setRevoking(null);
              }}
            >
              {t("remote.link.revoke")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </section>
  );
}

/** 一行链接：名字与权限，下面一行是工作空间、创建、有效期与次数。 */
function LinkItem({
  link,
  name,
  workspaceName,
  children,
}: {
  link: ShareLink;
  name: string;
  workspaceName: string | undefined;
  children?: React.ReactNode;
}) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const day = (ms: number) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(ms);
  const moment = (ms: number) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(ms);
  const facts = [
    workspaceName && workspaceName !== name ? workspaceName : "",
    link.createdAtMs > 0
      ? t("remote.link.created", { time: day(link.createdAtMs) })
      : "",
    link.state === "revoked" && link.revokedAtMs !== null
      ? t("remote.link.revokedAt", { time: moment(link.revokedAtMs) })
      : t("remote.invite.until", { time: moment(link.expiresAtMs) }),
    link.maxUses === null
      ? t("remote.link.usedOpen", { uses: link.uses })
      : t("remote.link.used", { uses: link.uses, max: link.maxUses }),
  ].filter(Boolean);
  return (
    <Item
      role="listitem"
      size="xs"
      className="-mx-2.5 w-auto flex-nowrap"
      data-link-id={link.linkId}
    >
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="flex min-w-0 items-center gap-2 text-[13px] font-normal">
          <span className="truncate">{name}</span>
          {link.role !== "" && (
            <Badge variant="secondary" className="shrink-0 font-normal">
              {t(`sharing.role.${link.role}`)}
            </Badge>
          )}
          {link.state !== "active" && (
            <Badge variant="outline" className="shrink-0 font-normal">
              {t(`remote.link.state.${link.state}`)}
            </Badge>
          )}
        </ItemTitle>
        <ItemDescription className="text-[11px] leading-4 tabular-nums">
          {facts.join(" · ")}
        </ItemDescription>
      </ItemContent>
      {children && (
        <ItemActions className="shrink-0 gap-0.5">{children}</ItemActions>
      )}
    </Item>
  );
}

/** 撤销、过期、用尽的链接：默认收起。 */
function History({
  links,
  names,
}: {
  links: readonly ShareLink[];
  names: ReadonlyMap<string, string>;
}) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-mx-2 w-fit text-muted-foreground"
        >
          {t("remote.links.history", { count: links.length })}
          <ChevronDown
            data-icon="inline-end"
            className={`transition-transform ${open ? "rotate-180" : ""}`}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ItemGroup className="gap-0 opacity-70">
          {links.map((link) => (
            <LinkItem
              key={link.linkId}
              link={link}
              name={linkName(t, link, names.get(link.workspaceId))}
              workspaceName={names.get(link.workspaceId)}
            />
          ))}
        </ItemGroup>
      </CollapsibleContent>
    </Collapsible>
  );
}

function CreateLinkDialog({
  open,
  serviceId,
  onClose,
  onCreated,
}: {
  open: boolean;
  serviceId: string;
  onClose(): void;
  onCreated(
    created: Awaited<ReturnType<typeof createShareLink>>,
    name: string,
  ): void;
}) {
  const t = useT();
  const workspaces = useWorkspacesQuery();
  const current = useCanvasStore((state) => state.workspace);
  const [label, setLabel] = React.useState("");
  const [workspaceId, setWorkspaceId] = React.useState(current?.id ?? "");
  const [role, setRole] = React.useState<ShareRole>("viewer");
  const [days, setDays] = React.useState<number>(7);
  const [uses, setUses] = React.useState<number>(SHARE_LINK_MAX_USES);
  React.useEffect(() => {
    if (open) setLabel("");
  }, [open]);

  const list = workspaces.data ?? [];
  const chosen = list.find((one) => one.id === workspaceId) ?? list[0];
  const create = useMutation({
    mutationFn: () =>
      createShareLink({
        serviceId,
        workspaceId: chosen?.id ?? "",
        role,
        ttlMs: days * DAY_MS,
        maxUses: uses,
        label: label.trim() || (chosen?.name ?? ""),
      }),
    onSuccess: (created) =>
      onCreated(created, created.link.label || (chosen?.name ?? "")),
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <ResponsiveDialogContent className="z-[var(--z-dialog)] sm:max-w-[520px]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{t("remote.links.new")}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        {list.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            {t("remote.invite.noWorkspace")}
          </p>
        ) : (
          <form
            id="share-link-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!create.isPending) create.mutate();
            }}
          >
            <FieldGroup className="gap-4">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="share-link-note">
                  {t("remote.link.note")}
                </FieldLabel>
                <Input
                  id="share-link-note"
                  value={label}
                  maxLength={128}
                  placeholder={chosen?.name ?? ""}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </Field>
              <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
                <Choice
                  label={t("remote.invite.workspace")}
                  value={chosen?.id ?? ""}
                  onChange={setWorkspaceId}
                  options={list.map((one) => [one.id, one.name])}
                />
                <Choice
                  label={t("remote.invite.role")}
                  value={role}
                  onChange={(value) => setRole(value as ShareRole)}
                  options={SHARE_ROLES.map((one) => [
                    one,
                    t(`sharing.role.${one}`),
                  ])}
                />
                <Choice
                  label={t("remote.invite.expires")}
                  value={String(days)}
                  onChange={(value) => setDays(Number(value))}
                  options={EXPIRY_DAYS.map((one) => [
                    String(one),
                    t(`remote.invite.day${one}`),
                  ])}
                />
                <Choice
                  label={t("remote.link.maxUses")}
                  value={String(uses)}
                  onChange={(value) => setUses(Number(value))}
                  options={USES_OPTIONS.map((one) => [
                    String(one),
                    t(`remote.link.uses${one}`),
                  ])}
                />
              </div>
            </FieldGroup>
          </form>
        )}
        <ResponsiveDialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("remote.cancel")}
          </Button>
          <Button
            type="submit"
            form="share-link-form"
            disabled={create.isPending || !chosen}
          >
            {create.isPending && (
              <Spinner data-icon="inline-start" aria-hidden />
            )}
            {t("remote.link.create")}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange(value: string): void;
}) {
  return (
    <Field className="min-w-0 gap-1.5">
      <FieldLabel>{label}</FieldLabel>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label} className="w-full min-w-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="z-[var(--z-dialog)]">
          {options.map(([id, text]) => (
            <SelectItem key={id} value={id}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** 二维码与整条链接：刚建的直接用，列表里的向 core 再取一次。 */
function LinkQrDialog({
  serviceId,
  showing,
  onClose,
}: {
  serviceId: string;
  showing: Showing | null;
  onClose(): void;
}) {
  const t = useT();
  const fetched = useQuery({
    queryKey: ["remote", "link-url", serviceId, showing?.linkId ?? ""],
    queryFn: () => shareLinkUrl(serviceId, showing?.linkId ?? ""),
    enabled: showing !== null && showing.url === undefined,
    retry: false,
    // 整条链接含秘密：不进缓存，关了就丢。
    gcTime: 0,
    staleTime: 0,
  });
  const url = showing?.url ?? fetched.data;
  return (
    <ResponsiveDialog
      open={showing !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ResponsiveDialogContent className="z-[var(--z-dialog)] sm:max-w-[420px]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="truncate">
            {showing?.name ?? ""}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        {fetched.isError ? (
          <p role="alert" className="text-[13px] text-destructive">
            {fetched.error.message}
          </p>
        ) : url === undefined ? (
          <div className="flex justify-center py-6">
            <Spinner aria-label={t("remote.link.qr")} />
          </div>
        ) : (
          <div data-slot="share-link" className="flex min-w-0 flex-col gap-3">
            <div className="flex justify-center">
              <QrImage text={url} label={t("remote.invite.qr")} />
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <Input
                readOnly
                aria-label={t("remote.invite.link")}
                value={url}
                className="min-w-0 font-mono text-[12px]"
                onFocus={(event) => event.target.select()}
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void copyText(t, url)}
              >
                <Copy data-icon="inline-start" />
                {t("remote.invite.copy")}
              </Button>
              {canShareNatively() && (
                <IconButton
                  size="cluster"
                  label={t("remote.link.share")}
                  onClick={() =>
                    void shareNatively(t, showing?.name ?? "", url)
                  }
                >
                  <Share />
                </IconButton>
              )}
            </div>
          </div>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/** 改一条链接的备注：空着就清掉（列表回落到工作空间名）。 */
function RenameLinkDialog({
  renaming,
  pending,
  onClose,
  onSave,
}: {
  renaming: { linkId: string; label: string; placeholder: string } | null;
  pending: boolean;
  onClose(): void;
  onSave(label: string): void;
}) {
  const t = useT();
  const [label, setLabel] = React.useState("");
  const linkId = renaming?.linkId;
  const initial = renaming?.label ?? "";
  React.useEffect(() => {
    if (linkId !== undefined) setLabel(initial);
  }, [linkId, initial]);
  return (
    <ResponsiveDialog
      open={renaming !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ResponsiveDialogContent className="z-[var(--z-dialog)] sm:max-w-[420px]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t("remote.link.rename")}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form
          id="share-link-rename-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!pending) onSave(label);
          }}
        >
          <Field className="gap-1.5">
            <FieldLabel htmlFor="share-link-rename">
              {t("remote.link.note")}
            </FieldLabel>
            <Input
              id="share-link-rename"
              value={label}
              maxLength={128}
              placeholder={renaming?.placeholder ?? ""}
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>
        </form>
        <ResponsiveDialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("remote.cancel")}
          </Button>
          <Button
            type="submit"
            form="share-link-rename-form"
            disabled={pending || label.trim() === initial.trim()}
          >
            {pending && <Spinner data-icon="inline-start" aria-hidden />}
            {t("remote.link.save")}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
