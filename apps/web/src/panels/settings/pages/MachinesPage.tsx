import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderInput, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  executionHostPackageSchema,
  sshHostSchema,
  type ExecutionHost,
  type SshHost,
} from "@armadra/shared";

import { runtimeApi } from "../../../api/client";
import { useT } from "../../../app/preferences-store";
import { useOpenWorkspace } from "../../../app/workspace-actions";
import { sk } from "../../../sources/scope";
import { useCompactLayout } from "@/platform/layout";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { useSubpage } from "../subpage";
import { useRuntimeSettings } from "../use-runtime-settings";
import { HealthTable, MachinesTable } from "./execution-hosts/MachinesTable";
import { HostKeyDialog } from "./ssh/HostKeyDialog";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Button } from "@/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@/ui/empty";
import { Input } from "@/ui/input";
import { Spinner } from "@/ui/spinner";
import { Switch } from "@/ui/switch";
import { Textarea } from "@/ui/textarea";

export const EXECUTION_HOSTS_KEY = ["execution-hosts"] as const;

/** 执行主机的显示名；一台配置被删掉的主机不显示成「本机」。 */
export function executionHostLabel(
  host: { kind: string; name: string } | undefined,
  id: string,
  t: (key: string) => string,
): string {
  if (!host) return id || t("executionHosts.local");
  return host.kind === "local" ? t("executionHosts.local") : host.name || id;
}

/**
 * 设置里的 SSH 主机与 core 的执行主机是同一台机器的两面：前者是连接参数，
 * 后者是 Worker 状态与工作区数。这里按 SSH 主机的顺序合成一行；core 还没答
 * 执行主机表时，用连接参数补一行，Worker 列显示「未配置」或空。
 */
export function machineRows(
  ssh: readonly SshHost[],
  hosts: readonly ExecutionHost[],
): ExecutionHost[] {
  return ssh.map(
    (entry) =>
      hosts.find((host) => host.executionHostId === entry.id) ?? {
        executionHostId: entry.id,
        name: entry.name,
        kind: "ssh",
        ssh: entry,
        workerConfigured: entry.worker !== undefined,
        workspaceCount: 0,
      },
  );
}

/**
 * 设置 → 远程机器（§2.6）：SSH 主机与执行主机合成一张表。
 *
 * 「验证」一步问完两件事——`ssh` 通不通、那台机器上的 Worker 是不是这个
 * 构建——结果一句话。点名称进子页：连接参数、主机密钥、重新同步、在那台
 * 机器上打开项目、健康记录。表尾是添加、全部重新同步、导入 / 导出。当前
 * 工作区跑在哪台、怎么切换在「工作空间」页。
 *
 * 主机表存在 Runtime 的 `settings.json` 里：PATCH 对数组是整段替换，所以增删
 * 改都是「读整段、改一条、写整段」。
 */
