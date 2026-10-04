import * as React from "react";
import { toast } from "sonner";
import type {
  AcpElicitationAction,
  AcpElicitationAnswer,
  AcpElicitationField,
  AcpElicitationForm,
} from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { useAgentStatusStore } from "@/agent/status-store";
import { cn } from "@/lib/cn";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Switch } from "@/ui/switch";
import { acpApi } from "./api";
import { useAcpStore, type AcpElicitationView } from "./store";

type Value = string | boolean;
type Values = Readonly<Record<string, Value>>;

/** 表单的起始值：有 `default` 用它，布尔缺省 `false`，其余空串。 */
export function initialValues(form: AcpElicitationForm | undefined): Values {
  const out: Record<string, Value> = {};
  for (const [name, field] of Object.entries(form?.properties ?? {})) {
    if (field.type === "boolean") out[name] = field.default ?? false;
    else if (field.default !== undefined) out[name] = String(field.default);
    else out[name] = "";
  }
  return out;
}

function fieldValid(field: AcpElicitationField, raw: Value): boolean {
  if (field.type === "boolean") return typeof raw === "boolean";
  const text = typeof raw === "string" ? raw : "";
  if (text === "") return true;
  if (field.type === "string") {
    if (field.enum && !field.enum.includes(text)) return false;
    if (field.minLength !== undefined && text.length < field.minLength)
      return false;
    if (field.maxLength !== undefined && text.length > field.maxLength)
      return false;
    return true;
  }
  const value = Number(text);
  if (!Number.isFinite(value)) return false;
  if (field.type === "integer" && !Number.isInteger(value)) return false;
  if (field.minimum !== undefined && value < field.minimum) return false;
  if (field.maximum !== undefined && value > field.maximum) return false;
  return true;
}

/**
 * 表单值 → 答给 Agent 的 `content`；不合规（缺必填、类型或约束不对）答
 * `null`。空串不进 `content`，数字按类型转换。core 还会再按同一份 schema
 * 校验一次（契约 §26.1），这里只为不让人点一个注定 400 的按钮。
 */
export function contentOf(
  form: AcpElicitationForm,
  values: Values,
): Record<string, string | number | boolean> | null {
  const required = new Set(form.required ?? []);
  const out: Record<string, string | number | boolean> = {};
  for (const [name, field] of Object.entries(form.properties)) {
    const raw = values[name] ?? (field.type === "boolean" ? false : "");
    if (!fieldValid(field, raw)) return null;
    if (field.type === "boolean") {
      out[name] = raw as boolean;
      continue;
    }
    if (raw === "") {
      if (required.has(name)) return null;
      continue;
    }
    out[name] = field.type === "string" ? (raw as string) : Number(raw);
  }
  return out;
}

/** 只放行 http(s)：链接来自 Agent，不让它塞 `javascript:` 之类进来。 */
export function safeUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

/**
 * 答一次：与审批卡同一个做法，先收起（会话视图与节点头一起），再发请求；
 * 没答上（core 不认这份内容、或请求失败）就把卡放回去。
 */
export async function answerElicitation(
  nodeId: string,
  view: AcpElicitationView,
  answer: AcpElicitationAnswer,
): Promise<boolean> {
  useAcpStore.getState().resolvePermission(view.pendingId);
  useAgentStatusStore.getState().resolveApproval(view.pendingId);
  try {
    await acpApi.answerElicitation(view.pendingId, answer);
    return true;
  } catch {
    useAcpStore.getState().addElicitation(nodeId, view);
    return false;
  }
}

