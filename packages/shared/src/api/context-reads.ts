import { z } from "zod";

/**
 * 「谁读过我」——`GET /api/nodes/{id}/context-reads`（设计
 * `agent-delivery.md` §10）。
 *
 * 一个节点的转录被相连的 Agent 读走是一件发生过的事，读的人知道，被读的人
 * 今天不知道。这条路径把那份审计答给界面：总次数、以及最近几条各自是谁、
 * 什么动词、拿走了多少字节、什么时候。
 *
 * 只有元数据，没有正文——一份「谁读过我」的清单说的是读这件事，不是内容；
 * 正文再抄一份到这里等于把刚刚限流过的东西又发一次。
 */
export const contextReadSchema = z.object({
  id: z.string(),
  /** 读的那个节点。它可能已经被删掉，所以名字是另外两列。 */
  readerNodeId: z.string(),
  /** 读的时候它的句柄（§2）；没有就缺省。 */
  readerHandle: z.string().optional(),
  /** 读的时候它的标题；没有就缺省。 */
  readerTitle: z.string().optional(),
  /** 用的哪个动词（`context summary`、`context read` …）。 */
  verb: z.string(),
  /** 这一次实际读走多少字节，受读取预算约束。 */
  bytes: z.number().nonnegative().default(0),
  /** Unix 毫秒。 */
  atMs: z.number().nonnegative().default(0),
});

/** 线上形状以契约为准（`docs/contracts/core-json-api.md` §7）：最近几条叫 `reads`。 */
export const contextReadsResponseSchema = z.object({
  /** 全部次数，不只是 `reads` 里那几条。 */
  total: z.number().int().nonnegative().default(0),
  bytes: z.number().nonnegative().default(0),
  reads: z.array(contextReadSchema).default([]),
});

export type ContextRead = z.infer<typeof contextReadSchema>;
export type ContextReadsResponse = z.infer<typeof contextReadsResponseSchema>;
