import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { toast } from "sonner";
import {
  type AdapterInstallJob,
  type AdapterInstallTarget,
  type AgentInfo,
  acpAdapterInstallable,
  acpInstallCommand,
  agentCliInstallable,
} from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { type Translate, useT } from "@/app/preferences-store";
import { integrationKey } from "@/panels/settings/pages/integration/use-integration";
import { Alert, AlertAction, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { ScrollArea } from "@/ui/scroll-area";
import { Spinner } from "@/ui/spinner";

/**
 * 适配器与 CLI 的安装（契约 §39.7、§47）：集成页的 CLI / ACP 两行与新建向导
 * 共用的一份。
 *
 * 任务在 core 的内存里，这里只读它：开始后每秒轮询一次，结束（成功或失败）时
 * 刷新 Agent 列表与这家的集成状态，并给一条提示。读不到（成员没有权限、旧 core
 * 没有这条）就当没有这个入口，不画按钮。
 */

/** 这一行这一样能代装的包属于哪家；表里没有答 `null`。 */
export function installAgentId(
  agent: AgentInfo,
  target: AdapterInstallTarget,
): string | null {
  if (target === "cli") {
    // `custom:` 条目的 CLI 是用户自己的启动程序：不代装，只复制命令。
    if (agent.id.startsWith("custom:")) return null;
    return agentCliInstallable(agent.id) ? agent.id : null;
  }
  // 适配器借基础 CLI 的。
  const id = agent.baseAgent ?? agent.id;
  return acpAdapterInstallable(id) ? id : null;
}

/** 旧名：这一行能代装的适配器属于哪家。 */
export function adapterAgentId(agent: AgentInfo): string | null {
  return installAgentId(agent, "adapter");
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

export const adapterInstallKey = (
  agentId: string | null,
  target: AdapterInstallTarget = "adapter",
) => ["acp-adapter-install", agentId, target] as const;

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export interface InstallJob {
  readonly target: AdapterInstallTarget;
  /** 能代装且读得到任务（有权限）。 */
  readonly available: boolean;
  readonly job: AdapterInstallJob | undefined;
  readonly running: boolean;
  /** 起任务时被拒的码（`npm_not_found`、`adapter_install_busy`…）。 */
  readonly rejected: string | undefined;
  /** 结束态是失败（不在跑）。 */
  readonly failed: boolean;
  readonly install: (reinstall: boolean) => void;
  readonly rollback: () => void;
}

export function useInstallJob(
  agent: AgentInfo,
  target: AdapterInstallTarget,
): InstallJob {
  const t = useT();
  const client = useQueryClient();
  // 适配器只问有 ACP 入口的行（读不到 `acp` 的旧 core 也一样）。
  const agentId =
    target === "adapter" && !agent.acp ? null : installAgentId(agent, target);
  const key = adapterInstallKey(agentId, target);
  const [rejected, setRejected] = React.useState<string | undefined>();
  const query = useQuery({
    queryKey: key,
    queryFn: () => runtimeApi.acpAdapterInstall(agentId as string, target),
    enabled: agentId !== null,
    retry: false,
    refetchInterval: (current) =>
      current.state.data?.state === "running" ? 1000 : false,
  });
  const start = useMutation({
    mutationFn: ({
      reinstall,
      rollback,
    }: {
      reinstall: boolean;
      rollback: boolean;
    }) =>
      runtimeApi.installAcpAdapter(
        agentId as string,
        reinstall,
        target,
        rollback,
      ),
    onMutate: () => setRejected(undefined),
    onSuccess: (job) => client.setQueryData(key, job),
    onError: (cause: Error) => {
      const code = codeOf(cause);
      if (code === "npm_not_found") {
        // 行下那条 Alert 说，附「复制命令」。
        setRejected(code);
      } else if (code === "adapter_install_busy") {
        toast.error(t("integration.install.busy"));
      } else {
        toast.error(cause.message);
      }
    },
  });

  // 从「在装」变成结束：刷新列表与集成状态，给一条提示。打开页面时已经结束的
  // 旧任务不提示。
  const state = query.data?.state;
  const previous = React.useRef(state);
  React.useEffect(() => {
    const before = previous.current;
    previous.current = state;
    if (before !== "running" || state === "running" || !query.data) return;
    void client.invalidateQueries({ queryKey: ["agents"] });
    void client.invalidateQueries({ queryKey: integrationKey(agent.id) });
    if (state === "succeeded") {
      toast.success(
        t("integration.install.done", { name: query.data.package }),
      );
    }
  }, [state, query.data, client, t, agent.id]);

  const running = state === "running" || start.isPending;
  return {
    target,
    available: agentId !== null && query.isSuccess,
    job: query.data,
    running,
    rejected,
    failed: !running && state === "failed",
    install: (reinstall) => start.mutate({ reinstall, rollback: false }),
    rollback: () => start.mutate({ reinstall: true, rollback: true }),
  };
}

/**
 * 一行（CLI 或 ACP）右侧的那一个动作：未装 `secondary`「安装」，已装 `ghost`
 * 「重新安装」；在装时 `Spinner` + 「安装中」，宽度跟着字走、不跳位置。
 */
export function InstallButton({
  install,
  installed,
}: {
  install: InstallJob;
  installed: boolean;
}) {
  const t = useT();
  if (!install.available) return null;
  return (
    <Button
      variant={installed ? "ghost" : "secondary"}
      size="sm"
      disabled={install.running}
      aria-busy={install.running || undefined}
      data-install-target={install.target}
      onClick={() => install.install(installed)}
    >
      {install.running && <Spinner aria-hidden />}
      {t(
        install.running
          ? "integration.action.installing"
          : installed
            ? "integration.action.reinstall"
            : "integration.action.install",
      )}
    </Button>
  );
}

/** 「复制命令」：给不能代装的条目，或没有 npm 时。 */
export function CopyCommandButton({
  command,
  variant = "ghost",
}: {
  command: string;
  variant?: "ghost" | "outline";
}) {
  const t = useT();
  return (
    <Button
      variant={variant}
      size="sm"
      title={command}
      onClick={() => {
        void navigator.clipboard?.writeText(command).then(
          () => toast.success(t("wizard.install.copied")),
          () => undefined,
        );
      }}
    >
      {t("integration.action.copyCommand")}
    </Button>
  );
}

/**
 * 行下那一条失败：`Alert destructive` 单行「{包名} 没有装上」+「重试」「查看
 * 输出」「恢复上一版本」（有上一版本时）。没有 npm 时是「没有找到 npm」+「复制
 * 命令」。一家的 CLI 与 ACP 共用这一条：先看 CLI。
 */
export function InstallFailure({
  agent,
  jobs,
}: {
  agent: AgentInfo;
  jobs: readonly InstallJob[];
}) {
  const t = useT();
  const missingNpm = jobs.find(
    (install) => install.rejected === "npm_not_found",
  );
  if (missingNpm) {
    const command = acpInstallCommand(
      installAgentId(agent, missingNpm.target) ?? agent.id,
      missingNpm.target,
    );
    return (
      <Alert
        variant="destructive"
        className={FAILURE_CLASS}
        data-slot="install-failure"
      >
        <AlertTitle>{t("integration.install.npmMissing")}</AlertTitle>
        {command && (
          <AlertAction className={FAILURE_ACTIONS}>
            <CopyCommandButton command={command} variant="outline" />
          </AlertAction>
        )}
      </Alert>
    );
  }
  const failed = jobs.find((install) => install.failed && install.job);
  if (!failed?.job) return null;
  const job = failed.job;
  // 重新安装后坏了（或装完找不到程序）才有「恢复上一版本」。
  const canRollback =
    job.previousVersion !== undefined && job.installed !== true;
  return (
    <Alert
      variant="destructive"
      className={FAILURE_CLASS}
      data-slot="install-failure"
    >
      <AlertTitle title={failureText(t, job)}>
        {t("integration.install.failed", { name: job.package })}
      </AlertTitle>
      <AlertAction className={FAILURE_ACTIONS}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => failed.install(job.reinstall === true)}
        >
          {t("integration.action.retry")}
        </Button>
        <OutputButton job={job} />
        {canRollback && (
          <Button variant="outline" size="sm" onClick={failed.rollback}>
            {t("integration.action.rollback")}
          </Button>
        )}
      </AlertAction>
    </Alert>
  );
}

/** 在分组卡片里当一行用：与行同样的左右内边距，动作随文字排、不叠在上面。 */
const FAILURE_CLASS =
  "flex flex-wrap items-center justify-between gap-2 rounded-none border-0 px-4 py-2.5 has-data-[slot=alert-action]:pr-4";
const FAILURE_ACTIONS = "static flex items-center gap-1";

/** 「查看输出」：最后 40 行（core 已脱敏），上面一句按码取的原因。 */
function OutputButton({ job }: { job: AdapterInstallJob }) {
  const t = useT();
  const lines = job.output;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" type="button">
          {t("integration.action.output")}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={8}
        className="z-[var(--z-dialog)] w-[28rem] max-w-[calc(100vw-16px)] p-0"
      >
        <div className="flex flex-col gap-2 p-3">
          <p className="text-xs text-[var(--danger-text)]">
            {failureText(t, job)}
          </p>
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
 * 新建向导「需要安装」那一行的直接安装按钮：CLI 没装且能代装 → 装 CLI；CLI 在、
 * 适配器没装且能代装 → 装适配器。
 */
export function WizardInstallButton({ agent }: { agent: AgentInfo }) {
  const t = useT();
  const cli = useInstallJob(agent, "cli");
  const adapter = useInstallJob(agent, "adapter");
  const install = !agent.installed
    ? cli
    : agent.acp?.installed === false
      ? adapter
      : null;
  if (!install?.available) return null;
  return (
    <Button
      variant="secondary"
      size="xs"
      disabled={install.running}
      aria-busy={install.running || undefined}
      onClick={() => install.install(false)}
    >
      {install.running ? (
        <Spinner aria-hidden className="size-3" />
      ) : (
        <Download />
      )}
      {t(
        install.running
          ? "integration.action.installing"
          : "wizard.install.run",
      )}
    </Button>
  );
}
