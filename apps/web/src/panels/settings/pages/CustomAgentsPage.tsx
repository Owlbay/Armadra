import * as React from "react";
import { Plus } from "lucide-react";
import {
  AGENT_IDS,
  customAgentSchema,
  type BuiltinAgentId,
  type AgentCapability,
  type CustomAgent,
} from "@armadra/shared";
import { toast } from "sonner";
import { CapabilityInheritance } from "@/agent/CapabilityInheritance";

import { useAgentsQuery } from "../../../app/use-agents";
import { useT } from "../../../app/preferences-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { useSubpage } from "../subpage";
import { useRuntimeSettings } from "../use-runtime-settings";
import { CONTROL_WIDTH } from "./GeneralPage";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@/ui/empty";

/**
 * 设置 → 自定义 Agent（§2.1）。
 *
 * 一条一行，点一行或「添加」推入同一右栏里的子页（名称、命令、参数、环境变量、
 * 基础 Agent 与能力继承），删除放在子页页尾。
 */
export function CustomAgentsPage() {
  const t = useT();
  const subpage = useSubpage();
  const { settings, save } = useRuntimeSettings();
  const custom = React.useMemo(
    () => settings.data?.agents?.custom ?? [],
    [settings.data],
  );

  if (subpage.current?.startsWith("agent:")) {
    return (
      <CustomAgentForm
        reference={subpage.current.slice("agent:".length)}
        custom={custom}
        disabled={!settings.data}
        onSubmit={(next) => {
          save.mutate({ agents: { custom: next } });
          subpage.close();
        }}
        onCancel={subpage.close}
      />
    );
  }

  const addCustom = (
    <Button
      variant="secondary"
      size="sm"
      disabled={!settings.data}
      onClick={() => subpage.open("agent", "new")}
    >
      <Plus />
      {t("settings.customAgent.add")}
    </Button>
  );

  if (custom.length === 0) {
    // 空态：一句话 + 一个动作（设计系统 §5.16）。
    return (
      <SettingsGroup>
        <Empty className="py-6">
          <EmptyHeader>
            <EmptyTitle className="text-[13px] font-normal text-muted-foreground">
              {t("settings.customAgent.empty")}
            </EmptyTitle>
          </EmptyHeader>
          <EmptyContent>{addCustom}</EmptyContent>
        </Empty>
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup>
      {custom.map((agent) => (
        <SettingsRow
          key={agent.id}
          label={agent.label}
          onClick={() => subpage.open("agent", agent.id)}
        >
          <span className="max-w-[240px] truncate font-mono text-[11px] text-muted-foreground">
            {agent.launchCmd}
          </span>
        </SettingsRow>
      ))}
      <SettingsRow label={null}>{addCustom}</SettingsRow>
    </SettingsGroup>
  );
}

/* -------------------------------- 自定义 Agent ---------------------------- */

interface AgentForm {
  label: string;
  launchCmd: string;
  args: string;
  env: string;
  baseAgent: BuiltinAgentId;
  disabledCapabilities?: AgentCapability[];
}

const EMPTY_FORM: AgentForm = {
  label: "",
  launchCmd: "",
  args: "",
  env: "",
  baseAgent: "claude",
};

function toForm(agent: CustomAgent | undefined): AgentForm {
  if (!agent) return EMPTY_FORM;
  return {
    label: agent.label,
    launchCmd: agent.launchCmd,
    args: agent.args.join(" "),
    env: envToText(agent),
    baseAgent: agent.baseAgent,
    disabledCapabilities: agent.disabledCapabilities,
  };
}

/** `KEY=value` 一行一条。 */
function envToText(agent: CustomAgent): string {
  if (!agent.env) return "";
  return Object.entries(agent.env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    env[trimmed.slice(0, separator).trim()] = trimmed
      .slice(separator + 1)
      .trim();
  }
  return env;
}

/** 表单 → 自定义 Agent。校验用的是 shared 的 schema，和 Runtime 同一套规则。 */
export function parseAgentForm(
  form: AgentForm,
  id: string,
): CustomAgent | null {
  const args = form.args.trim().split(/\s+/).filter(Boolean);
  const env = parseEnvText(form.env);
  const parsed = customAgentSchema.safeParse({
    id,
    label: form.label.trim(),
    launchCmd: form.launchCmd.trim(),
    args,
    baseAgent: form.baseAgent,
    ...(form.disabledCapabilities
      ? { disabledCapabilities: form.disabledCapabilities }
      : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  });
  return parsed.success ? parsed.data : null;
}

function CustomAgentForm({
  reference,
  custom,
  disabled,
  onSubmit,
  onCancel,
}: {
  reference: string;
  custom: readonly CustomAgent[];
  disabled: boolean;
  onSubmit: (next: CustomAgent[]) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const agents = useAgentsQuery();
  const existing = custom.find((agent) => agent.id === reference);
  const [form, setForm] = React.useState<AgentForm>(() => toForm(existing));
  const [pendingDelete, setPendingDelete] = React.useState(false);
  // 探测跟着基础适配器走：能力受限于它借用的那个 CLI 的版本，而不是这份
  // 自定义配置自己填的启动程序名。
  const probe =
    agents.data?.find((entry) => entry.id === form.baseAgent)?.probe ?? null;

  const set = (key: keyof AgentForm) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const fields: Array<{ key: "label" | "launchCmd" | "args"; label: string }> =
    [
      { key: "label", label: t("settings.customAgent.name") },
      { key: "launchCmd", label: t("settings.customAgent.command") },
      { key: "args", label: t("settings.customAgent.args") },
    ];

  return (
    <>
      <SettingsGroup>
        {fields.map((field) => (
          <SettingsRow key={field.key} label={field.label}>
            <Input
              className="h-8 w-[280px] text-xs"
              aria-label={field.label}
              value={form[field.key]}
              onChange={(event) => set(field.key)(event.target.value)}
            />
          </SettingsRow>
        ))}

        <SettingsRow label={t("settings.customAgent.env")}>
          <Input
            className="h-8 w-[280px] text-xs"
            aria-label={t("settings.customAgent.env")}
            placeholder="KEY=value"
            value={form.env}
            onChange={(event) => set("env")(event.target.value)}
          />
        </SettingsRow>

        <SettingsRow label={t("settings.customAgent.base")}>
          <Select
            value={form.baseAgent}
            onValueChange={(value) =>
              setForm((current) => ({
                ...current,
                baseAgent: value as BuiltinAgentId,
              }))
            }
          >
            <SelectTrigger
              aria-label={t("settings.customAgent.base")}
              size="sm"
              className={CONTROL_WIDTH}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {AGENT_IDS.map((id) => (
                <SelectItem key={id} value={id}>
                  {id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <div className="px-3 py-2">
          <CapabilityInheritance
            baseAgent={form.baseAgent}
            disabledCapabilities={form.disabledCapabilities ?? []}
            disabled={disabled}
            probe={probe}
            onChange={(disabledCapabilities) =>
              setForm((current) => ({ ...current, disabledCapabilities }))
            }
          />
        </div>
      </SettingsGroup>

      <div className="flex items-center justify-between gap-2">
        <div>
          {existing && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setPendingDelete(true)}
            >
              {t("settings.customAgent.delete")}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("dialog.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => {
              const id =
                existing?.id ??
                `custom:${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
              const agent = parseAgentForm(form, id);
              if (!agent) {
                toast.error(t("settings.customAgent.invalid"));
                return;
              }
              onSubmit(
                existing
                  ? custom.map((entry) =>
                      entry.id === existing.id ? agent : entry,
                    )
                  : [...custom, agent],
              );
            }}
          >
            {t("dialog.save")}
          </Button>
        </div>
      </div>

      <ResponsiveAlertDialog
        open={pendingDelete}
        onOpenChange={setPendingDelete}
      >
        <ResponsiveAlertDialogContent className="z-[var(--z-dialog)]">
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("settings.customAgent.deleteTitle", {
                name: existing?.label ?? "",
              })}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("dialog.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              onClick={() =>
                onSubmit(custom.filter((entry) => entry.id !== existing?.id))
              }
            >
              {t("settings.customAgent.delete")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </>
  );
}