export function MachinesPage() {
  const t = useT();
  const client = useQueryClient();
  const compact = useCompactLayout();
  const subpage = useSubpage();
  const { settings, save } = useRuntimeSettings();
  const [packaging, setPackaging] = React.useState(false);
  const ssh = React.useMemo(
    () => settings.data?.ssh?.hosts ?? [],
    [settings.data],
  );
  const hosts = useQuery({
    queryKey: EXECUTION_HOSTS_KEY,
    queryFn: runtimeApi.executionHosts,
    retry: false,
    // Worker 在线与健康记录跟着 core 变，不等人刷新。
    refetchInterval: 15_000,
  });
  const rows = React.useMemo(
    () => machineRows(ssh, hosts.data ?? []),
    [ssh, hosts.data],
  );

  const validate = useMutation({
    mutationFn: (hostId: string) => runtimeApi.validateExecutionHost(hostId),
    onSuccess: (result) => {
      if (result.workerOk) {
        toast.success(
          t("executionHosts.valid", {
            version: result.runtimeVersion ?? "",
            platform: result.platform ?? "",
            architecture: result.architecture ?? "",
          }),
        );
        return;
      }
      // 只跑终端的机器没有 Worker 是正常的：连得上就是答案。
      if (result.reachable && result.reason === "noWorkerConfigured") {
        toast.success(t("executionHosts.noWorkerConfigured"));
        return;
      }
      // `reason` 是 Runtime 给的稳定键；没有的话显示脱敏后的诊断尾巴。
      const key = result.reason
        ? `executionHosts.${result.reason}`
        : "executionHosts.handshakeRefused";
      toast.error(t(key), { description: result.detail || undefined });
    },
    onError: (cause: Error) =>
      toast.error(t("executionHosts.handshakeRefused"), {
        description: cause.message,
      }),
  });

  // 全部重新同步：配了 Worker 的逐台来（每台都要重连 ssh），一台失败不挡
  // 后面的；最后一句话说清成了几台、哪几台没成。
  const syncable = rows.filter((host) => host.workerConfigured);
  const resyncAll = useMutation({
    mutationFn: async () => {
      const failed: string[] = [];
      for (const host of syncable) {
        try {
          await runtimeApi.resyncExecutionHost(host.executionHostId);
        } catch {
          failed.push(host.name || host.executionHostId);
        }
      }
      return { done: syncable.length - failed.length, failed };
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: EXECUTION_HOSTS_KEY });
      void client.invalidateQueries({ queryKey: ["agent-integration"] });
    },
    onSuccess: ({ done, failed }) => {
      if (failed.length === 0) {
        toast.success(t("executionHosts.fleet.resyncAllDone", { count: done }));
        return;
      }
      toast.error(
        t("executionHosts.fleet.resyncAllFailed", { count: failed.length }),
        { description: failed.join(", ") },
      );
    },
  });

  function write(next: SshHost[]) {
    save.mutate({ ssh: { hosts: next } });
    subpage.close();
  }

  if (subpage.current?.startsWith("ssh:")) {
    const reference = subpage.current.slice("ssh:".length);
    const existing = ssh.find((host) => host.id === reference);
    const row = rows.find((host) => host.executionHostId === reference);
    return (
      <>
        <HostForm
          existing={existing}
          disabled={!settings.data}
          onSubmit={(host) =>
            write(
              existing
                ? ssh.map((entry) => (entry.id === host.id ? host : entry))
                : [...ssh, host],
            )
          }
          onDelete={() =>
            write(ssh.filter((entry) => entry.id !== existing?.id))
          }
          onCancel={subpage.close}
        />
        {existing && <MachineActions host={existing} row={row} />}
      </>
    );
  }

  const add = (
    <Button
      size="sm"
      disabled={!settings.data}
      onClick={() => subpage.open("ssh", "new")}
    >
      <Plus />
      {t("ssh.add")}
    </Button>
  );

  return (
    <>
      {rows.length === 0 ? (
        <SettingsGroup>
          <Empty className="py-6">
            <EmptyHeader>
              <EmptyTitle className="text-[13px] font-normal text-muted-foreground">
                {t("ssh.empty")}
              </EmptyTitle>
            </EmptyHeader>
            <EmptyContent>{add}</EmptyContent>
          </Empty>
        </SettingsGroup>
      ) : (
        <MachinesTable
          hosts={rows}
          compact={compact}
          validating={validate.isPending ? (validate.variables ?? null) : null}
          onValidate={(hostId) => validate.mutate(hostId)}
          onOpen={(hostId) => subpage.open("ssh", hostId)}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        {rows.length > 0 && add}
        {syncable.length > 1 && (
          <Button
            size="sm"
            variant="ghost"
            disabled={resyncAll.isPending}
            onClick={() => resyncAll.mutate()}
          >
            {resyncAll.isPending ? <Spinner aria-hidden /> : <RefreshCw />}
            {t("executionHosts.fleet.resyncAll")}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setPackaging(true)}>
          {t("executionHosts.package")}
        </Button>
      </div>
      <ResponsiveDialog open={packaging} onOpenChange={setPackaging}>
        <ResponsiveDialogContent className="z-[var(--z-dialog)] sm:max-w-lg">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>
              {t("executionHosts.package")}
            </ResponsiveDialogTitle>
          </ResponsiveDialogHeader>
          <PackageGroup
            onImported={() => {
              setPackaging(false);
              void client.invalidateQueries({ queryKey: EXECUTION_HOSTS_KEY });
              void client.invalidateQueries({ queryKey: ["settings"] });
            }}
          />
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  );
}

/**
 * 一台机器子页的下半：主机密钥、重新同步（配了 Worker 时）、在那台机器上
 * 打开项目（配了 Worker 时）、健康记录。
 */
function MachineActions({
  host,
  row,
}: {
  host: SshHost;
  row: ExecutionHost | undefined;
}) {
  const t = useT();
  const client = useQueryClient();
  // 重新同步（契约 §21.2）：重连 Worker、重新握手，再把画布注入同步一次。
  const resync = useMutation({
    mutationFn: () => runtimeApi.resyncExecutionHost(host.id),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: EXECUTION_HOSTS_KEY });
      void client.invalidateQueries({ queryKey: ["agent-integration"] });
      toast.success(
        t("executionHosts.resynced", {
          name: result.name || result.executionHostId,
        }),
      );
    },
    onError: (cause: Error) =>
      toast.error(t("executionHosts.resyncFailed"), {
        description: cause.message,
      }),
  });
  return (
    <>
      <SettingsGroup>
        {host.worker && (
          <SettingsRow label={t("executionHosts.column.worker")}>
            <span className="text-[13px] text-muted-foreground tabular-nums">
              {row?.worker?.outdated
                ? t("executionHosts.worker.outdated")
                : (row?.worker?.version ?? "—")}
            </span>
            <Button
              size="sm"
              variant="secondary"
              disabled={resync.isPending}
              onClick={() => resync.mutate()}
            >
              {resync.isPending ? <Spinner aria-hidden /> : <RefreshCw />}
              {t("executionHosts.resync")}
            </Button>
          </SettingsRow>
        )}
        {host.worker && <OpenRemoteProject host={host} />}
        <SettingsRow label={null}>
          <HostKeyDialog host={host} />
        </SettingsRow>
      </SettingsGroup>
      <HealthTable samples={row?.health ?? []} />
    </>
  );
}

