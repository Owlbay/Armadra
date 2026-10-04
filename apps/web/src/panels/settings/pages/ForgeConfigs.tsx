import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { useT } from "../../../app/preferences-store";
import { SettingsGroup } from "../SettingsGroup";
import { Field, selectClass } from "../../git/forms";
import {
  type ConfigurableForge,
  type ForgeConfig,
  FORGE_NAMES,
  deleteForgeConfig,
  forgeConfigs,
  forgeFailureKey,
  putForgeConfig,
} from "../../../api/forge";

export const forgeConfigKeys = {
  all: ["forge", "configs"] as const,
};

const PLATFORMS: readonly ConfigurableForge[] = ["gitea", "gitlab"];

/** API 根 → 用户填的站点根：表单回填时少一段 `/api/v1`、`/api/v4`。 */
function siteRoot(apiBase: string): string {
  return apiBase.replace(/\/api\/v[14]$/, "");
}

interface Draft {
  repoKey: string;
  forge: ConfigurableForge;
  apiBase: string;
  token: string;
  /** 0 = 新建。 */
  revision: number;
}

const EMPTY: Draft = {
  repoKey: "",
  forge: "gitea",
  apiBase: "",
  token: "",
  revision: 0,
};

/**
 * 设置 → Git 托管里 GitHub 以外的平台（契约 §29.3）：按主机或按仓库选 Gitea /
 * GitLab、地址与令牌。
 *
 * 令牌只往外走一次：password 输入框，永远不回填；core 先用它核验再存，成功后
 * 立即从组件状态清掉。答复只说「有没有令牌」与它属于哪个账号。
 */
export function ForgeConfigs() {
  const t = useT();
  const client = useQueryClient();
  const configs = useQuery({
    queryKey: forgeConfigKeys.all,
    queryFn: forgeConfigs,
    retry: false,
  });
  const [draft, setDraft] = React.useState<Draft | null>(null);

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["forge"] });
  };
  const fail = (error: unknown) => toast.error(t(forgeFailureKey(error)));

  const save = useMutation({
    mutationFn: (input: Draft & { clearToken?: boolean }) =>
      putForgeConfig(input.repoKey.trim().toLowerCase(), {
        forge: input.forge,
        apiBase: input.apiBase.trim(),
        ...(input.clearToken
          ? { token: "" }
          : input.token.trim()
            ? { token: input.token.trim() }
            : {}),
        expectedRevision: input.revision,
      }),
    onSuccess: () => {
      // 令牌在 core 收下的那一刻离开这个组件。
      setDraft(null);
      toast.success(t("forge.settings.saved"));
      refresh();
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (config: ForgeConfig) =>
      deleteForgeConfig(config.repoKey, config.revision),
    onSuccess: () => {
      toast.success(t("forge.settings.removed"));
      refresh();
    },
    onError: fail,
  });

  const busy = save.isPending || remove.isPending;
  const rows = configs.data ?? [];

  return (
    <SettingsGroup title={t("forge.settings.others")}>
      {configs.isError && (
        <p
          role="status"
          className="px-4 py-3 text-[12px] text-destructive"
          data-slot="forge-configs-error"
        >
          {t(forgeFailureKey(configs.error))}
        </p>
      )}
      {configs.data && rows.length === 0 && draft === null && (
        <p className="px-4 py-3 text-[12px] text-muted-foreground">
          {t("forge.settings.empty")}
        </p>
      )}
      {rows.map((config) => (
        <div
          key={config.repoKey}
          data-slot="forge-config"
          data-key={config.repoKey}
          className="flex min-w-0 flex-wrap items-center gap-2 px-4 py-3 text-[12px]"
        >
          <span className="min-w-0 flex-1 truncate font-mono select-text">
            {config.repoKey}
          </span>
          <Badge variant="outline">
            {FORGE_NAMES[config.forge] ?? config.forge}
          </Badge>
          <Badge variant={config.credential ? "secondary" : "outline"}>
            {config.credential
              ? (config.accountLogin ?? t("forge.settings.credential"))
              : t("forge.settings.noCredential")}
          </Badge>
          <Button
            size="sm"
            variant="ghost"
            className="min-h-10"
            disabled={busy}
            onClick={() =>
              setDraft({
                repoKey: config.repoKey,
                forge: config.forge === "gitlab" ? "gitlab" : "gitea",
                apiBase: siteRoot(config.apiBase),
                token: "",
                revision: config.revision,
              })
            }
          >
            {t("forge.settings.edit")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="min-h-10 text-destructive"
            disabled={busy}
            onClick={() => remove.mutate(config)}
          >
            {t("forge.settings.remove")}
          </Button>
        </div>
      ))}
      {draft ? (
        <form
          data-slot="forge-config-form"
          className="flex min-w-0 flex-col gap-3 px-4 py-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || !draft.repoKey.trim() || !draft.apiBase.trim()) return;
            save.mutate(draft);
          }}
        >
          <Field label={t("forge.settings.key")}>
            <Input
              value={draft.repoKey}
              disabled={draft.revision > 0}
              autoComplete="off"
              spellCheck={false}
              placeholder={t("forge.settings.keyPlaceholder")}
              onChange={(event) =>
                setDraft({ ...draft, repoKey: event.target.value })
              }
              className="h-10 min-w-0 font-mono"
            />
          </Field>
          <Field label={t("forge.settings.platform")}>
            <select
              className={selectClass}
              value={draft.forge}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  forge: event.target.value as ConfigurableForge,
                })
              }
            >
              {PLATFORMS.map((value) => (
                <option key={value} value={value}>
                  {FORGE_NAMES[value]}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("forge.settings.apiBase")}>
            <Input
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={draft.apiBase}
              onChange={(event) =>
                setDraft({ ...draft, apiBase: event.target.value })
              }
              className="h-10 min-w-0"
            />
          </Field>
          <Field label={t("forge.settings.token")}>
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              data-slot="forge-token"
              placeholder={
                draft.revision > 0 ? t("forge.settings.tokenKeep") : undefined
              }
              value={draft.token}
              onChange={(event) =>
                setDraft({ ...draft, token: event.target.value })
              }
              className="h-10 min-w-0"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="sm"
              className="min-h-10"
              disabled={busy || !draft.repoKey.trim() || !draft.apiBase.trim()}
            >
              {t("forge.settings.save")}
            </Button>
            {draft.revision > 0 && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="min-h-10"
                disabled={busy}
                onClick={() => save.mutate({ ...draft, clearToken: true })}
              >
                {t("forge.settings.clearToken")}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-10"
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              {t("forge.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="px-4 py-3">
          <Button
            size="sm"
            variant="secondary"
            className="min-h-10"
            disabled={busy || !configs.data}
            onClick={() => setDraft(EMPTY)}
          >
            {t("forge.settings.add")}
          </Button>
        </div>
      )}
    </SettingsGroup>
  );
}
