import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Ellipsis } from "lucide-react";
import { toast } from "sonner";

import {
  type ClientSource,
  type RemoteService,
  type RemoteSourceSummary,
  addDirectSource,
  addPersonalRelay,
  dismissRelayCleanup,
  forgetSource,
  isPairLink,
  listSources,
  logoutRemote,
  mountRemoteSource,
  mountSourceByLink,
  notifyShellSourcesChanged,
  pendingCode,
  relayPending,
  remoteSources,
  removeRemote,
  removeSource,
  retryRelayCleanup,
} from "../../../api/remote-services";
import { useT } from "../../../app/preferences-store";
import {
  applySourceTable,
  reloadIntoSettings,
} from "../../../sources/bootstrap";
import { useSource, useSourceStatus } from "../../../sources";
import {
  onJoinIntent,
  openAfterJoin,
  takeJoinLink,
} from "../../../sources/join-intent";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import {
  RELAY_PENDING_KEY,
  SHARE_STATUS_KEY,
  RemoteShareSection,
  relayPendingReason,
} from "../RemoteShare";
import { groupFingerprint } from "./gateway/PairingCard";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/ui/field";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Spinner } from "@/ui/spinner";
import { StatusPill } from "@/ui/status-pill";
import { sourcePill } from "../source-status";
import { checkAddress } from "./remote-address";

export const SOURCES_QUERY_KEY = ["sources", "list"] as const;

/** 设置导航里的分区 id（`nav.ts`）。 */
export const REMOTE_SECTION = "remote";

/** 地址的主机部分（显示用）；不是合法地址就原样。 */
function hostOf(issuer: string): string {
  try {
    return new URL(issuer).host || issuer;
  } catch {
    return issuer;
  }
}

/** 指纹短码：前 8 位，按两位一组。 */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint === "" ? "" : groupFingerprint(fingerprint.slice(0, 8));
}

/**
 * 源表变了之后的收尾：重读、交给页面源表、告诉桌面壳；壳说新来源要重载页面
 * 才放行（CSP），就回到这一页重载。
 */
function useSourceTableChanged() {
  const client = useQueryClient();
  return React.useCallback(async () => {
    await client.invalidateQueries({ queryKey: SOURCES_QUERY_KEY });
    void client.invalidateQueries({ queryKey: SHARE_STATUS_KEY });
    void client.invalidateQueries({ queryKey: RELAY_PENDING_KEY });
    if (await notifyShellSourcesChanged()) reloadIntoSettings(REMOTE_SECTION);
  }, [client]);
}

/**
 * 设置 → 远程服务（客户端包 §3.1）。两段：
 *
 * - **远程服务**：个人中转（地址、账号、口令，首次核对证书指纹）；每行登录 /
 *   登出、移除；用账号登录着的行可展开「分享」区（`RemoteShare.tsx`：分享本机
 *   的开关与分享链接）。SaaS 服务端就绪前不出现入口
 *   （总计划 §12）。
 * - **已挂载的源**：本机一行不可删；自托管直连（配对链接或地址 + 配对码，同样
 *   核对指纹）与从远程服务挂载；每行状态、断开、移除。
 *
 * 远程服务出错只落在那一行或那一次操作上（旁路保证）；错误按 `code` 取文案。
 */
