import { useCallback, useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { toast } from "sonner";

import { currentClient, runtimeApi } from "../../../api/client";
import { hasPairingFragment } from "../../../api/identity";
import { usePreferencesStore, useT } from "../../../app/preferences-store";
import { useAccess } from "../../../app/use-access";
import { useHostConnection } from "../../../host/use-host-connection";
import { revealPath } from "../../../platform";
import { LocalSourceBadge } from "../local-source";
import { useRemoteAccess } from "../remote-access";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { useRuntimeSettings } from "../use-runtime-settings";
import { CONTROL_WIDTH, CrashReportGroup } from "./GeneralPage";
import { DATA_INFO_KEY } from "./SessionsPage";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Input } from "@/ui/input";
import { Spinner } from "@/ui/spinner";
import { Switch } from "@/ui/switch";
import { formatBytes } from "@/lib/format";

/**
 * `settings.terminal.backend`（§15.1 + T01）。
 *
 * `sessionHost` 只有 Windows 有：会话归 `armadra-session-host` 持有，关掉
 * 窗口甚至重启 Runtime 都不结束 CLI。选它的机器上 `auto` 已经是它，显式选
 * 是为了「起不来时报错，而不是悄悄退回会随进程一起死的直连」。
 */
const TERMINAL_BACKENDS = ["auto", "tmux", "direct", "sessionHost"] as const;
type TerminalBackend = (typeof TERMINAL_BACKENDS)[number];

/**
 * 会话休眠等待时长（T03，宿主设计 §7.2）。
 *
 * 过了这么久还没有任何客户端附着，Runtime 就把这个会话的输出投递放慢。
 * **进程不受影响**，回放缓冲照留，一个字节都不丢——只是不再为没人看的画面
 * 每 16 毫秒醒一次。「关闭」是真的关闭，不是「立刻休眠」。
 */
const DORMANT_CHOICES = [
  { seconds: 0, key: "terminal.settings.dormant.off" },
  { seconds: 30, key: "terminal.settings.dormant.30s" },
  { seconds: 120, key: "terminal.settings.dormant.2m" },
  { seconds: 600, key: "terminal.settings.dormant.10m" },
] as const;

/**
 * 节能休眠的阈值（宿主设计 §7.2）。以分钟计、从 15 分钟起：这一条会结束进程，
 * 比上面只放慢投递的那条重得多，秒级的档位只会让人刚切走就丢了现场。
 */
const ECO_IDLE_CHOICES = [
  { minutes: 15, key: "terminal.settings.ecoIdle.15m" },
  { minutes: 30, key: "terminal.settings.ecoIdle.30m" },
  { minutes: 60, key: "terminal.settings.ecoIdle.1h" },
  { minutes: 120, key: "terminal.settings.ecoIdle.2h" },
  { minutes: 240, key: "terminal.settings.ecoIdle.4h" },
] as const;

/**
 * 防休眠策略（T02，终端宿主设计 §9）。
 *
 * 默认是 `manual`：不经用户明确要求，没有任何东西可以让这台机器不睡。
 * 无论选哪一档，生效的都只有「阻止系统空闲睡眠」这一件事。
 */
const POWER_POLICIES = [
  "never",
  "agentSessions",
  "automation",
  "manual",
] as const;
type PowerPolicyChoice = (typeof POWER_POLICIES)[number];

/** 采样间隔。设计 §8 的默认值是 2 秒；关掉面板就不采样，所以这里不给「关」。 */
const SAMPLE_INTERVALS = [1_000, 2_000, 5_000, 15_000] as const;

const GIB = 1024 * 1024 * 1024;
/**
 * 内存提醒阈值（路线图 §4.3「默认 2 GB，可设」）。
 *
 * 这条线是「值得看一眼」，不是「出问题了」：一个跑着构建的 Agent 越过 2 GB
 * 完全正常。所以越线只有变色和一条按会话去重的提醒，没有任何自动处置。
 */
