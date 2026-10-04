import * as React from "react";
import type {
  Passkey,
  PasskeyList as PasskeyListAnswer,
} from "@armadra/shared";
import { KeyRound, Pencil, Plus } from "lucide-react";

import { useT } from "../../../../app/preferences-store";
import {
  ConfirmRemove,
  SecuritySection,
  SecuritySectionSkeleton,
  useDateTime,
} from "./parts";
import { Alert, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Field, FieldLabel } from "@/ui/field";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
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
 * 通行密钥（设计系统 §5.10）：名称 · 创建时间 · [改名] [删除]；「添加通行密钥」。
 * 改名在名称格里内联（Enter 保存、Esc 取消），1–64 个字符（契约 §18.2）。
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
  onRename,
  loading = false,
}: {
  list: PasskeyListAnswer | undefined;
  /** 这个浏览器有没有 WebAuthn。 */
  supported: boolean;
  /** `"add"` 或正在删的 `credentialId`。 */
  busy: string | null;
  onAdd(): void;
  onRemove(passkey: Passkey): void;
  /** 改名；答 `true` 时收起输入框。不给时没有改名入口。 */
  onRename?(passkey: Passkey, label: string): Promise<boolean>;
  /** 第一次取数中（还没有 `list`）。 */
  loading?: boolean;
}) {
  const t = useT();
  const date = useDateTime("date");
  const [confirm, setConfirm] = React.useState<Passkey | null>(null);
  const [editing, setEditing] = React.useState<{
    id: string;
    label: string;
  } | null>(null);
  const [saving, setSaving] = React.useState(false);
  const save = (passkey: Passkey) => {
    const label = editing?.label.trim() ?? "";
    if (!onRename || saving || label === "" || [...label].length > 64) return;
    if (label === passkey.label) {
      setEditing(null);
      return;
    }
    setSaving(true);
    void onRename(passkey, label).then((done) => {
      setSaving(false);
      if (done) setEditing(null);
    });
  };
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
                    {editing?.id === passkey.credentialId ? (
                      <form
                        className="flex items-center gap-1.5"
                        onSubmit={(event) => {
                          event.preventDefault();
                          save(passkey);
                        }}
                      >
                        <Field className="min-w-0 flex-1">
                          <FieldLabel
                            className="sr-only"
                            htmlFor={`rename-${passkey.credentialId}`}
                          >
                            {t("security.passkeys.renameNamed", {
                              name: passkey.label || passkey.credentialId,
                            })}
                          </FieldLabel>
                          <Input
                            id={`rename-${passkey.credentialId}`}
                            autoFocus
                            maxLength={64}
                            className="h-7"
                            value={editing.label}
                            disabled={saving}
                            onChange={(event) =>
                              setEditing({
                                id: passkey.credentialId,
                                label: event.target.value,
                              })
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                event.stopPropagation();
                                setEditing(null);
                              }
                            }}
                          />
                        </Field>
                        <Button
                          type="submit"
                          size="sm"
                          variant="secondary"
                          disabled={saving || editing.label.trim() === ""}
                        >
                          {saving && (
                            <Spinner aria-label={t("security.passkeys.save")} />
                          )}
                          {t("security.passkeys.save")}
                        </Button>
                      </form>
                    ) : (
                      passkey.label || passkey.credentialId.slice(0, 8)
                    )}
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
                      <div className="flex items-center justify-end gap-1">
                        {onRename && editing?.id !== passkey.credentialId && (
                          <IconButton
                            type="button"
                            variant="ghost"
                            label={t("security.passkeys.renameNamed", {
                              name: passkey.label || passkey.credentialId,
                            })}
                            disabled={busy !== null || saving}
                            onClick={() =>
                              setEditing({
                                id: passkey.credentialId,
                                label: passkey.label,
                              })
                            }
                          >
                            <Pencil />
                          </IconButton>
                        )}
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
                      </div>
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
