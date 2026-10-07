import { activeSourceId, unscoped } from "@/sources/scope";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCw, X } from "lucide-react";
import { toast } from "sonner";

import { onWorkspaceConnection } from "@/api/events";
import { useT } from "@/app/preferences-store";
import { useAccess } from "@/app/use-access";
import { agentColorVar } from "@/agent/launch";
import { useAgentStatusStore } from "@/agent/status-store";
import { requestCenterOnNode } from "@/canvas/flow/flow-context";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/format";
import { terminalHandle } from "@/nodes/terminal-registry";
import { WorkPanelSheet } from "@/panels/WorkPanelSheet";
import { useCanvasStore } from "@/store/canvas-store";
import { AgentAvatar } from "@/ui/agent-avatar";
import { Alert, AlertAction, AlertTitle } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@/ui/empty";
import { IconButton } from "@/ui/icon-button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/ui/item";
import { ScrollArea } from "@/ui/scroll-area";
import { SheetTitle } from "@/ui/sheet";
import { Skeleton } from "@/ui/skeleton";
import { Spinner } from "@/ui/spinner";
import { StatusPill } from "@/ui/status-pill";
import { coordinatorApi, coordinatorKeys } from "./api";
import {
  type DispatchMember,
  type DispatchModel,
  buildDispatch,
} from "./model";
import { closeDispatchDrawer, useDispatchTarget } from "./store";

/**
 * 协调者（ama）的分派抽屉（设计系统 §5.4）：右侧 `--drawer-w`，ama 一行、
 * 成员一行一个（左侧 2px Agent 色、状态胶囊、耗时）、汇总便签「打开」、失败
 * 行「重试」（契约 §15.7：把任务提示词从 ama 再投一次）。
 *
 * 五态（§5.16）：空 → 一句 + 聚焦 ama；加载 → Skeleton；错误 → 行内
 * `Alert destructive` + 重试；权限 → 不能起 Agent 的人看到「只读」而不是
 * 「重试」；离线 → 顶部 `Alert`，整棵树置灰、按钮禁用。
 */

export interface DispatchViewProps {
  readonly model: DispatchModel;
  readonly loading?: boolean;
  readonly error?: boolean;
  readonly offline?: boolean;
  /** 能不能重试（`agent:launch`）。 */
  readonly canRetry?: boolean;
  /** 正在重试的任务。 */
  readonly retrying?: string | null;
  readonly onReload?: () => void;
  readonly onRetry?: (taskId: string) => void;
  readonly onOpen?: (nodeId: string) => void;
  readonly onFocusLead?: () => void;
}

