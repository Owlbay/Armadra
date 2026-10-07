import { uuidV7 } from "../workspaces/support";
import { displayName } from "./control/send";
import { recordDelivery } from "./deliveries";
import { RECEIPT_KEY_PREFIX, TTL_SECONDS } from "./mailbox";
import { loadNode } from "./nodes";
import { nonce } from "./refusals";
import {
  type QueueItem,
  markNotified,
  settledUnnotified,
  queueActorFields,
} from "./send-queue";
import type { CollabContext } from "./service";

/**
 * 投递终态回执（设计 `cli-collaboration.md` §4、§10 第 2 条）。
 *
 * 一条排队项因为过期、目标侧拒收或出队时门链拒绝而结束，发送方要能知道。
 * 回执只写进它的收件箱，不推进它的终端：人从 `agent.delivery` 事件和「我发出
 * 的」看见结果，Agent 在下一次 `inbox` 时看见。所以回执不计入唤醒，也不占收件
 * 箱容量（`mailbox.ts` 里那几条 `NOT LIKE 'receipt:%'`）。
 *
 * 写法有两处是被表逼出来的：
 *
 *   * `source_node_id` 有外键，没有哨兵节点可填，所以填**目标节点**——回执说的
 *     本来就是「那一头发生了什么」，`inbox` 里的署名也因此是目标的名字。目标已
 *     经不在画布上时外键填不了，那一条不写回执；
 *   * 「只写一次」靠两样东西：先在队列行上认领 `notified_at`，再按
 *     `receipt:<queueId>` 条件插入。
 *
 * 发送方节点已经不在画布上时同样不写回执，但投递记录照记：「我发出的」与投递
 * 记录面板看的是那张表，不是收件箱。
 */

/**
 * 光看码猜不出该去哪找原因的几个码，回执里补一句人话。
 *
 * 只补「发送方要去终端里看一眼」的那种：`TARGET_NOT_AT_PROMPT` 的消息一直没
 * 投进去，是因为对方终端停在 CLI 自己的对话框上——那个对话框要人去答，发送方
 * 换个时间重发也没用。
 */
const REASON_NOTES: Readonly<Record<string, string>> = {
  TARGET_NOT_AT_PROMPT: "对方终端停在 CLI 的对话框上，没有替人回答",
};

/** 回执正文。不带原消息正文，只说去了哪、为什么停下、试过几次、多长。 */
export function receiptBody(item: QueueItem, targetName: string): string {
  const what =
    item.state === "expired"
      ? "已过期"
      : item.settledBy === "target"
        ? "被对方拒收"
        : "在出队时被拦下";
  // `attempts` 数的是被认领去投的次数；门链在认领之前就把它拦下了，那一次也是
  // 一次实际的尝试（§4）。忙或启动中退回排队的不算认领，所以过期与拒收大多是
  // 0 次——「尝试 0 次」读起来像根本没投，干脆不写。
  const attempts = item.attempts + (item.settledBy === "gate" ? 1 : 0);
  const facts = [
    ...(item.lastReason === undefined
      ? []
      : [
          REASON_NOTES[item.lastReason] === undefined
            ? item.lastReason
            : `${item.lastReason}：${REASON_NOTES[item.lastReason]}`,
        ]),
    ...(attempts === 0 ? [] : [`尝试 ${attempts} 次`]),
    `正文 ${[...item.body].length} 字`,
  ];
  return `投往「${targetName}」的消息${what}（${facts.join("，")}）。`;
}

/**
 * 把所有该写还没写的回执写掉，返回写了几条（含只记了投递记录的）。
 *
 * 调用点三处：清扫标完过期之后、出队泵的 catch 分支、目标侧拒收之后。后两处是
 * 为了不必等一分钟一次的清扫。永不抛：回执是**通知**，写不成不该让清扫或拒收
 * 失败，那一行认领过就不再重试。
 */
export function writeReceipts(context: CollabContext, now: number): number {
  let written = 0;
  let pending: QueueItem[];
  try {
    pending = settledUnnotified(context.database);
  } catch {
    return 0;
  }
  for (const item of pending) {
    try {
      if (!markNotified(context.database, item.id, now)) continue;
      writeOne(context, item, now);
      written += 1;
    } catch {
      // 见上：通知写不成不是终态的失败。
    }
  }
  return written;
}

function writeOne(context: CollabContext, item: QueueItem, now: number): void {
  const outcome = item.state === "expired" ? "expired" : "cancelled";
  const target = loadNode(context.database, item.targetNodeId);
  const source =
    item.sourceNodeId === null
      ? undefined
      : loadNode(context.database, item.sourceNodeId);
  // 收件箱唤醒的来源就是目标自己：给自己写一条「你的唤醒过期了」没有意义。
  if (source !== undefined && target !== undefined && source.id !== target.id) {
    context.database
      .prepare(
        "INSERT INTO agent_mailbox (id, workspace_id, source_node_id, target_node_id, message_key, body, created_at, expires_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(source_node_id, target_node_id, message_key) DO NOTHING",
      )
      .run(
        uuidV7(),
        item.workspaceId,
        target.id,
        source.id,
        `${RECEIPT_KEY_PREFIX}${item.id}`,
        receiptBody(item, displayName(target, item.targetNodeId)),
        now,
        now + TTL_SECONDS,
      );
  }
  const traceId = nonce(16);
  recordDelivery(context.database, {
    traceId,
    workspaceId: item.workspaceId,
    sourceNodeId: item.sourceNodeId,
    ...queueActorFields(item),
    targetNodeId: item.targetNodeId,
    outcome,
    receipt: item.id,
    bodyChars: [...item.body].length,
  });
  context.publish(item.workspaceId, {
    type: "agent.delivery",
    traceId,
    sourceNodeId: item.sourceNodeId,
    ...queueActorFields(item),
    targetNodeId: item.targetNodeId,
    outcome,
    ...(item.lastReason === undefined ? {} : { code: item.lastReason }),
  });
}