/**
 * 在执行主机上打开一个项目（H02）。
 *
 * 路径是那台机器上的路径，本机不做任何解析：Runtime 通过远端 Worker 的根注册
 * 把它规范化并冻结，主机不可达或 Worker 不匹配时这里失败，而不是悄悄打开一个
 * 读本机文件的工作区。
 */
function OpenRemoteProject({ host }: { host: SshHost }) {
  const t = useT();
  const client = useQueryClient();
  const openWorkspace = useOpenWorkspace();
  const [path, setPath] = React.useState("");
  const open = useMutation({
    mutationFn: (rootPath: string) =>
      runtimeApi.openRemoteWorkspace({
        name: rootPath.split("/").filter(Boolean).at(-1) ?? host.name,
        executionHostId: host.id,
        rootPath,
      }),
    onSuccess: (workspace) => {
      setPath("");
      // 根已在那台机器上证明过，直接切过去，而不是让人再去列表里找一遍。
      openWorkspace(workspace);
      void client.invalidateQueries({ queryKey: sk("workspaces") });
      toast.success(t("ssh.remote.opened", { name: workspace.name }));
    },
    onError: (cause: Error) =>
      toast.error(t("ssh.remote.failed"), { description: cause.message }),
  });
  return (
    <SettingsRow label={t("ssh.remote.path")}>
      <Input
        className="h-8 w-[280px] text-xs"
        aria-label={t("ssh.remote.path")}
        placeholder="/srv/project"
        value={path}
        onChange={(event) => setPath(event.target.value)}
      />
      <Button
        variant="secondary"
        size="sm"
        disabled={open.isPending || path.trim().length === 0}
        onClick={() => open.mutate(path.trim())}
      >
        <FolderInput />
        {t("ssh.remote.open")}
      </Button>
    </SettingsRow>
  );
}

/* --------------------------------- 编辑子页 -------------------------------- */

interface HostForm {
  name: string;
  host: string;
  user: string;
  port: string;
  identityFile: string;
  extraArgs: string;
  /** Where the Armadra Worker is on the far end; empty = terminals only. */
  workerPath: string;
  workerStateDir: string;
}

const EMPTY: HostForm = {
  name: "",
  host: "",
  user: "",
  port: "",
  identityFile: "",
  extraArgs: "",
  workerPath: "",
  workerStateDir: "",
};

function toForm(host: SshHost | undefined): HostForm {
  if (!host) return EMPTY;
  return {
    name: host.name,
    host: host.host,
    user: host.user ?? "",
    port: host.port === undefined ? "" : String(host.port),
    identityFile: host.identityFile ?? "",
    extraArgs: (host.extraArgs ?? []).join(" "),
    workerPath: host.worker?.path ?? "",
    workerStateDir: host.worker?.stateDir ?? "",
  };
}

/**
 * 表单 → 主机。空字符串代表「没填」，要整个字段省掉而不是发空串；
 * 额外参数按空白切分，因为命令是 argv，一个参数就是一个元素。
 */
