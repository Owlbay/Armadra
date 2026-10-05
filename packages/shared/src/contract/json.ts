import { z } from "zod";

/**
 * 「原样 JSON」的形状。契约的 output 不许 `z.unknown()` / `z.any()`
 * （`contract.test.ts` 守着）；确实是一份任意 JSON 的（设置文档）用它。
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
