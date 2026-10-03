import { z } from "zod";

/**
 * GitHub device flow（§4.2）。`deviceCode` 不在这里——它等价于凭据，
 * 只留在 Runtime 内存里。
 */
export const copilotLoginPromptSchema = z.object({
  userCode: z.string(),
  verificationUri: z.string(),
  intervalSeconds: z.number(),
  expiresAt: z.string(),
});

/**
 * token 存在哪（core `SecretBackendKind`）：`keychain` 是 macOS 钥匙串，`dpapi` /
 * `libsecret` 是桌面壳的 `safeStorage`，`file-encrypted` 是服务器壳 master key
 * 封装的文件，`file` 是带 0600 的降级方案。
 */
export const copilotBackendSchema = z.enum([
  "keychain",
  "dpapi",
  "libsecret",
  "file-encrypted",
  "file",
]);

export const copilotAuthSchema = z.object({
  signedIn: z.boolean(),
  backend: copilotBackendSchema,
  pending: copilotLoginPromptSchema.optional(),
});

/** `pending` 之外都是终态，前端停止轮询。 */
export const copilotLoginProgressSchema = z.enum([
  "pending",
  "authorized",
  "expired",
  "denied",
  "error",
]);

export const copilotPollSchema = copilotAuthSchema.extend({
  progress: copilotLoginProgressSchema,
});

export type CopilotAuth = z.infer<typeof copilotAuthSchema>;
export type CopilotBackend = z.infer<typeof copilotBackendSchema>;
export type CopilotLoginPrompt = z.infer<typeof copilotLoginPromptSchema>;
export type CopilotLoginProgress = z.infer<typeof copilotLoginProgressSchema>;
export type CopilotPoll = z.infer<typeof copilotPollSchema>;
