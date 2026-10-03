import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { runtimeApi } from "../../../api/client";
import { useT } from "../../../app/preferences-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { CONTROL_WIDTH } from "./GeneralPage";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";

const QUERY_KEY = ["ama-credentials"] as const;

/**
 * 设置 → Agent → Armadra Agent 的模型密钥（协调 Agent §7）。
 *
 * 一个供应商一把 key，存在 core 的密钥后端；core 在每次画布启动前把它们写成
 * 0600 的 `auth.json` 交给 ama。这一组只知道「哪家设了」——值写进去就再也读
 * 不回来，输入框保存后清空。
 */
export function AmaKeys({ disabled }: { disabled?: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => runtimeApi.amaCredentials(),
    retry: false,
  });
  const providers = status.data?.providers ?? [];
  const [provider, setProvider] = React.useState<string | undefined>();
  const [key, setKey] = React.useState("");
  const selected = provider ?? providers[0]?.id;

  const save = useMutation({
    mutationFn: () =>
      runtimeApi.setAmaCredential(selected as string, key.trim()),
    onSuccess: (next) => {
      setKey("");
      queryClient.setQueryData(QUERY_KEY, next);
      toast.success(t("agent.amaKeys.saved"));
    },
    onError: () => toast.error(t("agent.amaKeys.failed")),
  });
  const clear = useMutation({
    mutationFn: (id: string) => runtimeApi.clearAmaCredential(id),
    onSuccess: (next) => queryClient.setQueryData(QUERY_KEY, next),
    onError: () => toast.error(t("agent.amaKeys.failed")),
  });

  if (status.isError || (status.data !== undefined && providers.length === 0))
    return null;

  const busy = disabled || status.isLoading || save.isPending;
  const set = providers.filter((entry) => entry.isSet);

  return (
    <SettingsGroup title={t("agent.amaKeys")}>
      <SettingsRow label={t("agent.amaKeys.provider")}>
        <Select value={selected} onValueChange={setProvider} disabled={busy}>
          <SelectTrigger
            aria-label={t("agent.amaKeys.provider")}
            size="sm"
            className={CONTROL_WIDTH}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {providers.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
      <SettingsRow label={t("agent.amaKeys.key")}>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (selected !== undefined && key.trim() !== "") save.mutate();
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            className="h-8 w-[200px] text-xs"
            aria-label={t("agent.amaKeys.key")}
            value={key}
            disabled={busy}
            onChange={(event) => setKey(event.target.value)}
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={busy || selected === undefined || key.trim() === ""}
          >
            {t("agent.amaKeys.save")}
          </Button>
        </form>
      </SettingsRow>
      {set.map((entry) => (
        <SettingsRow key={entry.id} label={entry.id}>
          <span className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              {t("agent.amaKeys.set")}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || clear.isPending}
              onClick={() => clear.mutate(entry.id)}
            >
              {t("agent.amaKeys.clear")}
            </Button>
          </span>
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}