const MEMORY_THRESHOLDS = [1, 2, 4, 8, 16] as const;

/** 断开保留时长（分钟）——§15.2 的 `detachedGraceMinutes`。 */
const GRACE_CHOICES = [
  { minutes: 60, key: "settings.grace.1h" },
  { minutes: 720, key: "settings.grace.12h" },
  { minutes: 1_440, key: "settings.grace.1d" },
  { minutes: 10_080, key: "settings.grace.7d" },
] as const;

/** `logs.retentionDays` 的四个取值；`0` = 永久（Runtime 只接受这几个）。 */
const RETENTION_CHOICES = [7, 30, 90, 0] as const;

/**
 * 设置 → 本机服务（§2.1）：设置作用的那台 core。
 *
 * 连接状态（服务 ID、能力折进「诊断」）谁都看得到；终端会话策略、电源与
 * 资源、数据与崩溃上报读写整台机器的设置，只给 owner。
 */
export function ServicePage() {
  const { member } = useAccess();
  return (
    <>
      <ConnectionGroup />
      {member ? null : (
        <>
          <HostNameGroup />
          <TerminalSessionGroup />
          <PowerGroup />
          <DataGroup />
          <CrashReportGroup />
        </>
      )}
    </>
  );
}

/**
 * 连接状态：打开这一页就查一次，失败时一句原因。查到之后服务 ID、进程 ID
 * 与已装配的面折在「诊断」里。
 */
