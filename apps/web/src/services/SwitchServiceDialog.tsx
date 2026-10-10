import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";

import { listSources, renameSource } from "../api/remote-services";
import { RUNTIME_VIA_SERVER_SHELL } from "../api/request";
import { usePreferencesStore, useT } from "../app/preferences-store";
import { SOURCES_QUERY_KEY } from "../panels/settings/pages/RemoteAccessPage";
import { isDesktop } from "../platform";
import { applySourceTable } from "../sources/bootstrap";
import type { SourceConnection } from "../sources/connection";
import {
  useCurrentSource,
  useSourceRegistry,
  useSources,
} from "../sources/context";
import { hostedRelay } from "../sources/hosted";
import type { SourceState } from "../sources/types";
import { useCanvasStore } from "../store/canvas-store";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Button } from "@/ui/button";
import type { ServiceStatus } from "./probe";
import { type ServiceRow, serviceRowOf } from "./rows";
import { ServicePicker } from "./ServicePicker";
import {
  canOpenSourceWindow,
  openSourceWindow,
  useServiceSwitcher,
} from "./switcher";

/** 连接状态 → 选择页的三态：连上是在线，连不上是离线，其余（连接中、要登录）未知。 */
export function serviceStatusOf(state: SourceState): ServiceStatus {
  if (state === "ready") return "online";
  if (state === "offline") return "offline";
  return "unknown";
}

/** 每个源的连接状态（任一个变了就重算）。 */
function useStates(
  connections: readonly SourceConnection[],
): Record<string, ServiceStatus> {
  const read = React.useCallback(
    () =>
      Object.fromEntries(
        connections.map((connection) => [
          connection.descriptor.sourceId,
          connection.descriptor.kind === "local"
            ? ("online" as const)
            : serviceStatusOf(connection.status.state),
        ]),
      ),
    [connections],
  );
  const [states, setStates] = React.useState(read);
  React.useEffect(() => {
    setStates(read());
    const stops = connections.map((connection) =>
      connection.subscribe(() => setStates(read())),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [connections, read]);
  return states;
}

/** 有本机 core 的页面（桌面壳、服务器壳）才问源表要远程服务的名字。 */
function hasLocalCore(): boolean {
  return (isDesktop() || RUNTIME_VIA_SERVER_SHELL) && hostedRelay() === null;
}

/**
 * 桌面「切换服务」对话框（A7-1，多端入口设计 §1.3）：同一个列表，行尾「切换」
 * 换当前源（不带源前缀的查询随之重置，`useSourceSwitchCacheReset`），桌面壳
 * 再多一个「在新窗口打开」。手机宽度是底部 Sheet（`ResponsiveDialog`）。
 */
export function SwitchServiceDialog() {
  const open = useServiceSwitcher((state) => state.open);
  const setOpen = useServiceSwitcher((state) => state.setOpen);
  return (
    <ResponsiveDialog open={open} onOpenChange={setOpen}>
      <ResponsiveDialogContent
        data-testid="switch-service-dialog"
        className="sm:max-w-lg"
      >
        <ResponsiveDialogHeader>
          <SwitchTitle />
        </ResponsiveDialogHeader>
        {open && <SwitchBody onDone={() => setOpen(false)} />}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function SwitchTitle() {
  const t = useT();
  return <ResponsiveDialogTitle>{t("services.switch")}</ResponsiveDialogTitle>;
}

function SwitchBody({ onDone }: { onDone: () => void }) {
  const t = useT();
  const registry = useSourceRegistry();
  const connections = useSources();
  const current = useCurrentSource();
  const statuses = useStates(connections);
  const table = useQuery({
    queryKey: SOURCES_QUERY_KEY,
    queryFn: listSources,
    retry: false,
    enabled: hasLocalCore(),
  });
  const names = React.useMemo(
    () =>
      new Map(
        (table.data?.remotes ?? []).map((remote) => [
          remote.issuer,
          remote.label,
        ]),
      ),
    [table.data],
  );
  const localRow = table.data?.sources.find(
    (source) => source.kind === "local",
  );
  const localLabel = localRow?.label ?? "";
  const localDefault = localRow?.defaultLabel || localLabel;
  const rows = React.useMemo(
    (): ServiceRow[] =>
      connections.map((connection) => {
        const row = serviceRowOf(connection.descriptor, {
          serviceName: (issuer) => names.get(issuer) ?? "",
        });
        // 本机行：源表里本机那一行的名字（主机名称），没有才写「本机」。
        return row.local && row.name === ""
          ? {
              ...row,
              name: localLabel || t("remote.kind.local"),
              defaultName: localDefault,
            }
          : row;
      }),
    [connections, names, localLabel, localDefault, t],
  );
  const client = useQueryClient();
  // 改名经本机 core 的源表（契约 §61）；本机行在源表里的标识是它的 hostId。
  const rename = async (sourceId: string, label: string) => {
    const local = connections.find(
      (connection) => connection.descriptor.sourceId === sourceId,
    )?.descriptor.kind;
    const target = local === "local" ? localRow?.sourceId : sourceId;
    if (target === undefined) return;
    await renameSource(target, label);
    const fresh = await client.fetchQuery({
      queryKey: SOURCES_QUERY_KEY,
      queryFn: listSources,
      staleTime: 0,
    });
    await applySourceTable(fresh.sources);
  };
  const newWindow = canOpenSourceWindow();

  const select = (sourceId: string) => {
    registry.setCurrent(sourceId);
    onDone();
    // 侧栏滚到那一组（组头带着 `data-source-group`）。
    globalThis.requestAnimationFrame?.(() => {
      document
        .querySelector(`[data-source-group="${CSS.escape(sourceId)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  };

  return (
    <>
      <div className="max-h-[60dvh] overflow-y-auto">
        <ServicePicker
          variant="dialog"
          rows={rows}
          currentId={current.descriptor.sourceId}
          statuses={statuses}
          onEnter={select}
          {...(hasLocalCore() && table.data ? { onRename: rename } : {})}
          {...(newWindow
            ? {
                onOpenWindow: (sourceId: string) => {
                  void openSourceWindow(sourceId);
                  onDone();
                },
              }
            : {})}
        />
      </div>
      {hasLocalCore() && (
        <ResponsiveDialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onDone();
              // 添加连接在设置 → 远程访问（加远程服务、通过链接加入）。
              usePreferencesStore
                .getState()
                .setLastSettingsSection("remoteAccess");
              useCanvasStore.getState().setPanel("settings", true);
            }}
          >
            <Plus data-icon="inline-start" />
            {t("mobileConnect.add")}
          </Button>
        </ResponsiveDialogFooter>
      )}
    </>
  );
}
