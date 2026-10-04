import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import type { SshHost, SshHostKey, SshHostKeyScan } from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
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

/**
 * 确认一台主机的公钥（远端补完设计 §3.6）。
 *
 * 扫描是只读的：什么都不写，也不替任何人做判断。界面只把「主机公布的指纹」
 * 摆出来，由人对着服务器自己打印的那一串比对，点了才记录——所以没有
 * 「全部信任」，也没有默认选中项。
 *
 * `changed` 表示已经记着一把不一样的密钥：可能是重装，也可能是有人在中间。
 * 这时新旧指纹并排显示，按钮换成「替换」并且必须再确认一次；只有那条路径
 * 才会带上 `replace: true`。
 */
export function HostKeyDialog({ host }: { host: SshHost }) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const [scan, setScan] = React.useState<SshHostKeyScan | null>(null);
  const [pending, setPending] = React.useState<SshHostKey | null>(null);

  const rescan = useMutation({
    mutationFn: () => runtimeApi.scanSshHostKeys(host.id),
    onSuccess: (result) => setScan(result),
    onError: (cause: Error) =>
      toast.error(t("ssh.hostKey.failed"), { description: cause.message }),
  });
  const trust = useMutation({
    mutationFn: (input: { line: string; replace: boolean }) =>
      runtimeApi.trustSshHostKey(host.id, input.line, input.replace),
    // The answer is a fresh scan, so what is shown is the new state rather
    // than an assertion that the write did what was asked.
    onSuccess: (result) => {
      setScan(result);
      setPending(null);
      toast.success(t("ssh.hostKey.saved"));
    },
    onError: (cause: Error) =>
      toast.error(t("ssh.hostKey.saveFailed"), { description: cause.message }),
  });
  const forget = useMutation({
    mutationFn: () => runtimeApi.forgetSshHostKeys(host.id),
    onSuccess: () => rescan.mutate(),
    onError: (cause: Error) =>
      toast.error(t("ssh.hostKey.saveFailed"), { description: cause.message }),
  });

  const start = rescan.mutate;
  React.useEffect(() => {
    if (open) start();
  }, [open, start]);

  const changed = scan?.changed === true;
  const busy = rescan.isPending || trust.isPending || forget.isPending;

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <KeyRound />
        {t("ssh.hostKey.action")}
      </Button>

      <ResponsiveDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setScan(null);
            setPending(null);
          }
        }}
      >
        <ResponsiveDialogContent className="z-[var(--z-dialog)]">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>
              {t("ssh.hostKey.title", { name: host.name })}
            </ResponsiveDialogTitle>
          </ResponsiveDialogHeader>

          {changed && (
            <div className="flex flex-col gap-1">
              <Badge variant="destructive">{t("ssh.hostKey.changed")}</Badge>
              {scan?.known.map((fingerprint) => (
                <Known key={fingerprint} fingerprint={fingerprint} />
              ))}
            </div>
          )}

          <div className="flex flex-col gap-2">
            {rescan.isPending && (
              <p className="text-xs text-muted-foreground">
                {t("ssh.hostKey.scanning")}
              </p>
            )}
            {scan?.keys.length === 0 && !rescan.isPending && (
              <p className="text-xs text-muted-foreground">
                {t("ssh.hostKey.empty")}
              </p>
            )}
            {scan?.keys.map((key) => (
              <div
                key={key.line}
                className="flex items-center justify-between gap-3"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[13px] leading-5">{key.keyType}</span>
                  <span className="truncate font-mono text-[11px] leading-4 text-muted-foreground">
                    {key.fingerprint}
                  </span>
                </span>
                {key.trusted ? (
                  <Badge variant="outline">{t("ssh.hostKey.trusted")}</Badge>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      changed
                        ? setPending(key)
                        : trust.mutate({ line: key.line, replace: false })
                    }
                  >
                    {t(changed ? "ssh.hostKey.replace" : "ssh.hostKey.trust")}
                  </Button>
                )}
              </div>
            ))}
          </div>

          <ResponsiveDialogFooter>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => forget.mutate()}
            >
              {t("ssh.hostKey.forget")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => rescan.mutate()}
            >
              {t("ssh.hostKey.rescan")}
            </Button>
            <Button size="sm" onClick={() => setOpen(false)}>
              {t("ssh.hostKey.close")}
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      <ResponsiveAlertDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
      >
        <ResponsiveAlertDialogContent className="z-[var(--z-dialog)]">
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("ssh.hostKey.replaceTitle", {
                fingerprint: pending?.fingerprint ?? "",
              })}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <div className="flex flex-col gap-1">
            {scan?.known.map((fingerprint) => (
              <Known key={fingerprint} fingerprint={fingerprint} />
            ))}
          </div>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("ssh.dialog.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              onClick={() => {
                if (pending)
                  trust.mutate({ line: pending.line, replace: true });
              }}
            >
              {t("ssh.hostKey.replaceConfirm")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </>
  );
}

/** 一条已经记着的指纹，和新扫到的摆在一起给人比对。 */
function Known({ fingerprint }: { fingerprint: string }) {
  const t = useT();
  return (
    <span className="flex items-center gap-2">
      <span className="text-[11px] leading-4 text-muted-foreground">
        {t("ssh.hostKey.known")}
      </span>
      <span className="truncate font-mono text-[11px] leading-4">
        {fingerprint}
      </span>
    </span>
  );
}
