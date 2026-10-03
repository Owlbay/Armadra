import type { PushKind, PushPayload } from "./types";

/**
 * 触发规则：哪条工作空间事件变成一条通知、发给谁（补全架构 §10、§8.1）。
 *
 * 推送只是事件总线的又一个订阅者。规则只读事件里的**标识与状态**（节点 id、
 * 状态名、结果码），从不读请求正文、终端输出、消息文本——`agent.status` 帧上
 * 挂着的 `lastMessage` 就是一句终端里的话，这里一个字都不碰。标题是工作空间名，
 * 正文是按种类写死的一句话，深链指向节点。
 *
 * 发给谁：对这个工作空间有 `canvas:read` 的 principal 名下的设备（调用方判），
 * 评论提及再收窄到被提及的人。
 */

/** 一条事件帧：`type` 与它自己的字段并排（`bus.ts` 的 WorkspaceEvent）。 */
export type EventFrame = { readonly type: string } & Readonly<
  Record<string, unknown>
>;

/** 规则的产物：还没有渲染成某种语言的那一半。 */
export interface Draft {
  readonly kind: PushKind;
  readonly workspaceId: string;
  readonly nodeId?: string;
  /** 用在正文里的 Agent 名（注册表里的名字，不是用户写的任何东西）。 */
  readonly agentId?: string;
  readonly tag: string;
  /** 只发给这些 principal（评论提及）；不给就是全部有权限的人。 */
  readonly principals?: readonly string[];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 投递的这些结果算「没送到」，值得叫人。 */
const DELIVERY_FAILURES = new Set([
  "refused",
  "failed",
  "expired",
  // 回执里的 cancelled 只来自目标侧拒收或出队门链（`collab/receipts.ts`），
  // 发送方自己取消不写回执。
  "cancelled",
]);

/**
 * 有状态的那一半：`agent.status` 每次上报都广播整行，「完成」要的是**进入**
 * done 的那一下，不是之后每一帧。记住每个节点上一次的状态就够了。
 */
export class TriggerRules {
  private readonly lastState = new Map<string, string>();

  draft(workspaceId: string, event: EventFrame): Draft | undefined {
    switch (event.type) {
      case "agent.approval": {
        const request = record(event.request);
        // 答复复用同一种事件（`request.resolved`）：那是答案，不是新的问题。
        if (request.resolved === true) return undefined;
        const nodeId = str(event.nodeId);
        const pendingId = str(event.pendingId);
        if (nodeId === undefined || pendingId === undefined) return undefined;
        return {
          kind: "approval",
          workspaceId,
          nodeId,
          tag: `approval:${pendingId}`,
        };
      }
      case "agent.status": {
        const status = record(event.status);
        const nodeId = str(status.nodeId);
        if (nodeId === undefined) return undefined;
        const state =
          status.errored === true ? "error" : (str(status.state) ?? "");
        const previous = this.lastState.get(nodeId);
        this.lastState.set(nodeId, state);
        // 重启后恢复出来的行不是一次新的完成。
        if (status.restored === true || previous === state) return undefined;
        const agentId = str(status.agentId);
        if (state === "done") {
          return {
            kind: "agentDone",
            workspaceId,
            nodeId,
            agentId,
            tag: `status:${nodeId}`,
          };
        }
        if (state === "error") {
          return {
            kind: "agentError",
            workspaceId,
            nodeId,
            agentId,
            tag: `status:${nodeId}`,
          };
        }
        return undefined;
      }
      case "agent.delivery": {
        const outcome = str(event.outcome) ?? "";
        if (!DELIVERY_FAILURES.has(outcome)) return undefined;
        const nodeId = str(event.sourceNodeId);
        return {
          kind: "deliveryFailed",
          workspaceId,
          ...(nodeId === undefined ? {} : { nodeId }),
          tag: `delivery:${str(event.traceId) ?? nodeId ?? ""}`,
        };
      }
      case "resources.threshold": {
        const nodeId = str(event.nodeId);
        return {
          kind: "resources",
          workspaceId,
          ...(nodeId === undefined ? {} : { nodeId }),
          tag: `resources:${str(event.metric) ?? ""}:${nodeId ?? ""}`,
        };
      }
      case "board.comment": {
        const comment = record(event.comment);
        const mentions = (
          Array.isArray(event.mentions) ? event.mentions : comment.mentions
        ) as unknown;
        // 只有提及才叫人：一块热闹的板上每条评论都推一遍，等于没有推送。
        if (!Array.isArray(mentions)) return undefined;
        const principals = mentions.filter(
          (item): item is string => typeof item === "string" && item !== "",
        );
        if (principals.length === 0) return undefined;
        const nodeId =
          str(comment.anchorKind) === "node"
            ? str(comment.anchorId)
            : undefined;
        return {
          kind: "comment",
          workspaceId,
          ...(nodeId === undefined ? {} : { nodeId }),
          tag: `comment:${str(comment.id) ?? str(event.commentId) ?? ""}`,
          principals,
        };
      }
      case "workflow.gate": {
        // 只有「开始等人」叫人：答复与取消是结果，不是新的问题。
        if (str(event.state) !== "waiting") return undefined;
        const nodeId = str(event.nodeId);
        return {
          kind: "workflowGate",
          workspaceId,
          ...(nodeId === undefined ? {} : { nodeId }),
          tag: `gate:${str(event.runId) ?? ""}:${str(event.stepId) ?? ""}`,
        };
      }
      default: {
        // 调度到点：`schedule.*` 一族（`schedule.fired`、`schedule.due` ……）。
        if (event.type.startsWith("schedule.")) {
          const nodeId = str(event.nodeId);
          return {
            kind: "schedule",
            workspaceId,
            ...(nodeId === undefined ? {} : { nodeId }),
            tag: `schedule:${str(event.automationId) ?? str(event.planId) ?? nodeId ?? ""}`,
          };
        }
        return undefined;
      }
    }
  }