/** 纯展示：真抽屉与展示页共用。 */
export function DispatchView({
  model,
  loading = false,
  error = false,
  offline = false,
  canRetry = true,
  retrying = null,
  onReload,
  onRetry,
  onOpen,
  onFocusLead,
}: DispatchViewProps) {
  const t = useT();
  const empty =
    !loading && model.members.length === 0 && model.summaries.length === 0;

  return (
    <div data-slot="dispatch-view" className="flex min-w-0 flex-col gap-3 p-3">
      {offline ? (
        <Alert data-slot="dispatch-offline">
          <AlertTitle className="text-xs">
            {t("coordinator.offline")}
          </AlertTitle>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive" data-slot="dispatch-error">
          <AlertTitle className="text-xs">{t("coordinator.error")}</AlertTitle>
          {onReload ? (
            <AlertAction>
              <Button size="xs" variant="outline" onClick={onReload}>
                {t("coordinator.reload")}
              </Button>
            </AlertAction>
          ) : null}
        </Alert>
      ) : null}

      <div
        data-slot="dispatch-tree"
        data-offline={offline ? "true" : undefined}
        aria-disabled={offline || undefined}
        className={cn("flex min-w-0 flex-col gap-1", offline && "opacity-50")}
      >
        {model.lead ? (
          <Item size="xs" className="px-2" data-slot="dispatch-lead">
            <ItemMedia>
              <AgentAvatar agentId={model.lead.agentId || "ama"} size={20} />
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle className="w-full min-w-0">
                <span className="truncate">{model.lead.title}</span>
              </ItemTitle>
            </ItemContent>
            {model.lead.status ? (
              <ItemActions>
                <StatusPill
                  tone={model.lead.status.tone}
                  label={t(model.lead.status.label)}
                />
              </ItemActions>
            ) : null}
          </Item>
        ) : null}

        {loading ? (
          <div
            className="flex flex-col gap-2 pl-3"
            data-slot="dispatch-loading"
          >
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : empty && !error ? (
          <Empty className="border-0 p-6" data-slot="dispatch-empty">
            <EmptyHeader>
              <EmptyTitle className="text-[13px] font-normal text-muted-foreground">
                {t("coordinator.empty")}
              </EmptyTitle>
            </EmptyHeader>
            {onFocusLead ? (
              <EmptyContent>
                <Button size="sm" disabled={offline} onClick={onFocusLead}>
                  {t("coordinator.empty.focus")}
                </Button>
              </EmptyContent>
            ) : null}
          </Empty>
        ) : (
          <ItemGroup className="gap-1 pl-3" data-slot="dispatch-members">
            {model.members.map((member) => (
              <MemberRow
                key={member.nodeId}
                member={member}
                offline={offline}
                canRetry={canRetry}
                retrying={retrying === member.taskId}
                {...(onRetry ? { onRetry } : {})}
                {...(onOpen ? { onOpen } : {})}
              />
            ))}
            {model.summaries.map((summary) => (
              <Item
                key={summary.nodeId}
                size="xs"
                variant="muted"
                className="px-2"
                data-slot="dispatch-summary"
              >
                <ItemContent className="min-w-0">
                  <ItemTitle className="w-full min-w-0 font-normal">
                    <span className="truncate">
                      {t("coordinator.summary", {
                        title: summary.title || t("coordinator.untitled"),
                      })}
                    </span>
                  </ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={offline}
                    onClick={() => onOpen?.(summary.nodeId)}
                  >
                    {t("coordinator.open")}
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
      </div>
    </div>
  );
}

function MemberRow({
  member,
  offline,
  canRetry,
  retrying,
  onRetry,
  onOpen,
}: {
  member: DispatchMember;
  offline: boolean;
  canRetry: boolean;
  retrying: boolean;
  onRetry?: (taskId: string) => void;
  onOpen?: (nodeId: string) => void;
}) {
  const t = useT();
  const failed = member.status.tone === "failed";
  return (
    <Item
      size="xs"
      className="rounded-none border-0 border-l-2 px-2"
      style={{ borderLeftColor: agentColorVar(member.agentId) }}
      data-slot="dispatch-member"
      data-node-id={member.nodeId}
      data-tone={member.status.tone}
    >
      <ItemMedia>
        <AgentAvatar agentId={member.agentId || "custom:"} size={20} />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="w-full min-w-0">
          <Button
            variant="link"
            className="h-auto min-w-0 justify-start p-0 text-foreground"
            disabled={offline}
            onClick={() => onOpen?.(member.nodeId)}
          >
            <span className="truncate">
              {member.title || t("coordinator.untitled")}
            </span>
          </Button>
        </ItemTitle>
      </ItemContent>
      <ItemActions className="gap-2">
        <StatusPill tone={member.status.tone} label={t(member.status.label)} />
        {member.elapsedMs !== null ? (
          <span className="text-[length:var(--text-caption)] text-muted-foreground tabular-nums">
            {formatDuration(member.elapsedMs)}
          </span>
        ) : null}
        {failed && member.taskId !== null && member.retryable ? (
          canRetry ? (
            <Button
              size="xs"
              variant="outline"
              disabled={offline || retrying}
              data-slot="dispatch-retry"
              onClick={() => onRetry?.(member.taskId as string)}
            >
              {retrying ? (
                <Spinner aria-label={t("coordinator.retrying")} />
              ) : null}
              {t("coordinator.retry")}
            </Button>
          ) : (
            <Badge variant="outline">{t("coordinator.readOnly")}</Badge>
          )
        ) : null}
      </ItemActions>
    </Item>
  );
}

/* ------------------------------- 真抽屉 ------------------------------- */

/** 抽屉开着时多久重读一次任务行。没有专门的事件（契约 §15.7）。 */
const POLL_MS = 5_000;

function useWorkspaceOnline(workspaceId: string | null): boolean {
  const [online, setOnline] = React.useState(true);
  React.useEffect(() => {
    if (!workspaceId) return;
    setOnline(true);
    return onWorkspaceConnection((id, next, from) => {
      if (id === workspaceId && from === activeSourceId()) setOnline(next);
    });
  }, [workspaceId]);
  return online;
}

/** 选中、居中，终端就把键盘焦点交给它。 */
function revealNode(nodeId: string, focusInput = false): void {
  useCanvasStore.getState().selectNodes([nodeId]);
  requestCenterOnNode(nodeId);
  if (focusInput) terminalHandle(nodeId)?.focus();
}

export function DispatchDrawer() {
  const t = useT();
  const mode = useCanvasStore((state) => state.panels.dispatch);
  const boardId = useCanvasStore((state) => state.boardId);
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const document = useCanvasStore((state) => state.document);
  const coordinatorId = useDispatchTarget((state) => state.nodeId);
  const statuses = useAgentStatusStore((state) => state.statuses);
  const access = useAccess();
  const online = useWorkspaceOnline(workspaceId);
  const client = useQueryClient();
  const open = mode === "drawer";

  const tasks = useQuery({
    queryKey: coordinatorKeys.tasks(boardId ?? ""),
    queryFn: () => coordinatorApi.tasks(boardId as string),
    enabled: open && Boolean(boardId),
    refetchInterval: open ? POLL_MS : false,
    retry: false,
  });

  // 耗时跟着走：运行中的那几行每秒一跳太吵，跟着重读的节奏就够。
  const now = tasks.dataUpdatedAt || Date.now();
  const model = React.useMemo(() => {
    const states: Record<string, (typeof statuses)[string]["state"]> = {};
    // 只取当前源的那些，键还原成节点 id。
    const here = activeSourceId();
    for (const [key, status] of Object.entries(statuses)) {
      const { sourceId, id } = unscoped(key);
      if (sourceId === here) states[id] = status.state;
    }
    return buildDispatch({
      coordinatorId,
      nodes: document?.nodes ?? [],
      edges: document?.edges ?? [],
      tasks: tasks.data ?? [],
      states,
      now,
    });
  }, [coordinatorId, document, tasks.data, statuses, now]);

  const retry = useMutation({
    mutationFn: (taskId: string) => coordinatorApi.retry(taskId),
    onSuccess: () =>
      void client.invalidateQueries({
        queryKey: coordinatorKeys.tasks(boardId ?? ""),
      }),
    onError: () => toast.error(t("coordinator.retryFailed")),
  });

  return (
    <WorkPanelSheet panel="dispatch" open={open} onClose={closeDispatchDrawer}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
        <SheetTitle className="flex-1 truncate text-[13px] font-semibold">
          {t("coordinator.title")}
        </SheetTitle>
        <IconButton
          label={t("coordinator.reload")}
          onClick={() => void tasks.refetch()}
        >
          <RotateCw />
        </IconButton>
        <IconButton
          label={t("coordinator.close")}
          onClick={closeDispatchDrawer}
        >
          <X />
        </IconButton>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <DispatchView
          model={model}
          loading={tasks.isPending && tasks.fetchStatus !== "idle"}
          error={tasks.isError}
          offline={!online}
          canRetry={access.can("agent:launch", workspaceId ?? "")}
          retrying={retry.isPending ? (retry.variables ?? null) : null}
          onReload={() => void tasks.refetch()}
          onRetry={(taskId) => retry.mutate(taskId)}
          onOpen={(nodeId) => revealNode(nodeId)}
          onFocusLead={() => {
            if (coordinatorId) revealNode(coordinatorId, true);
          }}
        />
      </ScrollArea>
    </WorkPanelSheet>
  );
}