export function parseHostForm(form: HostForm, id: string): SshHost | null {
  const extraArgs = form.extraArgs.trim().split(/\s+/).filter(Boolean);
  const candidate = {
    id,
    name: form.name.trim(),
    host: form.host.trim(),
    ...(form.user.trim() ? { user: form.user.trim() } : {}),
    ...(form.port.trim() ? { port: Number(form.port) } : {}),
    ...(form.identityFile.trim()
      ? { identityFile: form.identityFile.trim() }
      : {}),
    ...(extraArgs.length > 0 ? { extraArgs } : {}),
    // No Worker path means this host runs terminals and nothing else, which
    // is a different thing from a Worker at an empty path.
    ...(form.workerPath.trim()
      ? {
          worker: {
            path: form.workerPath.trim(),
            ...(form.workerStateDir.trim()
              ? { stateDir: form.workerStateDir.trim() }
              : {}),
          },
        }
      : {}),
  };
  const parsed = sshHostSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function HostForm({
  existing,
  disabled,
  onSubmit,
  onDelete,
  onCancel,
}: {
  existing: SshHost | undefined;
  disabled: boolean;
  onSubmit: (host: SshHost) => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [form, setForm] = React.useState<HostForm>(() => toForm(existing));
  const [pendingDelete, setPendingDelete] = React.useState(false);

  const fields: Array<{ key: keyof HostForm; label: string }> = [
    { key: "name", label: t("ssh.field.name") },
    { key: "host", label: t("ssh.field.host") },
    { key: "user", label: t("ssh.field.user") },
    { key: "port", label: t("ssh.field.port") },
    { key: "identityFile", label: t("ssh.field.identity") },
    { key: "extraArgs", label: t("ssh.field.extraArgs") },
    { key: "workerPath", label: t("ssh.field.workerPath") },
    { key: "workerStateDir", label: t("ssh.field.workerStateDir") },
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
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  [field.key]: event.target.value,
                }))
              }
            />
          </SettingsRow>
        ))}
      </SettingsGroup>

      <div className="flex items-center justify-between gap-2">
        <div>
          {existing && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setPendingDelete(true)}
            >
              {t("ssh.delete")}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("ssh.dialog.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => {
              const host = parseHostForm(
                form,
                existing?.id ?? crypto.randomUUID(),
              );
              if (!host) {
                toast.error(t("ssh.dialog.invalid"));
                return;
              }
              onSubmit(host);
            }}
          >
            {t("ssh.dialog.save")}
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
              {t("ssh.delete.title", { name: existing?.name ?? "" })}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("ssh.dialog.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction onClick={onDelete}>
              {t("ssh.delete")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </>
  );
}

/**
 * 导出 / 导入。
 *
 * 包里只有「机器在哪、Worker 怎么起」，没有任何能用来认证的东西——
 * `identityFile` 是一条路径，由那台机器自己解析。所以把它贴给自己的另一台
 * 设备是安全的，页脚把这一点说出来。
 */
function PackageGroup({ onImported }: { onImported: () => void }) {
  const t = useT();
  const [text, setText] = React.useState("");
  const [overwrite, setOverwrite] = React.useState(false);

  const exportHosts = useMutation({
    mutationFn: runtimeApi.exportExecutionHosts,
    onSuccess: async (result) => {
      const encoded = JSON.stringify(result, null, 2);
      try {
        await navigator.clipboard.writeText(encoded);
        toast.success(t("executionHosts.exported"));
      } catch {
        // 剪贴板可能被拒；把 JSON 放进输入框总比什么都没有强。
        setText(encoded);
      }
    },
    onError: (cause: Error) =>
      toast.error(t("executionHosts.exportFailed"), {
        description: cause.message,
      }),
  });

  const importHosts = useMutation({
    mutationFn: () => {
      const parsed = executionHostPackageSchema.safeParse(safeJson(text));
      if (!parsed.success) throw new Error(t("executionHosts.importInvalid"));
      return runtimeApi.importExecutionHosts({ ...parsed.data, overwrite });
    },
    onSuccess: (result) => {
      setText("");
      onImported();
      toast.success(t("executionHosts.imported", { count: result.length - 1 }));
    },
    onError: (cause: Error) =>
      toast.error(t("executionHosts.importFailed"), {
        description: cause.message,
      }),
  });

  return (
    <SettingsGroup>
      <SettingsRow label={null} footnote={t("executionHosts.packageNote")}>
        <Button
          size="sm"
          variant="secondary"
          disabled={exportHosts.isPending}
          onClick={() => exportHosts.mutate()}
        >
          {t("executionHosts.export")}
        </Button>
      </SettingsRow>
      <div className="flex flex-col gap-2 px-4 py-3">
        <Textarea
          value={text}
          rows={4}
          placeholder={t("executionHosts.importPlaceholder")}
          aria-label={t("executionHosts.import")}
          className="font-mono text-[11px]"
          onChange={(event) => setText(event.target.value)}
        />
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <Switch
              checked={overwrite}
              aria-label={t("executionHosts.importOverwrite")}
              onCheckedChange={setOverwrite}
            />
            {t("executionHosts.importOverwrite")}
          </label>
          <Button
            size="sm"
            disabled={text.trim() === "" || importHosts.isPending}
            onClick={() => importHosts.mutate()}
          >
            {t("executionHosts.importConfirm")}
          </Button>
        </div>
      </div>
    </SettingsGroup>
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