export function RemoteServicesPage() {
  const t = useT();
  const changed = useSourceTableChanged();
  const table = useQuery({
    queryKey: SOURCES_QUERY_KEY,
    queryFn: listSources,
    retry: false,
  });
  const [adding, setAdding] = React.useState<RelayDraft | null>(null);
  const [addingDirect, setAddingDirect] = React.useState(false);
  const [mounting, setMounting] = React.useState(false);
  // 待填的分享链接（深链、`#join=`）：打开「通过链接加入」并预填，人点了才挂载。
  const [joining, setJoining] = React.useState<string | null>(takeJoinLink);
  React.useEffect(
    () =>
      onJoinIntent(() => {
        const offered = takeJoinLink();
        if (offered !== null) setJoining(offered);
      }),
    [],
  );
  // 撤销后中继侧没删掉的源记录（契约 §31.4）：本机行上标出来，可重试。
  const pending = useQuery({
    queryKey: RELAY_PENDING_KEY,
    queryFn: relayPending,
    retry: false,
  });
  const [removing, setRemoving] = React.useState<Removal | null>(null);
  const [dismissing, setDismissing] = React.useState<string | null>(null);

  const sources = table.data?.sources;
  React.useEffect(() => {
    if (sources) void applySourceTable(sources);
  }, [sources]);

  const remotes = table.data?.remotes ?? [];
  const local = sources?.find((source) => source.kind === "local");
  const mounted = (sources ?? []).filter((source) => source.kind !== "local");
  const signedIn = remotes.filter((remote) => remote.hasCredentials);
  const pendingList = pending.data ?? [];
  const pendingOf = (issuer: string) => pendingCode(pendingList, issuer);
  // 远程服务行已经删了、中继侧还欠着的：单独列出，登录回来再重试，或放弃清理。
  const orphans = pendingList.filter(
    (one) => !remotes.some((remote) => remote.issuer === one.issuer),
  );

  const logout = useMutation({
    mutationFn: (serviceId: string) => logoutRemote(serviceId),
    onSuccess: () => {
      void changed();
      toast.success(t("remote.signedOut"));
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const forget = useMutation({
    mutationFn: (sourceId: string) => forgetSource(sourceId),
    onSuccess: () => void changed(),
    onError: (error: Error) => toast.error(error.message),
  });
  const cleanup = useMutation({
    mutationFn: (issuer: string) => retryRelayCleanup(issuer),
    onSuccess: (code) => {
      void changed();
      if (code === null) toast.success(t("remote.relayPending.cleaned"));
      else toast.error(relayPendingReason(t, code) || t("remote.relayPending"));
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const dismiss = useMutation({
    mutationFn: (issuer: string) => dismissRelayCleanup(issuer),
    onSuccess: () => {
      void changed();
      toast.success(t("remote.relayPending.dismissed"));
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: async (target: Removal) => {
      if (target.kind === "source") {
        await removeSource(target.id);
        return null;
      }
      // 本机登记到它的，core 先撤销（连同中继侧的源记录）再删行。
      await removeRemote(target.id);
      return target.issuer === undefined || target.issuer === ""
        ? null
        : pendingCode(await relayPending(), target.issuer);
    },
    onSuccess: (code) => {
      void changed();
      if (code !== null) {
        toast.warning(t("remote.relayPending"), {
          description: relayPendingReason(t, code),
        });
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <>
      <SettingsGroup title={t("remote.services")}>
        {remotes.map((remote) => (
          <RemoteRow
            key={remote.serviceId}
            remote={remote}
            localLabel={local?.label ?? ""}
            pending={pendingOf(remote.issuer)}
            onSignIn={() =>
              setAdding({
                issuer: remote.issuer,
                account: remote.accountHint,
                fingerprint: remote.fingerprint,
              })
            }
            onSignOut={() => logout.mutate(remote.serviceId)}
            onRetryCleanup={() => cleanup.mutate(remote.issuer)}
            onRemove={() =>
              setRemoving({
                kind: "remote",
                id: remote.serviceId,
                name: remote.label,
                issuer: remote.issuer,
              })
            }
          />
        ))}
        {orphans.map((one) => (
          <SettingsRow
            key={one.issuer}
            label={hostOf(one.issuer)}
            footnote={relayPendingReason(t, one.code)}
          >
            <Badge variant="outline" className="font-normal">
              {t("remote.relayPending")}
            </Badge>
            <Button
              size="sm"
              variant="secondary"
              disabled={cleanup.isPending}
              onClick={() => cleanup.mutate(one.issuer)}
            >
              {t("remote.relayPending.retry")}
            </Button>
            <RowMenu name={hostOf(one.issuer)}>
              <DropdownMenuItem
                variant="destructive"
                disabled={dismiss.isPending}
                onSelect={() => setDismissing(one.issuer)}
              >
                {t("remote.relayPending.dismiss")}
              </DropdownMenuItem>
            </RowMenu>
          </SettingsRow>
        ))}
        <SettingsRow label={null}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              setAdding({ issuer: "", account: "", fingerprint: "" })
            }
          >
            {t("remote.add")}
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("remote.sources")}>
        {local && (
          <SettingsRow label={local.label}>
            <Badge variant="secondary" className="font-normal">
              {t("remote.kind.local")}
            </Badge>
          </SettingsRow>
        )}
        {mounted.map((source) => (
          <MountedRow
            key={source.sourceId}
            source={source}
            onForget={() => forget.mutate(source.sourceId)}
            onRemove={() =>
              setRemoving({
                kind: "source",
                id: source.sourceId,
                name: source.label,
              })
            }
          />
        ))}
        <SettingsRow label={null}>
          <Button size="sm" variant="secondary" onClick={() => setJoining("")}>
            {t("links.join")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setAddingDirect(true)}
          >
            {t("remote.direct.add")}
          </Button>
          {signedIn.length > 0 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setMounting(true)}
            >
              {t("remote.mount")}
            </Button>
          )}
        </SettingsRow>
      </SettingsGroup>

      <AddRelayDialog
        draft={adding}
        onClose={() => setAdding(null)}
        onDone={() => {
          setAdding(null);
          toast.success(t("remote.added"));
          void changed();
        }}
      />
      <AddDirectDialog
        open={addingDirect}
        onClose={() => setAddingDirect(false)}
        onDone={() => {
          setAddingDirect(false);
          toast.success(t("remote.added"));
          void changed();
        }}
      />
      <JoinLinkDialog
        initial={joining}
        onClose={() => setJoining(null)}
        onJoined={(sourceId) => {
          setJoining(null);
          toast.success(t("links.joined"));
          // 先记下要打开的源：收尾时壳可能为放行新来源重载页面。
          openAfterJoin(sourceId);
          void changed();
        }}
      />
      <MountDialog
        open={mounting}
        remotes={signedIn}
        onClose={() => setMounting(false)}
        onMounted={() => void changed()}
      />
      <ResponsiveAlertDialog
        open={dismissing !== null}
        onOpenChange={(open) => {
          if (!open) setDismissing(null);
        }}
      >
        <ResponsiveAlertDialogContent className="z-[var(--z-dialog)]">
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("remote.relayPending.dismissConfirm", {
                name: dismissing === null ? "" : hostOf(dismissing),
              })}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("remote.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              variant="destructive"
              onClick={() => {
                if (dismissing !== null) dismiss.mutate(dismissing);
                setDismissing(null);
              }}
            >
              {t("remote.relayPending.dismiss")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
      <ResponsiveAlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <ResponsiveAlertDialogContent className="z-[var(--z-dialog)]">
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("remote.removeConfirm", { name: removing?.name ?? "" })}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("remote.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing) remove.mutate(removing);
                setRemoving(null);
              }}
            >
              {t("remote.remove")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </>
  );
}

interface Removal {
  readonly kind: "remote" | "source";
  readonly id: string;
  readonly name: string;
  /** 远程服务的 issuer：删完看中继侧是否还欠着清理。 */
  readonly issuer?: string;
}

/**
 * 一行远程服务。用账号登录着的个人中转可以分享本机：行尾的展开钮打开它下面的
 * 「分享」区，缺省展开（访客那一行没有账号，不能分享本机）。
 */
function RemoteRow({
  remote,
  localLabel,
  pending,
  onSignIn,
  onSignOut,
  onRetryCleanup,
  onRemove,
}: {
  remote: RemoteService;
  localLabel: string;
  pending: string | null;
  onSignIn(): void;
  onSignOut(): void;
  onRetryCleanup(): void;
  onRemove(): void;
}) {
  const t = useT();
  const shareable = remote.hasCredentials && remote.accountHint !== "";
  const [open, setOpen] = React.useState(true);
  const row = (
    <SettingsRow
      label={remote.label}
      footnote={[
        t("remote.kind.personal"),
        remote.accountHint,
        shortFingerprint(remote.fingerprint),
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      {remote.registered && (
        <Badge variant="secondary" className="font-normal">
          {t("remote.sharing")}
        </Badge>
      )}
      {pending !== null && (
        <Badge variant="outline" className="font-normal">
          {t("remote.relayPending")}
        </Badge>
      )}
      {!remote.hasCredentials && (
        <Button size="sm" variant="secondary" onClick={onSignIn}>
          {t("remote.signIn")}
        </Button>
      )}
      <RowMenu name={remote.label}>
        {remote.hasCredentials && (
          <DropdownMenuItem onSelect={onSignOut}>
            {t("remote.signOut")}
          </DropdownMenuItem>
        )}
        {pending !== null && (
          <DropdownMenuItem onSelect={onRetryCleanup}>
            {t("remote.relayPending.retry")}
          </DropdownMenuItem>
        )}
        {(remote.hasCredentials || pending !== null) && (
          <DropdownMenuSeparator />
        )}
        <DropdownMenuItem variant="destructive" onSelect={onRemove}>
          {t("remote.remove")}
        </DropdownMenuItem>
      </RowMenu>
      {shareable && (
        <CollapsibleTrigger asChild>
          <IconButton
            size="cluster"
            label={t("remote.share.toggle", { name: remote.label })}
          >
            <ChevronDown
              className={`transition-transform ${open ? "rotate-180" : ""}`}
            />
          </IconButton>
        </CollapsibleTrigger>
      )}
    </SettingsRow>
  );
  if (!shareable) return row;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      {row}
      <CollapsibleContent>
        <RemoteShareSection remote={remote} localLabel={localLabel} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function RowMenu({
  name,
  children,
}: {
  name: string;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={t("remote.actions", { name })}>
          <Ellipsis />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[var(--z-dialog)]">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MountedRow({
  source,
  onForget,
  onRemove,
}: {
  source: ClientSource;
  onForget(): void;
  onRemove(): void;
}) {
  const t = useT();
  const connection = useSource(source.sourceId);
  const status = useSourceStatus(connection);
  const pill = sourcePill(
    source.hasCredentials ? status.state : "unauthorized",
  );
  const where = source.kind === "relayed" ? source.relayOrigin : source.baseUrl;
  return (
    <SettingsRow
      label={source.label}
      footnote={[
        t(
          source.kind === "relayed"
            ? "remote.kind.relayed"
            : "remote.kind.direct",
        ),
        where.replace(/^https?:\/\//, ""),
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <StatusPill tone={pill.tone} label={t(pill.key)} />
      <RowMenu name={source.label}>
        {source.hasCredentials && (
          <DropdownMenuItem onSelect={onForget}>
            {t("remote.forget")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem variant="destructive" onSelect={onRemove}>
          {t("remote.remove")}
        </DropdownMenuItem>
      </RowMenu>
    </SettingsRow>
  );
}

/* ------------------------------ 指纹核对 ------------------------------- */

function FingerprintCheck({ fingerprint }: { fingerprint: string }) {
  const t = useT();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[12px] text-muted-foreground">
        {t("remote.fingerprint")}
      </span>
      <p
        data-slot="fingerprint"
        className="font-mono text-[12px] leading-5 select-text"
      >
        {/* 只在冒号后折行：一组两位不被拆开，好逐组对照。 */}
        {groupFingerprint(fingerprint)
          .split(":")
          .map((pair, index) => (
            <React.Fragment key={index}>
              {index > 0 && (
                <>
                  :<wbr />
                </>
              )}
              {pair}
            </React.Fragment>
          ))}
      </p>
    </div>
  );
}

/* ------------------------------ 个人中转 ------------------------------- */

interface RelayDraft {
  readonly issuer: string;
  readonly account: string;
  /** 已知的指纹（重新登录）；新加的是空串。 */
  readonly fingerprint: string;
}

/**
 * 添加个人中转，或对已有的一行重新登录（地址与指纹不再改）。首次没有指纹时
 * core 答出对端的指纹，换成核对这一步；人确认后带着指纹再登录一次。
 */
function AddRelayDialog({
  draft,
  onClose,
  onDone,
}: {
  draft: RelayDraft | null;
  onClose(): void;
  onDone(): void;
}) {
  const t = useT();
  const relogin = draft !== null && draft.issuer !== "";
  const [issuer, setIssuer] = React.useState("");
  const [account, setAccount] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirming, setConfirming] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (draft === null) return;
    setIssuer(draft.issuer);
    setAccount(draft.account);
    setPassword("");
    setConfirming("");
    setError("");
  }, [draft]);

  async function submit(fingerprint: string) {
    if (busy) return;
    const checked = checkAddress(issuer);
    if (!checked.ok) {
      setError(t(checked.error));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const answer = await addPersonalRelay({
        issuer: checked.address,
        account,
        password,
        ...(fingerprint ? { fingerprint } : {}),
      });
      if (answer.kind === "confirm") {
        setConfirming(answer.fingerprint);
        return;
      }
      setPassword("");
      onDone();
    } catch (failure) {
      setConfirming("");
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  const ready =
    issuer.trim() !== "" && account.trim() !== "" && password !== "";

  return (
    <ResponsiveDialog
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ResponsiveDialogContent className="z-[var(--z-dialog)] sm:max-w-[420px]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {confirming
              ? t("remote.fingerprint.confirm")
              : relogin
                ? t("remote.signIn")
                : t("remote.add")}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (confirming) void submit(confirming);
            else if (ready) void submit(draft?.fingerprint ?? "");
          }}
        >
          {confirming ? (
            <>
              <p className="text-[13px] break-all">{issuer.trim()}</p>
              <FingerprintCheck fingerprint={confirming} />
            </>
          ) : (
            <FieldGroup className="gap-3">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="remote-issuer">
                  {t("remote.field.issuer")}
                </FieldLabel>
                <Input
                  id="remote-issuer"
                  inputMode="url"
                  autoComplete="url"
                  spellCheck={false}
                  placeholder="https://relay.example.com"
                  readOnly={relogin}
                  value={issuer}
                  onChange={(event) => setIssuer(event.target.value)}
                />
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="remote-account">
                  {t("remote.field.account")}
                </FieldLabel>
                <Input
                  id="remote-account"
                  autoComplete="username"
                  spellCheck={false}
                  value={account}
                  onChange={(event) => setAccount(event.target.value)}
                />
              </Field>
              <Field className="gap-1.5" data-invalid={error !== ""}>
                <FieldLabel htmlFor="remote-password">
                  {t("remote.field.password")}
                </FieldLabel>
                <Input
                  id="remote-password"
                  type="password"
                  autoComplete="current-password"
                  aria-invalid={error !== ""}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
            </FieldGroup>
          )}
          {error && <FieldError>{error}</FieldError>}
          <ResponsiveDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => (confirming ? setConfirming("") : onClose())}
            >
              {t("remote.cancel")}
            </Button>
            <Button type="submit" disabled={busy || (!confirming && !ready)}>
              {busy && <Spinner data-icon="inline-start" aria-hidden />}
              {confirming ? t("remote.fingerprint.trust") : t("remote.signIn")}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/* ------------------------------ 自托管直连 ----------------------------- */

function AddDirectDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose(): void;
  onDone(): void;
}) {
  const t = useT();
  const [address, setAddress] = React.useState("");
  const [code, setCode] = React.useState("");
  const [confirming, setConfirming] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const link = isPairLink(address);

  React.useEffect(() => {
    if (!open) return;
    setAddress("");
    setCode("");
    setConfirming("");
    setError("");
  }, [open]);

  async function submit(fingerprint: string) {
    if (busy) return;
    const checked = link ? null : checkAddress(address);
    if (checked !== null && !checked.ok) {
      setError(t(checked.error));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const answer = await addDirectSource(
        link
          ? { pairLink: address, ...(fingerprint ? { fingerprint } : {}) }
          : {
              origin: checked?.ok ? checked.address : address,
              code,
              ...(fingerprint ? { fingerprint } : {}),
            },
      );
      if (answer.kind === "confirm") {
        setConfirming(answer.fingerprint);
        return;
      }
      onDone();
    } catch (failure) {
      setConfirming("");
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  const ready = address.trim() !== "" && (link || code.trim() !== "");

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <ResponsiveDialogContent className="z-[var(--z-dialog)] sm:max-w-[420px]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {confirming
              ? t("remote.fingerprint.confirm")
              : t("remote.direct.add")}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (confirming) void submit(confirming);
            else if (ready) void submit("");
          }}
        >
          {confirming ? (
            <>
              <p className="text-[13px] break-all">{address.trim()}</p>
              <FingerprintCheck fingerprint={confirming} />
            </>
          ) : (
            <FieldGroup className="gap-3">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="direct-address">
                  {t("remote.direct.address")}
                </FieldLabel>
                <Input
                  id="direct-address"
                  inputMode="url"
                  spellCheck={false}
                  placeholder="https://192.168.1.20:8443"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                />
              </Field>
              {!link && (
                <Field className="gap-1.5" data-invalid={error !== ""}>
                  <FieldLabel htmlFor="direct-code">
                    {t("remote.direct.code")}
                  </FieldLabel>
                  <Input
                    id="direct-code"
                    autoComplete="one-time-code"
                    spellCheck={false}
                    className="font-mono tracking-[0.08em]"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </Field>
              )}
            </FieldGroup>
          )}
          {error && <FieldError>{error}</FieldError>}
          <ResponsiveDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => (confirming ? setConfirming("") : onClose())}
            >
              {t("remote.cancel")}
            </Button>
            <Button type="submit" disabled={busy || (!confirming && !ready)}>
              {busy && <Spinner data-icon="inline-start" aria-hidden />}
              {confirming
                ? t("remote.fingerprint.trust")
                : t("remote.direct.connect")}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/* ----------------------------- 通过链接加入 ----------------------------- */

/**
 * 粘贴分享链接（网页链接或 `armadra://join`）挂载：本机 core 接受链接、经中继
 * 登录、存凭据（契约 §33.7）。签发方第一次见时先核对证书指纹。`initial` 为
 * `null` 是关着；空串是空白打开；别的是深链预填的链接。
 */
function JoinLinkDialog({
  initial,
  onClose,
  onJoined,
}: {
  initial: string | null;
  onClose(): void;
  onJoined(sourceId: string): void;
}) {
  const t = useT();
  const [url, setUrl] = React.useState("");
  const [confirming, setConfirming] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (initial === null) return;
    setUrl(initial);
    setConfirming("");
    setError("");
  }, [initial]);

  async function submit(fingerprint: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const answer = await mountSourceByLink({
        url,
        ...(fingerprint ? { fingerprint } : {}),
      });
      if (answer.kind === "confirm") {
        setConfirming(answer.fingerprint);
        return;
      }
      setUrl("");
      onJoined(answer.value.sourceId);
    } catch (failure) {
      setConfirming("");
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  const ready = url.trim() !== "";
  let host = "";
  try {
    host = new URL(url.trim()).host;
  } catch {
    host = "";
  }

  return (
    <ResponsiveDialog
      open={initial !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <ResponsiveDialogContent className="z-[var(--z-dialog)] sm:max-w-[420px]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {confirming ? t("remote.fingerprint.confirm") : t("links.join")}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (confirming) void submit(confirming);
            else if (ready) void submit("");
          }}
        >
          {confirming ? (
            <>
              {host && <p className="text-[13px] break-all">{host}</p>}
              <FingerprintCheck fingerprint={confirming} />
            </>
          ) : (
            <FieldGroup className="gap-3">
              <Field className="gap-1.5" data-invalid={error !== ""}>
                <FieldLabel htmlFor="join-link">{t("links.field")}</FieldLabel>
                <Input
                  id="join-link"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={error !== ""}
                  placeholder="https://relay.example.com/j/…"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </Field>
            </FieldGroup>
          )}
          {error && <FieldError>{error}</FieldError>}
          <ResponsiveDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => (confirming ? setConfirming("") : onClose())}
            >
              {t("remote.cancel")}
            </Button>
            <Button type="submit" disabled={busy || (!confirming && !ready)}>
              {busy && <Spinner data-icon="inline-start" aria-hidden />}
              {confirming ? t("remote.fingerprint.trust") : t("links.action")}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/* --------------------------- 从远程服务挂载 ---------------------------- */

function MountDialog({
  open,
  remotes,
  onClose,
  onMounted,
}: {
  open: boolean;
  remotes: readonly RemoteService[];
  onClose(): void;
  onMounted(): void;
}) {
  const t = useT();
  const client = useQueryClient();
  const [serviceId, setServiceId] = React.useState("");
  const chosen =
    remotes.find((remote) => remote.serviceId === serviceId) ?? remotes[0];
  const listing = useQuery({
    queryKey: ["sources", "remote", chosen?.serviceId ?? ""],
    queryFn: () => remoteSources(chosen?.serviceId ?? ""),
    enabled: open && chosen !== undefined,
    retry: false,
  });
  const mount = useMutation({
    mutationFn: (source: RemoteSourceSummary) =>
      mountRemoteSource(chosen?.serviceId ?? "", source.sourceId),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: ["sources", "remote", chosen?.serviceId ?? ""],
      });
      toast.success(t("remote.added"));
      onMounted();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const rows = listing.data?.sources ?? [];

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <ResponsiveDialogContent className="z-[var(--z-dialog)] sm:max-w-[440px]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{t("remote.mount")}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <div className="flex min-w-0 flex-col gap-3">
          {remotes.length > 1 && (
            <Select
              value={chosen?.serviceId ?? ""}
              onValueChange={setServiceId}
            >
              <SelectTrigger
                size="sm"
                aria-label={t("remote.services")}
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
                {remotes.map((remote) => (
                  <SelectItem key={remote.serviceId} value={remote.serviceId}>
                    {remote.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {listing.isPending ? (
            <div className="flex justify-center py-4">
              <Spinner aria-label={t("remote.mount")} />
            </div>
          ) : listing.isError ? (
            <p role="alert" className="text-[13px] text-destructive">
              {listing.error.message}
            </p>
          ) : rows.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              {t("remote.mount.empty")}
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border/60">
              {rows.map((source) => (
                <li
                  key={source.sourceId}
                  className="flex min-w-0 items-center justify-between gap-3 py-2"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[13px]">{source.name}</span>
                    <StatusPill
                      tone={source.online ? "done" : "idle"}
                      label={t(
                        source.online
                          ? "remote.status.ready"
                          : "remote.status.offline",
                      )}
                    />
                  </span>
                  {source.mounted ? (
                    <Badge variant="secondary" className="font-normal">
                      {t("remote.mounted")}
                    </Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={mount.isPending || !source.online}
                      onClick={() => mount.mutate(source)}
                    >
                      {t("remote.mount.action")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
