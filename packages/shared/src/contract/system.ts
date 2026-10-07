import { z } from "zod";

import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";

/**
 * `system.*`（契约 §34.2、§34.3）：这台 core 是谁、能答哪些 procedure，以及一次
 * 往返的时钟。不挂旧路径——`GET /api/identity/hello` 照旧是配对之前的匿名面。
 */

export const systemHelloOutputSchema = z.object({
  protocol: z.object({
    major: z.number().int(),
    minor: z.number().int(),
  }),
  /** 这台 core 实现了的 procedure，`<域>.<动词>`；面板按它决定开不开。 */
  procedures: z.array(z.string()),
  capabilities: z.array(z.string()),
  heartbeatMs: z.number().int(),
  maxFrameBytes: z.number().int(),
  /** 这次请求的访问令牌何时到期；没有会话（本机回环匿名）是 `null`。 */
  sessionExpiresAtMs: z.number().int().nullable(),
  instanceId: z.string(),
  sourceId: z.string(),
  version: z.string(),
});

export type SystemHello = z.infer<typeof systemHelloOutputSchema>;

export const system = {
  hello: oc
    .input(z.object({ trace: z.boolean().optional() }))
    .output(systemHelloOutputSchema)
    .errors(errors.pick("unauthenticated", "forbidden"))
    .meta(meta({ scope: "identity:read", since: "1.3", contract: "§34.2" })),
  ping: oc
    .input(z.object({ ts: z.number() }))
    .output(z.object({ ts: z.number(), serverTs: z.number() }))
    .errors(errors.pick("unauthenticated", "forbidden"))
    .meta(meta({ scope: "identity:read", since: "1.3", contract: "§34.3" })),
};