function FormField({
  id,
  name,
  field,
  value,
  required,
  onChange,
}: {
  id: string;
  name: string;
  field: AcpElicitationField;
  value: Value;
  required: boolean;
  onChange: (value: Value) => void;
}) {
  const label = field.title ?? name;
  const description = field.description ? (
    <FieldDescription className="text-xs">{field.description}</FieldDescription>
  ) : null;

  if (field.type === "boolean") {
    return (
      <Field orientation="horizontal" className="gap-2">
        <Switch
          id={id}
          size="sm"
          checked={value === true}
          onCheckedChange={(checked) => onChange(checked)}
        />
        <FieldLabel htmlFor={id} className="text-[13px] font-normal">
          {label}
        </FieldLabel>
      </Field>
    );
  }

  const labelNode = (
    <FieldLabel htmlFor={id} className="text-[13px] font-normal">
      {label}
      {required && <span aria-hidden>*</span>}
    </FieldLabel>
  );

  if (field.type === "string" && field.enum && field.enum.length > 0) {
    const names = field.enumNames;
    return (
      <Field className="gap-1">
        {labelNode}
        <Select
          value={typeof value === "string" && value !== "" ? value : undefined}
          onValueChange={onChange}
        >
          <SelectTrigger id={id} size="sm" className="w-full text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {field.enum.map((option, index) => (
              <SelectItem key={option} value={option}>
                {names?.[index] ?? option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {description}
      </Field>
    );
  }

  const numeric = field.type !== "string";
  const type = numeric
    ? "number"
    : field.format === "email"
      ? "email"
      : field.format === "uri"
        ? "url"
        : field.format === "date"
          ? "date"
          : field.format === "date-time"
            ? "datetime-local"
            : "text";
  return (
    <Field className="gap-1">
      {labelNode}
      <Input
        id={id}
        type={type}
        value={typeof value === "string" ? value : ""}
        required={required}
        className="h-8 text-[13px] md:text-[13px]"
        {...(numeric
          ? {
              inputMode: field.type === "integer" ? "numeric" : "decimal",
              step: field.type === "integer" ? 1 : "any",
              min: field.minimum,
              max: field.maximum,
            }
          : { minLength: field.minLength, maxLength: field.maxLength })}
        onChange={(event) => onChange(event.target.value)}
      />
      {description}
    </Field>
  );
}

/**
 * `elicitation/create` 的卡片（契约 §26.1）：与审批卡同一个位置、同一种
 * 外观。按 `requestedSchema` 画表单——文本 / 枚举 Select / 布尔 Switch——
 * 提交、拒绝、取消各一键。URL 模式只给一个打开链接，表单画不出来（core
 * 没存 `requestedSchema`）时只剩拒绝与取消。没有答复权限的人看到同一张卡，
 * 按钮换成「等待接管」。
 */
export function ElicitationCard({
  nodeId,
  view,
  canAnswer,
  className,
}: {
  nodeId: string;
  view: AcpElicitationView;
  canAnswer: boolean;
  className?: string;
}) {
  const t = useT();
  const idBase = React.useId();
  const { elicitation } = view;
  const form =
    elicitation.mode === "form" ? elicitation.requestedSchema : undefined;
  const url = elicitation.mode === "url" ? safeUrl(elicitation.url) : null;
  const [values, setValues] = React.useState<Values>(() => initialValues(form));
  const [busy, setBusy] = React.useState(false);
  const content = form ? contentOf(form, values) : null;
  // URL 模式的「继续」不带内容；表单模式要表单画得出来且填对了。
  const canAccept = elicitation.mode === "url" ? true : content !== null;

  const send = async (action: AcpElicitationAction) => {
    if (busy) return;
    setBusy(true);
    const answer: AcpElicitationAnswer =
      action === "accept" && form && content ? { action, content } : { action };
    const ok = await answerElicitation(nodeId, view, answer);
    setBusy(false);
    if (!ok) toast.error(t("acp.elicitation.failed"));
  };

  const required = new Set(form?.required ?? []);
  const accept = elicitation.mode === "url" ? url !== null : form !== undefined;

  return (
    <Card
      data-slot="acp-elicitation"
      data-pending-id={view.pendingId}
      className={cn(
        "gap-2 border-l-2 border-l-[var(--warn)] px-3 py-2",
        className,
      )}
    >
      <span className="text-[13px] whitespace-pre-wrap">
        {elicitation.message}
      </span>
      {canAnswer ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (accept && canAccept) void send("accept");
          }}
        >
          {form && Object.keys(form.properties).length > 0 && (
            <FieldGroup className="gap-2">
              {Object.entries(form.properties).map(([name, field]) => (
                <FormField
                  key={name}
                  id={`${idBase}-${name}`}
                  name={name}
                  field={field}
                  value={values[name] ?? ""}
                  required={required.has(name)}
                  onChange={(value) =>
                    setValues((previous) => ({ ...previous, [name]: value }))
                  }
                />
              ))}
            </FieldGroup>
          )}
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate text-xs text-[var(--brand-text)] underline underline-offset-4"
            >
              {url}
            </a>
          )}
          <div className="flex flex-wrap gap-2">
            {accept && (
              <Button type="submit" size="sm" disabled={busy || !canAccept}>
                {t(
                  elicitation.mode === "url"
                    ? "acp.elicitation.continue"
                    : "acp.elicitation.submit",
                )}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void send("decline")}
            >
              {t("acp.elicitation.decline")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void send("cancel")}
            >
              {t("acp.elicitation.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <Badge variant="outline" className="self-start">
          {t("acp.permission.awaitingDriver")}
        </Badge>
      )}
    </Card>
  );
}
