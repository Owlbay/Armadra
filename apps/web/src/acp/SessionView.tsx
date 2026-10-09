import { scoped } from "../sources/scope";
import * as React from "react";
import { toast } from "sonner";
import type {
  AcpLogResponse,
  AcpSessionUpdate,
  AcpStartPhase,
  TerminalNodeData,
} from "@armadra/shared";

import { RuntimeRequestError, runtimeApi } from "@/api/client";
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
import { MessageList, type MessageListActions } from "./MessageList";
import { PermissionCard } from "./PermissionCard";
import type { PlanView } from "./PlanCard";
import { PromptBox, type PromptPrefill } from "./PromptBox";
import {
  type PromptAttachment,
  usePromptAttachments,
} from "./PromptAttachments";
import { filesOf } from "@/terminal/file-paste";
import {
  EMPTY_SESSION,
  type AcpAttachment,
  type AcpItem,
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
 * 会话就绪前输入的第一条（契约 §51）。`via`：`create` = 随 `createSession` 的
 * `prompt` 发出（那时请求还没发）；`prompt` = 会话开好后经 `POST …/prompt` 发；
 * `null` = 还在等会话。
 */
interface QueuedPrompt {
  readonly text: string;
  via: "create" | "prompt" | null;
}

/** 「加载配置」超过这么久时追加「首次启动较慢」。 */
const COLD_AFTER_MS = 3_000;

/**
 * 会话没有就起一个（`POST /api/acp/sessions`），id 写回节点数据——与终端
 * 节点同一个做法：重开应用靠它接回同一行，它不是用户的编辑，不进撤销栈。
 *
 * 起的过程中跟着 `acp.starting` 记阶段（契约 §51），页面据此画一行提示；
 * `queued` 里那一条若此刻还没发请求，就随 `prompt` 一起发。
 */
function useAcpSession(
  nodeId: string,
  data: TerminalNodeData,
  workspaceId: string | null,
  queued: React.RefObject<QueuedPrompt | null>,
) {
  const [starting, setStarting] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [phase, setPhase] = React.useState<AcpStartPhase | null>(null);
  const [cold, setCold] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const sessionId = data.sessionId ?? null;
  const agent = data.agent;

  // 没有会话时就听着：请求发出之前订阅好，第一帧不会漏。
  React.useEffect(() => {
    if (sessionId) return;
    return onWorkspaceEvent("acp.starting", (event) => {
      if (event.nodeId === nodeId) setPhase(event.phase);
    });
  }, [sessionId, nodeId]);

  React.useEffect(() => {
    setCold(false);
    if (phase !== "session") return;
    const timer = setTimeout(() => setCold(true), COLD_AFTER_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  React.useEffect(() => {
    if (sessionId || !agent) return;
    const store = useCanvasStore.getState();
    const workspace = store.workspace;
    if (!workspace) return;
    let cancelled = false;
    setStarting(true);
    setFailed(false);
    setFailure(null);
    setPhase(null);
    const first = queued.current;
    const prompt = first !== null && first.via === null ? first.text : null;
    if (first !== null && prompt !== null) first.via = "create";
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
        ...(prompt !== null ? { prompt } : {}),
      })
      .then((session) => {
        if (cancelled) return;
        // 先收起「正在起」：写回会话 id 会让这个 effect 自己被清理（依赖
        // 变了），清理之后的 `finally` 不再动状态，骨架屏就永远不走。
        setStarting(false);
        setPhase(null);
        useCanvasStore
          .getState()
          .updateNodeData(
            nodeId,
            { sessionId: session.id, lastExitCode: null },
            { history: "ignore" },
          );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // 随请求发出的那一条没有送达：交回去，重试时再随下一次请求发。
        if (first !== null && first.via === "create") first.via = null;
        setFailure(
          error instanceof RuntimeRequestError ? (error.code ?? null) : null,
        );
        setFailed(true);
        setStarting(false);
        setPhase(null);
      });
    return () => {
      cancelled = true;
    };
    // 只在「没有会话」、工作空间刚读到与重试时起；节点数据的其余改动不该再起
    // 一个。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, nodeId, workspaceId, attempt]);

  return {
    sessionId,
    starting,
    failed,
    failure,
    phase,
    cold,
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

/** 附件被 core 拒绝（契约 §56）：那句话本身就说清了原因。 */
function attachmentRefusal(error: unknown): error is RuntimeRequestError {
  return (
    error instanceof RuntimeRequestError &&
    (error.code === "acp_image_unsupported" ||
      error.code === "acp_attachment_unsupported" ||
      error.code === "acp_attachment_too_large")
  );
}

/** 一个主机上的绝对路径 → `file://` 地址（只用来显示）。 */
function fileUrl(path: string): string {
  const portable = path.replace(/\\/g, "/");
  return `file://${portable.startsWith("/") ? "" : "/"}${encodeURI(portable)}`;
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

/** 会话就绪前排着的那一条：先画成本页的用户消息。 */
function queuedItems(text: string): readonly AcpItem[] {
  return [
    { kind: "message", id: "queued", role: "user", text, turn: 1, local: true },
  ];
}

/** 读屏在回合结束时念的那一段最多这么长。 */
const ANNOUNCE_CHARS = 280;

/**
 * 流式分块不逐块念（消息区 `aria-live="off"`）：回合结束时把最后一条助手
 * 文字放进一个稳定的 `role="status"` 区域，念一次（ACP 会话视图 §5.7）。
 */
function useTurnAnnouncement(
  items: readonly { kind: string; role?: string; text?: string }[],
  streaming: boolean,
): string {
  const [said, setSaid] = React.useState("");
  const was = React.useRef(streaming);
  React.useEffect(() => {
    if (was.current && !streaming) {
      const last = [...items]
        .reverse()
        .find((item) => item.kind === "message" && item.role === "assistant");
      setSaid((last?.text ?? "").slice(0, ANNOUNCE_CHARS));
    }
    was.current = streaming;
  }, [items, streaming]);
  return said;
}

/**
 * ACP 驱动的终端节点的节点体（ACP 设计 §6，设计系统 §5.1，ACP 会话视图
 * §5）。头部、徽标、菜单都在 `TerminalNode`，这里只有消息流、审批卡与输入框。
 *
 * 根上 `select-text nopan nodrag nowheel`：React Flow 给节点的
 * `user-select: none` 在这里撤掉（字能选、能复制），手形工具开着时按在会话
 * 里也不平移画布、不拖节点，滚轮归消息流。
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
  const queuedRef = React.useRef<QueuedPrompt | null>(null);
  const [queued, setQueued] = React.useState<string | null>(null);
  const session = useAcpSession(nodeId, data, workspaceId, queuedRef);
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
  const [prefill, setPrefill] = React.useState<PromptPrefill | null>(null);
  const announcement = useTurnAnnouncement(view.items, view.streaming);
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
    async (
      text: string,
      retryTurnId?: string,
      uploadIds: readonly string[] = [],
      shown: readonly AcpAttachment[] = [],
    ) => {
      if (!sessionId) {
        // 会话就绪前的第一条（契约 §51）：先画出来，等会话开好再发；请求
        // 还没发出去时随 `createSession` 的 `prompt` 一起发。再多的等它就绪。
        if (queuedRef.current !== null || session.failed) return false;
        queuedRef.current = { text, via: null };
        setQueued(text);
        return true;
      }
      const store = useAcpStore.getState();
      const clientTurnId = retryTurnId ?? newClientTurnId();
      if (shown.length > 0) store.begin(sessionId, text, clientTurnId, shown);
      else store.begin(sessionId, text, clientTurnId);
      try {
        await (uploadIds.length > 0
          ? acpApi.prompt(sessionId, text, clientTurnId, uploadIds)
          : acpApi.prompt(sessionId, text, clientTurnId));
      } catch (error) {
        if (refusedByCore(error)) {
          store.end(sessionId, nodeId, {
            error: { code: "prompt_failed", message: "" },
          });
          toast.error(
            attachmentRefusal(error) ? error.message : t("acp.prompt.failed"),
          );
          return true;
        }
        store.confirm(sessionId);
        void confirmTurn(sessionId, clientTurnId);
      }
      return true;
    },
    [sessionId, nodeId, t, confirmTurn, session.failed],
  );

  const promptDisabled = !connected || session.failed;
  const attachments = usePromptAttachments(
    sessionId ? view.promptCapabilities : null,
    Boolean(data.ssh),
  );

  // 附件的预览地址交给了消息里那一条：节点卸载时一起收回。
  const previews = React.useRef<string[]>([]);
  React.useEffect(
    () => () => {
      for (const url of previews.current) URL.revokeObjectURL(url);
    },
    [],
  );

  /**
   * 输入框交上来的一句（契约 §56）：有附件时先逐个上传到会话所在的 core，再带着
   * 上传 id 发 prompt。上传失败不发、输入框里的字与附件留着。
   */
  const submit = React.useCallback(
    async (text: string, attachments: readonly PromptAttachment[] = []) => {
      if (attachments.length === 0) return send(text);
      if (!sessionId || !workspaceId) {
        toast.error(t("acp.attach.unavailable"));
        return false;
      }
      let uploads;
      try {
        uploads = await Promise.all(
          attachments.map((item) =>
            runtimeApi.uploadAgentFile(workspaceId, item.file, item.file.name),
          ),
        );
      } catch {
        toast.error(t("acp.attach.failed"));
        return false;
      }
      const shown = attachments.map((item, index): AcpAttachment => {
        const upload = uploads[index]!;
        if (item.preview) {
          previews.current.push(item.preview);
          return { type: "image", mimeType: item.file.type, uri: item.preview };
        }
        return {
          type: "resource_link",
          uri: fileUrl(upload.path),
          name: upload.name,
          mimeType: upload.mimeType,
        };
      });
      return send(
        text,
        undefined,
        uploads.map((upload) => upload.id),
        shown,
      );
    },
    [send, sessionId, workspaceId, t],
  );

  // 会话开好、镜像读到了：把排着的那一条交出去。随 `createSession` 发出的那条
  // core 已经投递，这里只画上并进入「正在输出」。
  React.useEffect(() => {
    const first = queuedRef.current;
    if (!sessionId || log.state !== "ready" || first === null) return;
    if (first.via === "prompt") return;
    if (first.via === "create") {
      useAcpStore.getState().begin(sessionId, first.text);
    } else {
      void send(first.text);
    }
    first.via = "prompt";
    queuedRef.current = null;
    setQueued(null);
  }, [sessionId, log.state, send]);

  /**
   * 重发一条提问（重新发送、重新生成）。只有「没送达」的那一轮沿用它的
   * `clientTurnId`（契约 §39.9，core 只投递一次）；跑完了的回合再发是新的
   * 一轮，换一个 id，否则会被 core 当成同一轮去重掉。
   */
  const resend = React.useCallback(
    (text: string) => {
      if (!sessionId) return;
      const current = useAcpStore.getState().sessions[scoped(sessionId)];
      const reuse =
        current?.undelivered && current.lastPrompt === text
          ? (current.clientTurnId ?? undefined)
          : undefined;
      void send(text, reuse);
    },
    [sessionId, send],
  );

  const prefillSeq = React.useRef(0);
  const actions = React.useMemo<MessageListActions>(() => {
    const last = view.items.at(-1);
    return {
      onEdit: (text) => {
        prefillSeq.current += 1;
        setPrefill({ text, seq: prefillSeq.current });
      },
      onResend: resend,
      onPrompt: (text) => void send(text),
      resendable:
        view.failed ||
        (last?.kind === "stop" &&
          (last.stopReason === "cancelled" || last.stopReason === "refusal")),
    };
  }, [view.items, view.failed, resend, send]);

  const plan = React.useMemo<PlanView | null>(
    () =>
      view.plan.length > 0 && view.planTurn !== null
        ? {
            entries: view.plan,
            turn: view.planTurn,
            settled: view.planSettled,
          }
        : null,
    [view.plan, view.planTurn, view.planSettled],
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
        <AlertTitle>
          {t(
            session.failure === "acp_session_timeout"
              ? "acp.error.timeout"
              : "acp.error.start",
          )}
        </AlertTitle>
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
        {session.phase && (
          <div
            data-slot="acp-starting"
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
          >
            <Spinner aria-hidden className="size-3" />
            <span>{t(`acp.starting.${session.phase}`)}</span>
            {session.cold && <span>{t("acp.starting.cold")}</span>}
          </div>
        )}
        {queued !== null ? (
          <MessageList items={queuedItems(queued)} streaming={false} />
        ) : (
          <>
            <Skeleton className="h-4 w-2/3 self-end" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </>
        )}
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
          plan={plan}
          actions={actions}
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
            <Spinner aria-hidden />
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
                  onClick={() => resend(view.lastPrompt as string)}
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
      className="nopan nodrag nowheel flex h-full w-full cursor-auto flex-col bg-[var(--card)] select-text"
      // 拖进会话视图任何地方的文件都成输入框的附件（契约 §56），不交给画布。
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = promptDisabled ? "none" : "copy";
      }}
      onDrop={(event) => {
        const files = filesOf(event.dataTransfer);
        if (files.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        if (!promptDisabled) attachments.add(files);
      }}
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
        <div className="flex min-h-full flex-col gap-3 p-2.5">{body}</div>
      </ScrollArea>
      <div role="status" className="sr-only">
        {announcement}
      </div>
      {pinned && (
        <PermissionCard
          key={pinned.pendingId}
          permission={pinned}
          canAnswer={canAnswer}
          pinned
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
        disabled={promptDisabled}
        streaming={view.streaming}
        modes={view.modes}
        models={view.models}
        onSubmit={submit}
        attachments={attachments}
        onCancel={cancel}
        onMode={selectMode}
        onModel={selectModel}
        commands={view.commands}
        usage={view.usage}
        prefill={prefill}
      />
    </div>
  );
}

export default SessionView;
