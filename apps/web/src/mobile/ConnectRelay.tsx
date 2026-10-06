import * as React from "react";
import { Trash2 } from "lucide-react";

import { useT } from "../app/preferences-store";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/ui/item";
import { Spinner } from "@/ui/spinner";

import type { RelaySourceChoice } from "./connect";

/** 手机输入 16px，防 iOS 聚焦时放大整页（设计系统 §2.3）。 */
const TOUCH_INPUT =
  "h-11 text-[length:var(--text-input-touch)] md:text-[length:var(--text-input-touch)]";

/** 连接列表里的一行：名字、地址、走哪条路。 */
export interface ConnectionRow {
  readonly sourceId: string;
  readonly label: string;
  readonly host: string;
  readonly relayed: boolean;
  readonly direct: boolean;
}

export interface ConnectionListProps {
  readonly rows: readonly ConnectionRow[];
  readonly activeId?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly onOpen: (sourceId: string) => void;
  readonly onRemove: (sourceId: string) => void;
}

/** 已有的连接：点一行进入，行尾移除（要确认）。 */
export function ConnectionList({
  rows,
  activeId,
  disabled,
  onOpen,
  onRemove,
}: ConnectionListProps) {
  const t = useT();
  const [removing, setRemoving] = React.useState<ConnectionRow | null>(null);
  return (
    <>
      <ItemGroup className="gap-2">
        {rows.map((row) => (
          <Item
            key={row.sourceId}
            variant="outline"
            className="flex-nowrap p-0"
            aria-current={row.sourceId === activeId || undefined}
          >
            <Button
              type="button"
              variant="ghost"
              disabled={disabled}
              className="h-auto min-h-12 min-w-0 flex-1 justify-start gap-2.5 rounded-lg px-3 py-2 text-left font-normal whitespace-normal"
              onClick={() => onOpen(row.sourceId)}
            >
              <ItemContent className="min-w-0">
                <ItemTitle className="max-w-full truncate">
                  {row.label || row.host}
                </ItemTitle>
                <ItemDescription className="truncate font-mono text-[13px] tabular-nums">
                  {row.host}
                </ItemDescription>
              </ItemContent>
              {row.sourceId === activeId && (
                <Badge variant="secondary">{t("mobileConnect.current")}</Badge>
              )}
            </Button>
            <ItemActions className="pr-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-11"
                disabled={disabled}
                aria-label={t("mobileConnect.remove", {
                  name: row.label || row.host,
                })}
                onClick={() => setRemoving(row)}
              >
                <Trash2 />
              </Button>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
      <ResponsiveAlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <ResponsiveAlertDialogContent>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("mobileConnect.removeTitle", {
                name: removing ? removing.label || removing.host : "",
              })}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("mobileConnect.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing) onRemove(removing.sourceId);
                setRemoving(null);
              }}
            >
              {t("mobileConnect.removeConfirm")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </>
  );
}

export interface RelayFormProps {
  readonly busy: boolean;
  readonly message: string | null;
  readonly errorId: string;
  /**
   * 地址已定（中继托管的页面就是中转自己）：不显示地址栏，提交时用它。
   */
  readonly issuer?: string;
  /** 展示页钉住的初值。 */
  readonly initial?: {
    readonly issuer?: string;
    readonly account?: string;
    readonly password?: string;
  };
  readonly onSubmit: (input: {
    issuer: string;
    account: string;
    password: string;
  }) => void;
  readonly onEdit: () => void;
}

/** 个人中转：地址、账号、口令。 */
export function RelayForm({
  busy,
  message,
  errorId,
  issuer: fixedIssuer,
  initial,
  onSubmit,
  onEdit,
}: RelayFormProps) {
  const t = useT();
  const id = React.useId();
  const [typedIssuer, setIssuer] = React.useState(initial?.issuer ?? "");
  const issuer = fixedIssuer ?? typedIssuer;
  const [account, setAccount] = React.useState(initial?.account ?? "");
  const [password, setPassword] = React.useState(initial?.password ?? "");
  const ready =
    issuer.trim() !== "" && account.trim() !== "" && password !== "";
  const invalid = message !== null || undefined;
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    onEdit();
  };
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !busy) onSubmit({ issuer, account, password });
      }}
    >
      {fixedIssuer === undefined && (
        <Field data-invalid={invalid}>
          <FieldLabel htmlFor={`${id}-issuer`}>
            {t("mobileConnect.relay.address")}
          </FieldLabel>
          <Input
            id={`${id}-issuer`}
            value={issuer}
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="url"
            spellCheck={false}
            placeholder="relay.example.com"
            disabled={busy}
            className={TOUCH_INPUT}
            onChange={(event) => edit(setIssuer)(event.target.value)}
          />
        </Field>
      )}
      <Field data-invalid={invalid}>
        <FieldLabel htmlFor={`${id}-account`}>
          {t("mobileConnect.relay.account")}
        </FieldLabel>
        <Input
          id={`${id}-account`}
          value={account}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="username"
          spellCheck={false}
          disabled={busy}
          className={TOUCH_INPUT}
          onChange={(event) => edit(setAccount)(event.target.value)}
        />
      </Field>
      <Field data-invalid={invalid}>
        <FieldLabel htmlFor={`${id}-password`}>
          {t("mobileConnect.relay.password")}
        </FieldLabel>
        <Input
          id={`${id}-password`}
          value={password}
          type="password"
          autoComplete="current-password"
          disabled={busy}
          aria-invalid={invalid}
          aria-describedby={message ? errorId : undefined}
          className={TOUCH_INPUT}
          onChange={(event) => edit(setPassword)(event.target.value)}
        />
        {message && <FieldError id={errorId}>{message}</FieldError>}
      </Field>
      <Button
        type="submit"
        size="lg"
        className="h-11 w-full"
        disabled={busy || !ready}
      >
        {busy && <Spinner aria-label={t("mobileConnect.connecting")} />}
        {t("mobileConnect.relay.signIn")}
      </Button>
    </form>
  );
}

