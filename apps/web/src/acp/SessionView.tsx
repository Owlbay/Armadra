import { scoped } from "../sources/scope";
import * as React from "react";
import { toast } from "sonner";
import type {
  AcpLogResponse,
  AcpSessionUpdate,
  TerminalNodeData,
} from "@armadra/shared";

import { RuntimeRequestError } from "@/api/client";
import { onWorkspaceConnection, onWorkspaceEvent } from "@/api/events";
import { useT } from "@/app/preferences-store";
import { useCanAnswer } from "@/app/use-access";
import { isResolvedApproval } from "@/agent/status-store";
import { useCanvasStore } from "@/store/canvas-store";
import { Alert, AlertAction, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/ui/empty";
import { ScrollArea } from "@/ui/scroll-area";
import { Skeleton } from "@/ui/skeleton";
import { Spinner } from "@/ui/spinner";
import { acpApi } from "./api";
import { ElicitationCard } from "./ElicitationCard";
import { MessageList } from "./MessageList";
import { PermissionCard } from "./PermissionCard";
import { PromptBox } from "./PromptBox";
import {
  EMPTY_SESSION,
  acpElicitationOf,
  acpPermissionOf,
  useAcpStore,
  type AcpElicitationView,
  type AcpPermissionView,
} from "./store";

const NO_PERMISSIONS: readonly AcpPermissionView[] = [];
const NO_ELICITATIONS: readonly AcpElicitationView[] = [];

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
        // 先收起「正在起」：写回会话 id 会让这个 effect 自己被清理（依赖
        // 变了），清理之后的 `finally` 不再动状态，骨架屏就永远不走。
        setStarting(false);
        useCanvasStore
          .getState()
          .updateNodeData(
            nodeId,
            { sessionId: session.id, lastExitCode: null },
            { history: "ignore" },
          );
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        setStarting(false);
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
 * 已经并进 store 的那几条事件（按对象认：同一条事件派给每个订阅者的是同一个
 * 对象）。同一个节点可以同时挂两份会话视图——手机焦点页铺满屏幕时画布上那一份
 * 还在——两份各自订阅，不去重的话每个分块都会被拼两遍。
 */
const applied = new WeakSet<object>();

function firstTime(event: object): boolean {
  if (applied.has(event)) return false;
  applied.add(event);
  return true;
}

/**
 * 读镜像、接活事件。先订阅再读：工具调用按 id 合并，读回来之后再补一遍无妨。
 * 控制面断开又连上后重读一遍（契约 §39.9），补上断线那段
 * 漏掉的回合事件，再拿 `turns` 对账本页那一轮。`reread` 给「确认中」用。
 */
function useAcpLog(
  sessionId: string | null,
  nodeId: string,
  workspaceId: string | null,
) {
  const [state, setState] = React.useState<LoadState>("loading");
  const [attempt, setAttempt] = React.useState(0);
  const rereadRef = React.useRef<(() => Promise<AcpLogResponse>) | null>(null);

  React.useEffect(() => {
    if (!sessionId) return;
    const store = useAcpStore.getState;
    let loaded = false;
    let cancelled = false;
    let inflight: Promise<AcpLogResponse> | null = null;
    setState("loading");

    const early: { event: object; update: AcpSessionUpdate }[] = [];
    const offUpdate = onWorkspaceEvent("acp.update", (event) => {
      if (event.sessionId !== sessionId) return;
      if (!loaded) early.push({ event, update: event.update });
      else if (firstTime(event)) store().update(sessionId, event.update);
    });
    const offTurn = onWorkspaceEvent("acp.turn", (event) => {
      if (event.sessionId !== sessionId || !firstTime(event)) return;
      store().end(sessionId, nodeId, event);
    });
    const offApproval = onWorkspaceEvent("agent.approval", (event) => {
      if (event.nodeId !== nodeId) return;
      if (isResolvedApproval(event.request)) {
        store().resolvePermission(event.pendingId);
        return;
      }
      const permission = acpPermissionOf(event.pendingId, event.request);
      if (permission) {
        store().addPermission(nodeId, permission);
        return;
      }
      const elicitation = acpElicitationOf(event.pendingId, event.request);
      if (elicitation) store().addElicitation(nodeId, elicitation);
    });

    // 读回来之前到的分块已经在镜像里（core 先写镜像再发事件），丢掉不画；读
    // 失败时它们没被任何一次读覆盖，照常并进去。
    const read = (): Promise<AcpLogResponse> => {
      if (inflight) return inflight;
      loaded = false;
      const flush = (skipChunks: boolean) => {
        loaded = true;
        for (const { event, update } of early) {
          if (skipChunks && update.sessionUpdate.endsWith("_chunk")) continue;
          if (firstTime(event)) store().update(sessionId, update);
        }
        early.length = 0;
      };
      const pending = acpApi.log(sessionId).then(
        (log) => {
          inflight = null;
          if (cancelled) return log;
          store().hydrate(sessionId, nodeId, log);
          store().reconcile(sessionId, log.turns);
          flush(true);
          return log;
        },
        (error: unknown) => {
          inflight = null;
          if (!cancelled) flush(false);
          throw error;
        },
      );
      inflight = pending;
      return pending;
    };
    rereadRef.current = read;

    read()
      .then(() => {
        if (!cancelled) setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("failed");
      });

    let down = false;
    const offConnection = workspaceId
      ? onWorkspaceConnection((id, connected) => {
          if (id !== workspaceId) return;
          if (!connected) {
            down = true;
            return;
          }
          if (!down) return;
          down = false;
          // 断线那段的分块与 `acp.turn` 收不到了：重读一遍补上。失败不打扰，
          // 已经画着的照旧。
          read().catch(() => undefined);
        })
      : () => undefined;

    return () => {
      cancelled = true;
      if (rereadRef.current === read) rereadRef.current = null;
      offUpdate();
      offTurn();
      offApproval();
      offConnection();
    };
  }, [sessionId, nodeId, workspaceId, attempt]);

  const reread = React.useCallback((): Promise<AcpLogResponse> => {
    const read = rereadRef.current;
    return read ? read() : Promise.reject(new Error("no session"));
  }, []);

  return { state, retry: () => setAttempt((value) => value + 1), reread };
}

/** 一轮的客户端 id；非安全上下文（局域网 http）没有 `randomUUID`。 */
function newClientTurnId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** core 明确拒绝了这一轮（4xx 带码）：没有投递，照旧当场判失败。 */
function refusedByCore(error: unknown): boolean {
  return (
    error instanceof RuntimeRequestError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.code !== undefined
  );
}

/** 「确认中」重读镜像的间隔：第一次立刻读，之后等连接缓一缓。 */
const RECONCILE_DELAYS_MS = [0, 1000, 3000] as const;

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
  const session = useAcpSession(nodeId, data);
  const sessionId = session.sessionId;
  const canAnswer = useCanAnswer(workspaceId ?? "", sessionId);
  const log = useAcpLog(sessionId, nodeId, workspaceId);
  const { reread } = log;
  const connected = useConnected(workspaceId);
  const view = useAcpStore((state) =>
    sessionId
      ? (state.sessions[scoped(sessionId)] ?? EMPTY_SESSION)
      : EMPTY_SESSION,
  );
  const permissions = useAcpStore(
    (state) => state.permissions[scoped(nodeId)] ?? NO_PERMISSIONS,
  );
  const elicitations = useAcpStore(
    (state) => state.elicitations[scoped(nodeId)] ?? NO_ELICITATIONS,
  );
  const rootRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  useStickToBottom(rootRef, [
    view.items,
    view.streaming,
    permissions,
    elicitations,
  ]);

  /**
   * 请求断在路上（网络错误、没有答复）时不当场判失败：进入「确认中」，重读
   * 镜像拿 `turns` 对账（契约 §39.9）。core 收到了就按真实回合画，确认没收到才
   * 判没送达；重试沿用同一个 `clientTurnId`，core 只投递一次。
   */
  const confirmTurn = React.useCallback(
    async (id: string, clientTurnId: string) => {
      const pending = () => {
        const view = useAcpStore.getState().sessions[scoped(id)];
        return view?.confirming === true && view.clientTurnId === clientTurnId;
      };
      for (const delay of RECONCILE_DELAYS_MS) {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        if (!pending()) return;
        try {
          await reread();
          return;
        } catch {
          // 读不到就再等一会儿；读到了，结论由 `reconcile` 下。
        }
      }
      // 一直读不到：无从确认，判没送达；重试同一个 id，重复不了。
      if (pending()) useAcpStore.getState().reconcile(id, []);
    },
    [reread],
  );

  const send = React.useCallback(
    async (text: string, retryTurnId?: string) => {
      if (!sessionId) return false;
      const store = useAcpStore.getState();
      const clientTurnId = retryTurnId ?? newClientTurnId();
      store.begin(sessionId, text, clientTurnId);
      try {
        await acpApi.prompt(sessionId, text, clientTurnId);
      } catch (error) {
        if (refusedByCore(error)) {
          store.end(sessionId, nodeId, {
            error: { code: "prompt_failed", message: "" },
          });
          toast.error(t("acp.prompt.failed"));
          return true;
        }
        store.confirm(sessionId);
        void confirmTurn(sessionId, clientTurnId);
      }
      return true;
    },
    [sessionId, nodeId, t, confirmTurn],
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

  const selectModel = React.useCallback(
    (modelId: string) => {
      if (!sessionId) return;
      const store = useAcpStore.getState();
      const previous =
        store.sessions[scoped(sessionId)]?.models?.currentModelId;
      store.setModel(sessionId, modelId);
      acpApi
        .setModel(sessionId, modelId)
        .then(() => {
          // 节点数据的 `agent.model` 由页面写回（契约 §26.2）：下次起会话
          // 落上同一个模型。与会话 id 一样不是画布编辑，不进撤销栈。
          const canvas = useCanvasStore.getState();
          const node = canvas.document?.nodes.find((n) => n.id === nodeId);
          if (node?.data.kind !== "terminal" || !node.data.agent) return;
          canvas.updateNodeData(
            nodeId,
            { agent: { ...node.data.agent, model: modelId } },
            { history: "ignore" },
          );
        })
        .catch(() => {
          if (previous) useAcpStore.getState().setModel(sessionId, previous);
          toast.error(t("acp.prompt.modelFailed"));
        });
    },
    [sessionId, nodeId, t],
  );

  // 审批与 elicitation 同一个位置：只有一张时钉在输入框上方，多张时随消息流。
  const pendingCount = permissions.length + elicitations.length;
  const pinned =
    pendingCount === 1 && permissions.length === 1 ? permissions[0] : undefined;
  const pinnedElicitation =
    pendingCount === 1 && elicitations.length === 1
      ? elicitations[0]
      : undefined;
  const loading =
    session.starting || (sessionId !== null && log.state === "loading");
  const empty =
    !loading &&
    log.state !== "failed" &&
    view.items.length === 0 &&
    pendingCount === 0;

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
        <MessageList
          items={view.items}
          streaming={view.streaming}
          source={sessionId ? { nodeId, sessionId } : undefined}
        />
        {pendingCount > 1 &&
          permissions.map((permission) => (
            <PermissionCard
              key={permission.pendingId}
              permission={permission}
              canAnswer={canAnswer}
            />
          ))}
        {pendingCount > 1 &&
          elicitations.map((elicitation) => (
            <ElicitationCard
              key={elicitation.pendingId}
              nodeId={nodeId}
              view={elicitation}
              canAnswer={canAnswer}
            />
          ))}
        {view.confirming && (
          <Alert data-slot="acp-confirming">
            <Spinner />
            <AlertTitle>{t("acp.turn.confirming")}</AlertTitle>
          </Alert>
        )}
        {view.failed && !view.streaming && (
          <Alert variant="destructive">
            <AlertTitle>
              {t(view.undelivered ? "acp.error.undelivered" : "acp.error.turn")}
            </AlertTitle>
            {view.lastPrompt && (
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    void send(
                      view.lastPrompt as string,
                      view.undelivered
                        ? (view.clientTurnId ?? undefined)
                        : undefined,
                    )
                  }
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
      {pinnedElicitation && (
        <ElicitationCard
          key={pinnedElicitation.pendingId}
          nodeId={nodeId}
          view={pinnedElicitation}
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
        models={view.models}
        onSubmit={send}
        onCancel={cancel}
        onMode={selectMode}
        onModel={selectModel}
      />
    </div>
  );
}

export default SessionView;
