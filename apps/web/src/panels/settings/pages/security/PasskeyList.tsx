import * as React from "react";
import type {
  Passkey,
  PasskeyList as PasskeyListAnswer,
} from "@armadra/shared";
import { KeyRound, Plus } from "lucide-react";

import { useT } from "../../../../app/preferences-store";
import {
  ConfirmRemove,
  SecuritySection,
  SecuritySectionSkeleton,
  useDateTime,
} from "./parts";
import { Alert, AlertTitle } from "@/ui/alert";
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

/**
 * 通行密钥（设计系统 §5.10）：名称 · 创建时间 · [删除]；「添加通行密钥」。
 *
 * 主机不能用（IP 访问、RP ID 不符）或浏览器不支持时，只留一行原因，不摆按钮
 * ——让浏览器抛错再解释是倒过来的。
 */
export function PasskeyList({
  list,
  supported,
  busy,
  onAdd,
  onRemove,
  loading = false,
}: {
  list: PasskeyListAnswer | undefined;
  /** 这个浏览器有没有 WebAuthn。 */
  supported: boolean;
  /** `"add"` 或正在删的 `credentialId`。 */
  busy: string | null;
  onAdd(): void;
  onRemove(passkey: Passkey): void;
  /** 第一次取数中（还没有 `list`）。 */
  loading?: boolean;
}) {
  const t = useT();
  const date = useDateTime("date");
  const [confirm, setConfirm] = React.useState<Passkey | null>(null);
  if (list === undefined)
    return loading ? (
      <SecuritySectionSkeleton title={t("security.passkeys")} />
    ) : null;

  const unavailable = `security.passkeys.unavailable.${list.reason}`;
  const reason = !list.available
    ? t(unavailable) === unavailable
      ? list.reason || t("security.passkeys.unsupported")
      : t(unavailable)
    : !supported
      ? t("security.passkeys.unsupported")
      : "";

  return (
    <SecuritySection
      title={t("security.passkeys")}
      action={
        reason ? undefined : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={onAdd}
          >
            {busy === "add" ? (
              <Spinner aria-label={t("security.passkeys.add")} />
            ) : (
              <Plus />
            )}
            {t("security.passkeys.add")}
          </Button>
        )
      }
    >
      {reason && (
        <Alert>
          <KeyRound />
          <AlertTitle>{reason}</AlertTitle>
        </Alert>
      )}
      {list.passkeys.length > 0 && (
        <div className="rounded-lg border border-border/70 bg-card px-2">
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow>
                <TableHead>{t("security.name")}</TableHead>
                <TableHead>{t("security.created")}</TableHead>
                <TableHead className="w-0">
                  <span className="sr-only">
                    {t("security.passkeys.remove")}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.passkeys.map((passkey) => (
                <TableRow key={passkey.credentialId}>
                  <TableCell className="max-w-[16rem] truncate font-medium">
                    {passkey.label || passkey.credentialId.slice(0, 8)}
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">
                    {date(passkey.createdAtMs)}
                  </TableCell>
                  <TableCell className="text-right">
                    {busy === passkey.credentialId ? (
                      <Spinner
                        className="ml-auto"
                        aria-label={t("security.passkeys.remove")}
                      />
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={busy !== null}
                        aria-label={t("security.passkeys.removeNamed", {
                          name: passkey.label || passkey.credentialId,
                        })}
                        onClick={() => setConfirm(passkey)}
                      >
                        {t("security.passkeys.remove")}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <ConfirmRemove
        open={confirm !== null}
        title={t("security.passkeys.confirmTitle")}
        subject={confirm?.label || confirm?.credentialId || ""}
        action={t("security.passkeys.remove")}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const passkey = confirm;
          setConfirm(null);
          if (passkey) onRemove(passkey);
        }}
      />
    </SecuritySection>
  );
}
