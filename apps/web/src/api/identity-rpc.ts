import { type ArmadraClient, localClient } from "./client";
import { IdentityRequestError, IdentityTransportError } from "./identity";
import { RuntimeConnectionError, RuntimeRequestError } from "./request";

/**
 * 身份三域（契约 §42：`identity.*`、`security.*`、`accounts.*`）的发送点。
 *
 * 发往本机源（`localSource`：桌面壳与原生 App 是 Bearer，服务器壳托管的页面是
 * 同源 Cookie + CSRF），经契约客户端 `clientFor(localSource)`——桌面壳的页面与
 * core 不同端口，不带 Cookie，所以过得了 CORS。失败换回身份面的两种错误，安全
 * 页、账号页与登录页照旧按 `IdentityRequestError` 的状态与码判：
 *
 *   * core 拒绝：状态、码与原话照旧；限流与锁定的等待秒数在
 *     `details.retryAfterSeconds`（旧路径是 `Retry-After` 头）。
 *   * 连不上：`IdentityTransportError`。
 *
 * 凭据换会话的那几条（配对、登录、注册、重置链接、OAuth 发起）不在契约里，仍走
 * `identity.ts` 的 REST 传输。
 */
export async function identityRpc<T>(
  work: (client: ArmadraClient) => Promise<T>,
): Promise<T> {
  try {
    return await work(localClient());
  } catch (error) {
    if (error instanceof RuntimeRequestError) {
      const details = (error.body as { details?: unknown } | null | undefined)
        ?.details as { retryAfterSeconds?: unknown } | undefined;
      const retry = details?.retryAfterSeconds;
      throw new IdentityRequestError(
        error.status,
        error.code ?? "UNKNOWN",
        error.coreMessage,
        typeof retry === "number" && Number.isFinite(retry) && retry > 0
          ? Math.ceil(retry)
          : 0,
      );
    }
    if (error instanceof RuntimeConnectionError) {
      throw new IdentityTransportError(error);
    }
    throw error;
  }
}