export function ConnectionGroup() {
  const t = useT();
  const id = useId();
  const { state, check } = useHostConnection();
  const run = useCallback(() => void check(), [check]);
  useEffect(() => {
    // 配对链接由「设备与会话」那一页接住；这里只看连不连得上。
    if (!hasPairingFragment()) run();
  }, [run]);
  const message =
    state.status === "error"
      ? state.messageKey
      : state.status === "idle" && state.cancelled
        ? "host.status.cancelled"
        : `host.status.${state.status}`;

  return (
    <SettingsGroup>
      <SettingsRow label={t("host.row.status")}>
        <span
          id={`${id}-status`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={
            state.status === "error"
              ? "max-w-[320px] text-[13px] break-words text-[var(--danger-text)]"
              : "max-w-[320px] text-[13px] break-words text-muted-foreground"
          }
        >
          {t(message)}
        </span>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={state.status === "checking"}
          onClick={run}
        >
          {state.status === "checking" && (
            <Spinner role="presentation" aria-hidden />
          )}
          {t("host.check")}
        </Button>
      </SettingsRow>
      {state.status === "connected" && (
        <Collapsible className="group/diagnostics">
          <div className="px-4 py-1.5">
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2 text-[13px] font-normal text-muted-foreground"
              >
                <ChevronRight className="transition-transform group-data-[state=open]/diagnostics:rotate-90" />
                {t("host.diagnostics")}
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <dl className="grid min-w-0 gap-3 px-4 pb-3 text-[12px]">
              <div className="min-w-0">
                <dt className="text-muted-foreground">{t("host.identity")}</dt>
                <dd className="mt-1 break-all select-text">
                  {state.hello.sourceId || t("host.legacy")}
                </dd>
              </div>
              {state.hello.hostInstanceId && (
                <div className="min-w-0">
                  <dt className="text-muted-foreground">
                    {t("host.instance")}
                  </dt>
                  <dd className="mt-1 break-all select-text">
                    {state.hello.hostInstanceId}
                  </dd>
                </div>
              )}
              <div className="min-w-0">
                <dt className="text-muted-foreground">
                  {t("host.capabilities")}
                </dt>
                {state.hello.capabilities.length === 0 ? (
                  <dd className="mt-1 text-muted-foreground">
                    {t("host.capability.none")}
                  </dd>
                ) : (
                  state.hello.capabilities.map((name) => (
                    <dd key={name} className="mt-1 break-all select-text">
                      {name}
                    </dd>
                  ))
                )}
              </div>
            </dl>
          </CollapsibleContent>
        </Collapsible>
      )}
    </SettingsGroup>
  );
}

/**
 * 主机名称（契约 §61）：别的设备添加这台主机时的缺省名，也是中转目录里它的
 * 名字。清空恢复成系统主机名（占位就是它）。
 */
function HostNameGroup() {
  const t = useT();
  const queryClient = useQueryClient();
  const { settings, save } = useRuntimeSettings();
  const saved = settings.data?.host?.name ?? "";
  const hello = useQuery({
    queryKey: ["system", "hello"],
    queryFn: () => currentClient().system.hello({}),
    retry: false,
    staleTime: 60_000,
  });
  const [value, setValue] = useState(saved);
  useEffect(() => setValue(saved), [saved]);
  const commit = () => {
    const name = value.trim();
    setValue(name);
    if (!settings.data || name === saved) return;
    save.mutate(
      { host: { name } },
      {
        onSuccess: () =>
          void queryClient.invalidateQueries({ queryKey: ["system", "hello"] }),
      },
    );
  };
  return (
    <SettingsGroup>
      <SettingsRow label={t("host.name")}>
        <LocalSourceBadge path="host.name" />
        <Input
          className={`h-8 ${CONTROL_WIDTH}`}
          aria-label={t("host.name")}
          autoComplete="off"
          spellCheck={false}
          maxLength={128}
          disabled={!settings.data}
          placeholder={hello.data?.systemHostName ?? ""}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

/** 终端会话：后端、休眠、节能、断开保留（Runtime 侧）。 */
function TerminalSessionGroup() {
  const t = useT();
  const { settings, save } = useRuntimeSettings();
  const runtimeTerminal = settings.data?.terminal;
  return (
    <SettingsGroup title={t("host.group.terminal")}>
      <SettingsRow label={t("settings.terminalBackend")}>
        {/* tmux 在这台机器上有、在另一台上没有，所以这一条不跟着账号走。 */}
        <LocalSourceBadge path="terminal.backend" />
        <Select
          value={runtimeTerminal?.backend ?? "auto"}
          disabled={!settings.data}
          onValueChange={(value) =>
            save.mutate({ terminal: { backend: value as TerminalBackend } })
          }
        >
          <SelectTrigger
            aria-label={t("settings.terminalBackend")}
            size="sm"
            className={CONTROL_WIDTH}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {TERMINAL_BACKENDS.map((choice) => (
              <SelectItem key={choice} value={choice}>
                {t(`settings.backend.${choice}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {t("settings.terminalBackend.restart")}
        </p>
      </SettingsRow>

      <SettingsRow
        label={t("terminal.settings.dormantAfter")}
        footnote={t("terminal.settings.dormantAfterHint")}
      >
        <Select
          value={String(runtimeTerminal?.dormantAfterSeconds ?? 120)}
          disabled={!settings.data}
          onValueChange={(value) =>
            save.mutate({ terminal: { dormantAfterSeconds: Number(value) } })
          }
        >
          <SelectTrigger
            aria-label={t("terminal.settings.dormantAfter")}
            size="sm"
            className={CONTROL_WIDTH}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {DORMANT_CHOICES.map((choice) => (
              <SelectItem key={choice.seconds} value={String(choice.seconds)}>
                {t(choice.key)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>

      <SettingsRow
        label={t("terminal.settings.eco")}
        footnote={t("terminal.settings.ecoHint")}
      >
        <Switch
          checked={runtimeTerminal?.ecoMode ?? true}
          disabled={!settings.data}
          aria-label={t("terminal.settings.eco")}
          onCheckedChange={(checked) =>
            save.mutate({ terminal: { ecoMode: checked } })
          }
        />
      </SettingsRow>

      <SettingsRow label={t("terminal.settings.ecoIdle")}>
        <Select
          value={String(runtimeTerminal?.ecoIdleMinutes ?? 30)}
          disabled={!settings.data || runtimeTerminal?.ecoMode === false}
          onValueChange={(value) =>
            save.mutate({ terminal: { ecoIdleMinutes: Number(value) } })
          }
        >
          <SelectTrigger
            aria-label={t("terminal.settings.ecoIdle")}
            size="sm"
            className={CONTROL_WIDTH}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {ECO_IDLE_CHOICES.map((choice) => (
              <SelectItem key={choice.minutes} value={String(choice.minutes)}>
                {t(choice.key)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>

      <SettingsRow label={t("settings.detachedGrace")}>
        <Select
          value={String(runtimeTerminal?.detachedGraceMinutes ?? 1_440)}
          disabled={!settings.data}
          onValueChange={(value) =>
            save.mutate({ terminal: { detachedGraceMinutes: Number(value) } })
          }
        >
          <SelectTrigger
            aria-label={t("settings.detachedGrace")}
            size="sm"
            className={CONTROL_WIDTH}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {GRACE_CHOICES.map((choice) => (
              <SelectItem key={choice.minutes} value={String(choice.minutes)}>
                {t(choice.key)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
    </SettingsGroup>
  );
}

/** 电源与资源：防休眠、采样间隔、内存提醒阈值。 */
function PowerGroup() {
  const t = useT();
  // 阈值存两处：core 的设置（越线发 `resources.threshold`，推送据此叫人，
  // 契约 §27.4）与本地偏好（徽标变色、本机提醒不等设置读回来）。显示以 core
  // 为准。
  const localMemoryWarnBytes = usePreferencesStore(
    (state) => state.sessionMemoryWarnBytes,
  );
  const setMemoryWarnBytes = usePreferencesStore(
    (state) => state.setSessionMemoryWarnBytes,
  );
  const { settings, save } = useRuntimeSettings();
  const memoryWarnBytes =
    settings.data?.resources?.memoryWarnBytes ?? localMemoryWarnBytes;
  return (
    <SettingsGroup title={t("host.group.power")}>
      <SettingsRow
        label={t("resources.power.policyLabel")}
        footnote={t("resources.power.policyHint")}
      >
        {/* 「这台机器可不可以被拖着不睡」——笔记本和构建机的答案不一样。 */}
        <LocalSourceBadge path="power.policy" />
        <Select
          value={settings.data?.power?.policy ?? "manual"}
          disabled={!settings.data}
          onValueChange={(value) =>
            save.mutate({ power: { policy: value as PowerPolicyChoice } })
          }
        >
          <SelectTrigger
            aria-label={t("resources.power.policyLabel")}
            size="sm"
            className={CONTROL_WIDTH}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {POWER_POLICIES.map((policy) => (
              <SelectItem key={policy} value={policy}>
                {t(`resources.power.policy.${policy}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>

      <SettingsRow
        label={t("resources.power.whileWorkingLabel")}
        footnote={t("resources.power.whileWorkingHint")}
      >
        <LocalSourceBadge path="power.keepAwakeWhileWorking" />
        <Switch
          checked={settings.data?.power?.keepAwakeWhileWorking ?? true}
          disabled={!settings.data}
          aria-label={t("resources.power.whileWorkingLabel")}
          onCheckedChange={(checked) =>
            save.mutate({ power: { keepAwakeWhileWorking: checked } })
          }
        />
      </SettingsRow>

      <SettingsRow
        label={t("resources.intervalLabel")}
        footnote={t("resources.intervalHint")}
      >
        <Select
          value={String(settings.data?.resources?.intervalMs ?? 2_000)}
          disabled={!settings.data}
          onValueChange={(value) =>
            save.mutate({ resources: { intervalMs: Number(value) } })
          }
        >
          <SelectTrigger
            aria-label={t("resources.intervalLabel")}
            size="sm"
            className={CONTROL_WIDTH}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {SAMPLE_INTERVALS.map((interval) => (
              <SelectItem key={interval} value={String(interval)}>
                {t("resources.interval.value", { value: interval / 1_000 })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>

      <SettingsRow
        label={t("resources.memory.thresholdLabel")}
        footnote={t("resources.memory.thresholdHint")}
      >
        <Select
          value={String(memoryWarnBytes)}
          onValueChange={(value) => {
            setMemoryWarnBytes(Number(value));
            save.mutate({ resources: { memoryWarnBytes: Number(value) } });
          }}
        >
          <SelectTrigger
            aria-label={t("resources.memory.thresholdLabel")}
            size="sm"
            className={CONTROL_WIDTH}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {MEMORY_THRESHOLDS.map((gigabytes) => (
              <SelectItem key={gigabytes} value={String(gigabytes * GIB)}>
                {t("resources.memory.threshold.value", { value: gigabytes })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
    </SettingsGroup>
  );
}

/**
 * 数据：目录、数据库大小、备份与日志保留，都来自 `GET /api/data/info`；
 * 会话索引的条数与重建在「会话」页。
 */
function DataGroup() {
  const t = useT();
  const queryClient = useQueryClient();
  const { settings, save } = useRuntimeSettings();
  // 数据目录在设置作用的那台 core 上：远端时「在访达中打开」打开的是眼前这台
  // 机器上一个不存在的路径，不列。
  const { remote } = useRemoteAccess();
  const info = useQuery({
    queryKey: DATA_INFO_KEY,
    queryFn: runtimeApi.dataInfo,
    retry: false,
  });
  const backup = useMutation({
    mutationFn: runtimeApi.backupData,
    onSuccess: (result) =>
      toast.success(t("settings.backup.done", { path: result.path })),
    onError: (cause: Error) =>
      toast.error(t("settings.backup.failed"), { description: cause.message }),
  });
  const retention =
    settings.data?.logs?.retentionDays ??
    info.data?.boardLogRetentionDays ??
    30;
  return (
    <SettingsGroup title={t("host.group.data")}>
      <SettingsRow label={t("settings.dataDir")}>
        <span className="max-w-[280px] truncate text-[11px] text-muted-foreground">
          {info.data?.dataDir ?? "—"}
        </span>
        {!remote && (
          <Button
            variant="secondary"
            size="sm"
            disabled={!info.data}
            onClick={() => {
              const dir = info.data?.dataDir;
              if (!dir) return;
              void revealPath(dir).then((outcome) => {
                // 三种结局都说一声：这个按钮以前失败时完全没有反馈，
                // 点下去什么也不发生就只能读成「应用坏了」。
                if (outcome === "copied")
                  toast.success(t("settings.reveal.copied"));
                else if (outcome === "failed")
                  toast.error(t("settings.reveal.failed"), {
                    description: dir,
                  });
              });
            }}
          >
            {t("settings.reveal")}
          </Button>
        )}
      </SettingsRow>

      <SettingsRow label={t("settings.dbSize")}>
        <span className="text-[13px] tabular-nums text-muted-foreground">
          {info.data ? formatBytes(info.data.dbBytes) : "—"}
        </span>
      </SettingsRow>

      <SettingsRow label={t("settings.backup")}>
        <Button
          variant="secondary"
          size="sm"
          disabled={backup.isPending}
          onClick={() => backup.mutate()}
        >
          {t("settings.backup.run")}
        </Button>
      </SettingsRow>
      <SettingsRow label={t("settings.logRetention")}>
        <Select
          value={String(retention)}
          disabled={!settings.data}
          onValueChange={(value) => {
            save.mutate(
              { logs: { retentionDays: Number(value) } },
              {
                onSuccess: () =>
                  void queryClient.invalidateQueries({
                    queryKey: DATA_INFO_KEY,
                  }),
              },
            );
          }}
        >
          <SelectTrigger
            aria-label={t("settings.logRetention")}
            size="sm"
            className={CONTROL_WIDTH}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {RETENTION_CHOICES.map((days) => (
              <SelectItem key={days} value={String(days)}>
                {t(`settings.retention.${days}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
    </SettingsGroup>
  );
}
