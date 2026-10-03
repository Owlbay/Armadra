import * as React from "react";
import { toast } from "sonner";
import type { AcpSessionUpdate, TerminalNodeData } from "@armadra/shared";

import { onWorkspaceConnection, onWorkspaceEvent } from "@/api/events";
import { useT } from "@/app/preferences-store";
import { useAccess } from "@/app/use-access";
import { isResolvedApproval } from "@/agent/status-store";
import { useCanvasStore } from "@/store/canvas-store";
import { Alert, AlertAction, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/ui/empty";
import { ScrollArea } from "@/ui/scroll-area";
import { Skeleton } from "@/ui/skeleton";
import { acpApi } from "./api";
import { MessageList } from "./MessageList";
import { PermissionCard } from "./PermissionCard";
import { PromptBox } from "./PromptBox";
import {
  EMPTY_SESSION,
  acpPermissionOf,
  useAcpStore,
  type AcpPermissionView,
} from "./store";

const NO_PERMISSIONS: readonly AcpPermissionView[] = [];

type LoadState = "loading" | "ready" | "failed";

/**
 * 会话没有就起一个（`POST /api/acp/sessions`），id 写回节点数据——与终端
 * 节点同一个做法：重开应用靠它接回同一行，它不是用户的编辑，不进撤销栈。
 */
function useAcpSession(nodeId: string, data: TerminalNodeData) {
  const [starting, setStarting] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const sessionId = data.sessionId ?? null;
  const agent = data.agent;

  React.useEffect(() => {
    if (sessionId || !agent) return;
    const store = useCanvasStore.getState();
    const workspace = store.workspace;
    if (!workspace) return;
    let cancelled = false;
    setStarting(true);
    setFailed(false);
    acpApi
      .createSession({
        workspaceId: workspace.id,
        nodeId,
        cwd: data.cwd ?? workspace.rootPath,
        agentId: agent.id,
        ...(agent.permissionMode
          ? { permissionMode: agent.permissionMode }
          : {}),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.sessionId ? { resume: agent.sessionId } : {}),
      })
      .then((session) => {
        if (cancelled) return;
        useCanvasStore
          .getState()
          .updateNodeData(
            nodeId,
            { sessionId: session.id, lastExitCode: null },
            { history: "ignore" },
          );
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setStarting(false);
      });
    return () => {
      cancelled = true;
    };
    // 只在「没有会话」与重试时起；节点数据的其余改动不该再起一个。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, nodeId, attempt]);

  return {
    sessionId,
    starting,
    failed,
    retry: () => setAttempt((value) => value + 1),
  };
}

/**
 * 读镜像、接活事件。先订阅再读：读回来之前到的分块已经写进了镜像（core 先写
 * 镜像再发事件），丢掉不画；工具调用按 id 合并，读回来之后再补一遍无妨。
 */
function useAcpLog(sessionId: string | null, nodeId: string) {
  const [state, setState] = React.useState<LoadState>("loading");
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    if (!sessionId) return;
    const store = useAcpStore.getState;
    let loaded = false;
    let cancelled = false;
    const early: AcpSessionUpdate[] = [];
    setState("loading");

    const offUpdate = onWorkspaceEvent("acp.update", (event) => {
      if (event.sessionId !== sessionId) return;
      if (loaded) store().update(sessionId, event.update);
      else early.push(event.update);
    });
    const offTurn = onWorkspaceEvent("acp.turn", (event) => {
      if (event.sessionId !== sessionId) return;
      store().end(sessionId, nodeId, event);
    });
    const offApproval = onWorkspaceEvent("agent.approval", (event) => {
      if (event.nodeId !== nodeId) return;
      if (isResolvedApproval(event.request)) {
        store().resolvePermission(event.pendingId);
        return;
      }
      const permission = acpPermissionOf(event.pendingId, event.request);
      if (permission) store().addPermission(nodeId, permission);
    });

    acpApi
      .log(sessionId)
      .then((log) => {
        if (cancelled) return;
        store().hydrate(sessionId, nodeId, log);
        loaded = true;
        for (const update of early) {
          if (update.sessionUpdate.endsWith("_chunk")) continue;
          store().update(sessionId, update);
        }
        early.length = 0;
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("failed");
      });

    return () => {
      cancelled = true;
      offUpdate();
      offTurn();
      offApproval();
    };
  }, [sessionId, nodeId, attempt]);

  return { state, retry: () => setAttempt((value) => value + 1) };
}

function useConnected(workspaceId: string | null): boolean {
  const [connected, setConnected] = React.useState(true);
  React.useEffect(() => {
    if (!workspaceId) return;
    return onWorkspaceConnection((id, next) => {
      if (id === workspaceId) setConnected(next);
    });
  }, [workspaceId]);
  return connected;
}

