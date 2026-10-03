import * as React from "react";
import type { IdentitySessionRow, Lockout } from "@armadra/shared";
import { Globe, Laptop, Smartphone } from "lucide-react";

import { useT } from "../../../../app/preferences-store";
import {
  ConfirmRemove,
  SecuritySection,
  SecuritySectionSkeleton,
  useDateTime,
} from "./parts";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";
import { Switch } from "@/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";

/**
 * 会话与设备（设计系统 §5.10，契约 §18.4）：设备 · 最近活动 · IP · [退出]，
 * 当前这一个带「当前」；底部「退出其他全部」。owner 可以切到所有人的会话。
 */
export function SessionList({
  sessions,
  everyone,
  canSeeEveryone,
  names,
  busy,
  onEveryone,
  onRevoke,
  onRevokeOthers,
  loading = false,
}: {
  sessions: readonly IdentitySessionRow[] | undefined;
  everyone: boolean;
  canSeeEveryone: boolean;
  /** principalId → 显示名（所有人视图里的成员列）。 */
  names?: ReadonlyMap<string, string>;
  /** 正在退出的 `sessionId`，或 `"others"`。 */
  busy: string | null;
  onEveryone(value: boolean): void;
  onRevoke(session: IdentitySessionRow): void;
  onRevokeOthers(): void;
  /** 第一次取数中（还没有 `sessions`）。 */
  loading?: boolean;
}) {
  const t = useT();
  const when = useDateTime();
  const [confirm, setConfirm] = React.useState<
    IdentitySessionRow | "others" | null
  >(null);
  if (sessions === undefined)
    return loading ? (
      <SecuritySectionSkeleton title={t("security.sessions")} />
    ) : null;
  const others = sessions.some((session) => !session.current && !everyone);
  const ordered = [...sessions].sort(
    (a, b) =>
      Number(b.current) - Number(a.current) || lastActive(b) - lastActive(a),
  );

  return (
    <SecuritySection
      title={t("security.sessions")}
      action={
        canSeeEveryone ? (
          <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
            {t("security.sessions.everyone")}
            <Switch
              checked={everyone}
              aria-label={t("security.sessions.everyone")}
              onCheckedChange={onEveryone}
            />
          </label>
        ) : undefined
      }
    >
      <div className="rounded-lg border border-border/70 bg-card px-2">
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow>
              <TableHead>{t("security.sessions.device")}</TableHead>
              {everyone && (
                <TableHead>{t("security.sessions.member")}</TableHead>
              )}
              <TableHead>{t("security.sessions.lastActive")}</TableHead>
              <TableHead>{t("security.sessions.ip")}</TableHead>
              <TableHead className="w-0">
                <span className="sr-only">
                  {t("security.sessions.signOut")}
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ordered.map((session) => {
              const Icon = platformIcon(session.userAgent);
              const name = session.deviceName || session.deviceId.slice(0, 8);
              return (
                <TableRow key={session.sessionId}>
                  <TableCell className="max-w-[16rem]">
                    <span className="flex min-w-0 items-center gap-2">
                      <Icon
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                      <span
                        className="truncate font-medium"
                        title={session.userAgent}
                      >
                        {name}
                      </span>
                      {session.current && (
                        <Badge variant="secondary">
                          {t("security.sessions.current")}
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  {everyone && (
                    <TableCell className="max-w-[10rem] truncate">
                      {names?.get(session.principalId) ||
                        session.principalId.slice(0, 8)}
                    </TableCell>
                  )}
                  <TableCell className="text-muted-foreground tabular-nums">
                    {when(lastActive(session))}
                  </TableCell>
                  <TableCell className="font-mono text-[12px] text-muted-foreground">
                    {session.remoteIp || "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {busy === session.sessionId ? (
                      <Spinner
                        className="ml-auto"
                        aria-label={t("security.sessions.signOut")}
                      />
                    ) : session.current ? null : (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={busy !== null}
                        aria-label={t("security.sessions.signOutNamed", {
                          name,
                        })}
                        onClick={() => setConfirm(session)}
                      >
                        {t("security.sessions.signOut")}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {others && (
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="text-destructive"
            disabled={busy !== null}
            onClick={() => setConfirm("others")}
          >
            {busy === "others" && (
              <Spinner aria-label={t("security.sessions.signOutOthers")} />
            )}
            {t("security.sessions.signOutOthers")}
          </Button>
        </div>
      )}
      <ConfirmRemove
        open={confirm !== null}
        title={
          confirm === "others"
            ? t("security.sessions.signOutOthers")
            : t("security.sessions.signOut")
        }
        subject={
          confirm === null || confirm === "others"
            ? ""
            : confirm.deviceName || confirm.deviceId
        }
        action={t("security.sessions.signOut")}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const target = confirm;
          setConfirm(null);
          if (target === "others") onRevokeOthers();
          else if (target) onRevoke(target);
        }}
      />
    </SecuritySection>
  );
}

function lastActive(session: IdentitySessionRow): number {
  return session.lastSeenAtMs || session.createdAtMs;
}

/** 由 UA 猜个图标：手机、桌面浏览器，认不出的用地球。 */
export function platformIcon(userAgent: string) {
  if (/iPhone|iPad|Android|Mobile/i.test(userAgent)) return Smartphone;
  if (/Macintosh|Windows|Linux|X11|CrOS|Electron/i.test(userAgent))
    return Laptop;
  return Globe;
}

/** 锁定的账号（契约 §18.1，owner）：没有锁着的就不出现。 */
export function LockoutList({
  lockouts,
  names,
  busy,
  onUnlock,
}: {
  lockouts: readonly Lockout[] | undefined;
  names?: ReadonlyMap<string, string>;
  busy: string | null;
  onUnlock(lockout: Lockout): void;
}) {
  const t = useT();
  const when = useDateTime();
  if (!lockouts || lockouts.length === 0) return null;
  return (
    <SecuritySection title={t("security.lockouts")}>
      <div className="rounded-lg border border-border/70 bg-card px-2">
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow>
              <TableHead>{t("security.sessions.member")}</TableHead>
              <TableHead>{t("security.lockouts.failures")}</TableHead>
              <TableHead>{t("security.lockouts.until")}</TableHead>
              <TableHead className="w-0">
                <span className="sr-only">{t("security.lockouts.unlock")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lockouts.map((lockout) => (
              <TableRow key={lockout.key}>
                <TableCell className="max-w-[16rem] truncate font-medium">
                  {names?.get(lockout.principalId) || lockout.principalId}
                </TableCell>
                <TableCell className="tabular-nums">
                  {lockout.failures}
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {when(lockout.lockedUntilMs)}
                </TableCell>
                <TableCell className="text-right">
                  {busy === lockout.principalId ? (
                    <Spinner
                      className="ml-auto"
                      aria-label={t("security.lockouts.unlock")}
                    />
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => onUnlock(lockout)}
                    >
                      {t("security.lockouts.unlock")}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SecuritySection>
  );
}