  /** 节点删了、工作空间没了：状态记录跟着丢，不让这张表只长不缩。 */
  forget(nodeId: string): void {
    this.lastState.delete(nodeId);
  }
}

/* ---------------------------------- 文案 ---------------------------------- */

type Locale = "zh-CN" | "en";

const BODIES: Record<Locale, Record<PushKind, string>> = {
  "zh-CN": {
    approval: "{agent} 等待审批",
    agentDone: "{agent} 已完成",
    agentError: "{agent} 出错了",
    deliveryFailed: "有一条投递没有送达",
    schedule: "定时任务到点了",
    resources: "资源用量超过了阈值",
    comment: "有人在评论里提到了你",
    workflowGate: "工作流在等待确认",
    test: "推送已连通",
  },
  en: {
    approval: "{agent} is waiting for approval",
    agentDone: "{agent} finished",
    agentError: "{agent} hit an error",
    deliveryFailed: "A delivery was not accepted",
    schedule: "A scheduled task is due",
    resources: "A resource threshold was crossed",
    comment: "You were mentioned in a comment",
    workflowGate: "A workflow is waiting at a gate",
    test: "Push notifications are working",
  },
};

export function deepLink(workspaceId: string, nodeId?: string): string {
  // 与画布无关的通知（测试）只打开 App。
  if (workspaceId === "") return "armadra://";
  const base = `armadra://w/${encodeURIComponent(workspaceId)}`;
  return nodeId === undefined
    ? base
    : `${base}/n/${encodeURIComponent(nodeId)}`;
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** 按设备的语言渲染。没说语言的设备按中文（页面的缺省语言）。 */
export function render(
  draft: Draft,
  locale: string,
  names: {
    readonly workspace: string;
    /** Agent 的显示名：draft 带了 agentId 就用它，没带就按节点去查。 */
    readonly agent: (draft: Draft) => string;
  },
): PushPayload {
  const language: Locale = locale === "en" ? "en" : "zh-CN";
  const body = BODIES[language][draft.kind].replace(
    "{agent}",
    names.agent(draft),
  );
  return {
    v: 1,
    kind: draft.kind,
    title: clip(names.workspace || "Armadra", 64),
    body: clip(body, 120),
    url: deepLink(draft.workspaceId, draft.nodeId),
    tag: clip(draft.tag, 128),
  };
}