/** 64 位十六进制按 8 位一组，一行两组、共四行，窄屏不折行、便于逐段比对。 */
export function groupFingerprint(fingerprint: string): string[] {
  const groups = fingerprint.match(/.{1,8}/g) ?? [];
  const rows: string[] = [];
  for (let index = 0; index < groups.length; index += 2)
    rows.push(groups.slice(index, index + 2).join(" "));
  return rows;
}

export interface FingerprintStepProps {
  readonly host: string;
  readonly fingerprint: string;
  readonly busy: boolean;
  readonly message: string | null;
  readonly errorId: string;
  readonly onTrust: () => void;
  readonly onCancel: () => void;
}

/** 核对指纹：与中转启动时打印的一致才信任。 */
export function FingerprintStep({
  host,
  fingerprint,
  busy,
  message,
  errorId,
  onTrust,
  onCancel,
}: FingerprintStepProps) {
  const t = useT();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="font-mono text-[13px] text-muted-foreground tabular-nums">
          {host}
        </p>
        <Item variant="muted" className="flex-col items-start">
          <div
            role="group"
            className="flex flex-col gap-1 font-mono text-[13px] leading-5 tabular-nums"
            aria-label={t("mobileConnect.fingerprint.label")}
          >
            {groupFingerprint(fingerprint).map((row, index) => (
              <span key={index}>{row}</span>
            ))}
          </div>
        </Item>
        {message && <FieldError id={errorId}>{message}</FieldError>}
      </div>
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          size="lg"
          className="h-11 w-full"
          disabled={busy}
          onClick={onTrust}
        >
          {busy && <Spinner aria-label={t("mobileConnect.connecting")} />}
          {t("mobileConnect.fingerprint.trust")}
        </Button>
        <Button
          type="button"
          size="lg"
          variant="ghost"
          className="h-11 w-full"
          disabled={busy}
          onClick={onCancel}
        >
          {t("mobileConnect.cancel")}
        </Button>
      </div>
    </div>
  );
}

export interface SourcesStepProps {
  readonly sources: readonly RelaySourceChoice[];
  readonly busy: boolean;
  readonly message: string | null;
  readonly errorId: string;
  readonly onMount: (sourceIds: string[]) => void;
}

/** 登录之后勾选要连接的源：在线的默认全选，离线的不能选。 */
export function SourcesStep({
  sources,
  busy,
  message,
  errorId,
  onMount,
}: SourcesStepProps) {
  const t = useT();
  const id = React.useId();
  const [picked, setPicked] = React.useState<ReadonlySet<string>>(
    () =>
      new Set(
        sources.filter((source) => source.online).map((item) => item.sourceId),
      ),
  );
  const toggle = (sourceId: string, on: boolean) =>
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(sourceId);
      else next.delete(sourceId);
      return next;
    });
  return (
    <div className="flex flex-col gap-4">
      <ItemGroup className="gap-2" role="group">
        {sources.map((source) => (
          <Item
            key={source.sourceId}
            variant="outline"
            className="flex-nowrap p-0"
          >
            <label
              htmlFor={`${id}-${source.sourceId}`}
              className="flex min-h-12 min-w-0 flex-1 items-center gap-3 px-3 py-2"
            >
              <Checkbox
                id={`${id}-${source.sourceId}`}
                checked={picked.has(source.sourceId)}
                disabled={busy || !source.online}
                onCheckedChange={(value) =>
                  toggle(source.sourceId, value === true)
                }
              />
              <ItemTitle className="min-w-0 flex-1 truncate">
                {source.name || source.sourceId.slice(0, 8)}
              </ItemTitle>
              {!source.online && (
                <Badge variant="outline">{t("mobileConnect.offline")}</Badge>
              )}
            </label>
          </Item>
        ))}
      </ItemGroup>
      {message && <FieldError id={errorId}>{message}</FieldError>}
      <Button
        type="button"
        size="lg"
        className="h-11 w-full"
        disabled={busy || picked.size === 0}
        onClick={() => onMount([...picked])}
      >
        {busy && <Spinner aria-label={t("mobileConnect.connecting")} />}
        {t("mobileConnect.sources.add")}
      </Button>
    </div>
  );
}
