import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CredentialEntry, CredentialKind } from "@armadra/shared";
import { toast } from "sonner";

import { useT } from "@/app/preferences-store";
import { agentLabel } from "@/agent/launch";
import { CREDENTIALS_QUERY_KEY, credentialsApi } from "@/api/credentials";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";

/**
 * 设置 → Agent 的「节点凭据」区块（契约 §20.2）。
 *
 * 每行只有名字与「Agent · 种类」；值写进去之后不再出现。未启用的种类在新建
 * 表单里灰掉并标「待实测」（CLI 协作 §7.4 T4–T7）。主机不能存凭据时整块只剩
 * 一句原因。
 */
export function AgentCredentials() {
  const t = useT();
  const client = useQueryClient();
  const credentials = useQuery({
    queryKey: CREDENTIALS_QUERY_KEY,
    queryFn: ({ signal }) => credentialsApi.list(signal),
    staleTime: 60_000,
    retry: false,
  });
  const [adding, setAdding] = React.useState(false);
  const [removing, setRemoving] = React.useState<CredentialEntry | null>(null);
  const refresh = () =>
    client.invalidateQueries({ queryKey: CREDENTIALS_QUERY_KEY });
  const remove = useMutation({
    mutationFn: (ref: string) => credentialsApi.remove(ref),
    onSuccess: () => {
      toast.success(t("credentials.deleted"));
      void refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const data = credentials.data;
  if (!data) return null;
  if (!data.available) {
    return (
      <SettingsGroup title={t("credentials.title")}>
        <SettingsRow
          label={t(
            `credentials.unavailable.${data.reason ?? "credential_unsupported_here"}`,
          )}
        />
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup title={t("credentials.title")}>
      {data.entries.map((entry, index) => (
        <SettingsRow
          key={entry.ref}
          label={entry.label}
          footnote={
            index === data.entries.length - 1
              ? t("credentials.note")
              : undefined
          }
        >
          <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
            {!entry.isSet && (
              <Badge variant="outline">{t("credentials.notSet")}</Badge>
            )}
            {agentLabel(entry.providerId)} · {entry.kind}
            <IconButton
              label={t("credentials.delete")}
              onClick={() => setRemoving(entry)}
            >
              <Trash2 />
            </IconButton>
          </span>
        </SettingsRow>
      ))}
      {data.entries.length === 0 && (
        <SettingsRow label={t("credentials.empty")} />
      )}
      <SettingsRow label={null}>
        <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
          <Plus />
          {t("credentials.add")}
        </Button>
      </SettingsRow>

      <CredentialDialog
        open={adding}
        kinds={data.kinds}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          toast.success(t("credentials.saved"));
          void refresh();
        }}
      />

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogContent className="z-[var(--z-dialog)]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("credentials.deleteConfirm", { label: removing?.label ?? "" })}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("credentials.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (removing) remove.mutate(removing.ref);
                setRemoving(null);
              }}
            >
              {t("credentials.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsGroup>
  );
}

function kindKey(kind: CredentialKind): string {
  return `${kind.providerId}/${kind.kind}`;
}

function CredentialDialog({
  open,
  kinds,
  onClose,
  onSaved,
}: {
  open: boolean;
  kinds: readonly CredentialKind[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const firstEnabled = kinds.find((kind) => kind.enabled);
  const [choice, setChoice] = React.useState(
    firstEnabled ? kindKey(firstEnabled) : "",
  );
  const [label, setLabel] = React.useState("");
  const [value, setValue] = React.useState("");
  React.useEffect(() => {
    if (!open) {
      setLabel("");
      setValue("");
    }
  }, [open]);
  const selected = kinds.find((kind) => kindKey(kind) === choice);
  const create = useMutation({
    mutationFn: () =>
      credentialsApi.create({
        providerId: selected?.providerId ?? "",
        kind: selected?.kind ?? "",
        label: label.trim(),
        value: value.trim(),
      }),
    onSuccess: onSaved,
    onError: (error) => toast.error(error.message),
  });
  const ready =
    selected?.enabled === true &&
    label.trim() !== "" &&
    value.trim() !== "" &&
    !create.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="z-[var(--z-dialog)] sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t("credentials.add")}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) create.mutate();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="credential-kind">{t("credentials.kind")}</Label>
            <Select value={choice} onValueChange={setChoice}>
              <SelectTrigger id="credential-kind" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
                {kinds.map((kind) => (
                  <SelectItem
                    key={kindKey(kind)}
                    value={kindKey(kind)}
                    disabled={!kind.enabled}
                  >
                    {agentLabel(kind.providerId)} · {kind.kind}
                    {!kind.enabled && (
                      <span className="ml-2 text-muted-foreground">
                        {t("credentials.pending")}
                      </span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="credential-label">{t("credentials.label")}</Label>
            <Input
              id="credential-label"
              className="h-8 text-xs"
              maxLength={200}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="credential-value">{t("credentials.value")}</Label>
            <Input
              id="credential-value"
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="h-8 text-xs"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {t("credentials.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={!ready}>
              {t("credentials.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
