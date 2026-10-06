import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  type AcpAdapterAgentId,
  type AdapterInstallJob,
  type AgentInfo,
  acpAdapterInstallable,
} from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { type Translate, useT } from "@/app/preferences-store";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { ScrollArea } from "@/ui/scroll-area";
import { Spinner } from "@/ui/spinner";

/**
 * ACP 适配器的安装（契约 §39.7）：集成页每行与新建向导共用的一份。
 *
 * 任务在 core 的内存里，这里只读它：开始后每秒轮询一次，结束（成功或失败）时
 * 刷新 Agent 列表并给一条提示。读不到（成员没有权限、旧 core 没有这条）就当
 * 没有这个入口，不画按钮。
 */

/** 这一行能代装的适配器属于哪家；`custom:` 条目借它的基础 CLI。 */
export function adapterAgentId(agent: AgentInfo): AcpAdapterAgentId | null {
  const id = agent.baseAgent ?? agent.id;
  return acpAdapterInstallable(id) ? id : null;
}

const FAILURE_KEYS = {
  adapter_install_failed: "integration.acp.failure.failed",
  adapter_install_timeout: "integration.acp.failure.timeout",
  adapter_install_missing: "integration.acp.failure.missing",
} as const;

/** 失败的那句话：按码取文案，不展示 core 的原话。 */
export function failureText(t: Translate, job: AdapterInstallJob): string {
  const code = job.failure?.code ?? "adapter_install_failed";
  return t(FAILURE_KEYS[code], { code: String(job.exitCode ?? "—") });
}

export const adapterInstallKey = (agentId: string | null) =>
  ["acp-adapter-install", agentId] as const;

export function useAdapterInstall(agent: AgentInfo) {
  const t = useT();
  const client = useQueryClient();
  // 没有 ACP 入口的行不问（读不到 `acp` 的旧 core 也一样）。
  const agentId = agent.acp ? adapterAgentId(agent) : null;
  const key = adapterInstallKey(agentId);
  const query = useQuery({
    queryKey: key,
    queryFn: () => runtimeApi.acpAdapterInstall(agentId as string),
    enabled: agentId !== null,
    retry: false,
    refetchInterval: (current) =>
      current.state.data?.state === "running" ? 1000 : false,
  });
  const start = useMutation({
    mutationFn: (reinstall: boolean) =>
      runtimeApi.installAcpAdapter(agentId as string, reinstall),
    onSuccess: (job) => client.setQueryData(key, job),
    onError: (cause: Error) =>
      toast.error(t("integration.acp.failed"), { description: cause.message }),
  });

  // 从「在装」变成结束：刷新列表（`acp.installed`），给一条提示。打开页面时
  // 已经结束的旧任务不提示。
  const state = query.data?.state;
  const previous = React.useRef(state);
  React.useEffect(() => {
    const before = previous.current;
    previous.current = state;
    if (before !== "running" || state === "running" || !query.data) return;
    void client.invalidateQueries({ queryKey: ["agents"] });
    if (state === "succeeded") {
      toast.success(t("integration.acp.done", { name: agent.label }));
    } else if (state === "failed") {
      toast.error(t("integration.acp.failed"), {
        description: failureText(t, query.data),
      });
    }
  }, [state, query.data, client, t, agent.label]);

  return {
    /** `null` = 这家没有可代装的适配器，或读不到任务（没有权限）。 */
    available: agentId !== null && query.isSuccess,
    job: query.data,
    running: state === "running" || start.isPending,
    install: (reinstall: boolean) => start.mutate(reinstall),
  };
}

/**
 * 集成页一行里的 ACP 状态：徽标 + 「安装 / 重新安装」。在装与失败时徽标可以
 * 点开看输出尾部（失败时上面是那句原因）。
 */
export function AdapterInstallStatus({ agent }: { agent: AgentInfo }) {
  const t = useT();
  const { available, job, running, install } = useAdapterInstall(agent);
  const acp = agent.acp;
  if (!acp) return null;
  const installed = acp.installed;

  if (!available) {
    // 没有代装入口：只说没装（与以前一样），装好了不多画一个徽标。
    return installed ? null : (
      <Badge variant="outline">{t("integration.acp.missing")}</Badge>
    );
  }

  const failed = !running && job?.state === "failed";
  const status = running ? (
    <OutputBadge job={job} label={t("integration.acp.installing")} busy />
  ) : failed && job ? (
    <OutputBadge job={job} label={t("integration.acp.failed")} failed />
  ) : (
    <Badge
      variant={installed ? "secondary" : "outline"}
      title={acp.version ? `${acp.program} ${acp.version}` : acp.program}
    >
      {t(installed ? "integration.acp.installed" : "integration.acp.missing")}
    </Badge>
  );

  return (
    <span className="inline-flex items-center gap-1.5" data-slot="acp-install">
      {status}
      <Button
        variant="outline"
        size="xs"
        disabled={running}
        onClick={() => install(installed)}
      >
        {installed ? <RefreshCw /> : <Download />}
        {t(installed ? "integration.acp.reinstall" : "integration.acp.install")}
      </Button>
    </span>
  );
}

/** 可以点开看输出的徽标：在装（转圈）或失败（红色，上面是原因）。 */
function OutputBadge({
  job,
  label,
  busy = false,
  failed = false,
}: {
  job: AdapterInstallJob | undefined;
  label: string;
  busy?: boolean;
  failed?: boolean;
}) {
  const t = useT();
  const lines = job?.output ?? [];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Badge asChild variant={failed ? "destructive" : "outline"}>
          <Button
            variant="ghost"
            size="xs"
            type="button"
            aria-live="polite"
            className={failed ? "text-destructive" : undefined}
            data-state-kind={failed ? "failed" : "running"}
          >
            {busy && <Spinner aria-hidden className="size-3" />}
            {label}
          </Button>
        </Badge>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        className="z-[var(--z-dialog)] w-[28rem] max-w-[calc(100vw-16px)] p-0"
      >
        <div className="flex flex-col gap-2 p-3">
          {failed && job && (
            <p className="text-xs text-destructive">{failureText(t, job)}</p>
          )}
          <span className="text-xs font-medium text-muted-foreground">
            {t("integration.acp.output")}
          </span>
          <ScrollArea className="max-h-60">
            <pre
              className="font-mono text-[11px] leading-4 break-all whitespace-pre-wrap text-muted-foreground"
              data-slot="acp-install-output"
            >
              {lines.length > 0 ? lines.join("\n") : "—"}
            </pre>
          </ScrollArea>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * 新建向导「需要安装」那一行的直接安装按钮：只在 CLI 已装、适配器没装、这家
 * 能代装时出现。
 */
export function WizardInstallButton({ agent }: { agent: AgentInfo }) {
  const t = useT();
  const { available, running, install } = useAdapterInstall(agent);
  if (!available || !agent.installed || agent.acp?.installed !== false) {
    return null;
  }
  return (
    <Button
      variant="secondary"
      size="xs"
      disabled={running}
      onClick={() => install(false)}
    >
      {running ? <Spinner aria-hidden className="size-3" /> : <Download />}
      {t(running ? "integration.acp.installing" : "wizard.install.run")}
    </Button>
  );
}