/** 视口贴着底部时，新内容进来就跟着滚到底；人往上翻了就不打扰。 */
function useStickToBottom(
  root: React.RefObject<HTMLDivElement | null>,
  signal: unknown,
) {
  const pinned = React.useRef(true);
  React.useEffect(() => {
    const viewport = root.current?.querySelector<HTMLElement>(
      "[data-slot=scroll-area-viewport]",
    );
    if (!viewport) return;
    const onScroll = () => {
      pinned.current =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24;
    };
    viewport.addEventListener("scroll", onScroll);
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [root]);
  React.useEffect(() => {
    const viewport = root.current?.querySelector<HTMLElement>(
      "[data-slot=scroll-area-viewport]",
    );
    if (viewport && pinned.current) viewport.scrollTop = viewport.scrollHeight;
  }, [root, signal]);
}

/**
 * ACP 驱动的终端节点的节点体（ACP 设计 §6，设计系统 §5.1）。头部、徽标、
 * 菜单都在 `TerminalNode`，这里只有消息流、审批卡与输入框。
 */
export function SessionView({
  nodeId,
  data,
}: {
  nodeId: string;
  data: TerminalNodeData;
}) {
  const t = useT();
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const canAnswer = useAccess().can("approval:answer", workspaceId ?? "");
  const session = useAcpSession(nodeId, data);
  const sessionId = session.sessionId;
  const log = useAcpLog(sessionId, nodeId);
  const connected = useConnected(workspaceId);
  const view = useAcpStore((state) =>
    sessionId ? (state.sessions[sessionId] ?? EMPTY_SESSION) : EMPTY_SESSION,
  );
  const permissions = useAcpStore(
    (state) => state.permissions[nodeId] ?? NO_PERMISSIONS,
  );
  const rootRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  useStickToBottom(rootRef, [view.items, view.streaming, permissions]);

  const send = React.useCallback(
    async (text: string) => {
      if (!sessionId) return false;
      const store = useAcpStore.getState();
      store.begin(sessionId, text);
      try {
        await acpApi.prompt(sessionId, text);
      } catch {
        store.end(sessionId, nodeId, {
          error: { code: "prompt_failed", message: "" },
        });
        toast.error(t("acp.prompt.failed"));
      }
      return true;
    },
    [sessionId, nodeId, t],
  );

  const cancel = React.useCallback(() => {
    if (sessionId) void acpApi.cancel(sessionId).catch(() => undefined);
  }, [sessionId]);

  const selectMode = React.useCallback(
    (modeId: string) => {
      if (!sessionId) return;
      useAcpStore.getState().setMode(sessionId, modeId);
      void acpApi.setMode(sessionId, modeId).catch(() => undefined);
    },
    [sessionId],
  );

  const pinned = permissions.length === 1 ? permissions[0] : undefined;
  const loading =
    session.starting || (sessionId !== null && log.state === "loading");
  const empty =
    !loading &&
    log.state !== "failed" &&
    view.items.length === 0 &&
    permissions.length === 0;

  let body: React.ReactNode;
  if (session.failed) {
    body = (
      <Alert variant="destructive">
        <AlertTitle>{t("acp.error.start")}</AlertTitle>
        <AlertAction>
          <Button size="xs" variant="outline" onClick={session.retry}>
            {t("acp.error.retry")}
          </Button>
        </AlertAction>
      </Alert>
    );
  } else if (loading) {
    body = (
      <div className="flex flex-col gap-2" data-slot="acp-loading">
        <Skeleton className="h-4 w-2/3 self-end" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
      </div>
    );
  } else if (log.state === "failed") {
    body = (
      <Alert variant="destructive">
        <AlertTitle>{t("acp.error.log")}</AlertTitle>
        <AlertAction>
          <Button size="xs" variant="outline" onClick={log.retry}>
            {t("acp.error.retry")}
          </Button>
        </AlertAction>
      </Alert>
    );
  } else if (empty) {
    body = (
      <Empty className="h-full border-0 p-4">
        <EmptyHeader>
          <EmptyTitle className="text-[13px] font-normal text-muted-foreground">
            {t("acp.empty")}
          </EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  } else {
    body = (
      <>
        <MessageList items={view.items} streaming={view.streaming} />
        {!pinned &&
          permissions.map((permission) => (
            <PermissionCard
              key={permission.pendingId}
              permission={permission}
              canAnswer={canAnswer}
            />
          ))}
        {view.failed && !view.streaming && (
          <Alert variant="destructive">
            <AlertTitle>{t("acp.error.turn")}</AlertTitle>
            {view.lastPrompt && (
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void send(view.lastPrompt as string)}
                >
                  {t("acp.error.retry")}
                </Button>
              </AlertAction>
            )}
          </Alert>
        )}
      </>
    );
  }

  return (
    <div
      ref={rootRef}
      data-slot="acp-session-view"
      className="flex h-full w-full flex-col bg-[var(--card)]"
      onClick={(event) => {
        // 空态那一句话是「点一下就能说」：点空白处把焦点交给输入框。
        if (empty && event.target === event.currentTarget)
          inputRef.current?.focus();
      }}
    >
      {!connected && (
        <Alert className="rounded-none border-x-0 border-t-0 py-1.5">
          <AlertTitle className="text-xs">{t("acp.offline")}</AlertTitle>
        </Alert>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex min-h-full flex-col gap-2 p-2.5">{body}</div>
      </ScrollArea>
      {pinned && (
        <PermissionCard
          permission={pinned}
          canAnswer={canAnswer}
          className="mx-2 mb-1.5"
        />
      )}
      <PromptBox
        sessionId={sessionId}
        inputRef={inputRef}
        disabled={!connected || !sessionId || session.failed}
        streaming={view.streaming}
        modes={view.modes}
        onSubmit={send}
        onCancel={cancel}
        onMode={selectMode}
      />
    </div>
  );
}

export default SessionView;
