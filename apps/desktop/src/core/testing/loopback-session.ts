import type { CoreContext } from "../main";
import { identityInstanceId } from "../identity";
import { allScopes } from "../identity/scopes";
import { IdentityService } from "../identity/service";
import { IdentityStore } from "../identity/store";
import { WS_TICKET_PROTOCOL } from "../identity/transport";

/**
 * 测试用：在一台真 core 的回环监听上拿一个本机主人的会话（契约 §3.2，安全审查
 * L9）。
 *
 * 回环匿名不再按主人放行，测试和桌面壳的页面一样配对：票由身份服务直接签（壳
 * 走的是数据目录下的私有通道，那条通道在 Windows 上不开，测试不依赖它），再在
 * 回环监听上 `POST /api/identity/pair` 换一份原生会话。
 */

export const TEST_ORIGIN = "http://127.0.0.1:1";

export interface LoopbackSession {
  readonly origin: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  /** 带凭据的请求头：`origin` 与 `authorization`。 */
  readonly headers: Readonly<Record<string, string>>;
  /** 带凭据的 `fetch`：`path` 相对 core 的基址，调用方的头叠在上面。 */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** 换一张一次性 WebSocket 票，给 `Sec-WebSocket-Protocol` 用的那一整段。 */
  wsProtocol(): Promise<string>;
}

export async function loopbackSession(
  core: Pick<CoreContext, "db">,
  base: string,
  origin: string = TEST_ORIGIN,
): Promise<LoopbackSession> {
  const service = new IdentityService(
    new IdentityStore(core.db.database),
    identityInstanceId(),
  );
  const { ticket } = service.issueBootstrap({
    hostId: service.hostId(),
    instanceId: identityInstanceId(),
    origin,
    deviceName: "test",
    scopes: allScopes(),
  });
  const root = base.replace(/\/+$/, "");
  const paired = await fetch(`${root}/api/identity/pair`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  if (!paired.ok) {
    throw new Error(`pairing failed: ${paired.status} ${await paired.text()}`);
  }
  const body = (await paired.json()) as {
    native?: { accessToken: string; refreshToken: string };
  };
  if (body.native === undefined) throw new Error("pairing gave no keys");
  const { accessToken, refreshToken } = body.native;
  const headers = { origin, authorization: `Bearer ${accessToken}` };
  const authed = (path: string, init: RequestInit = {}) =>
    fetch(`${root}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string>) },
    });
  return {
    origin,
    accessToken,
    refreshToken,
    headers,
    fetch: authed,
    async wsProtocol() {
      const answer = await authed("/api/identity/ws-ticket", {
        method: "POST",
      });
      if (!answer.ok) throw new Error(`ws-ticket: ${answer.status}`);
      const { ticket: issued } = (await answer.json()) as { ticket: string };
      return `${WS_TICKET_PROTOCOL}${issued}`;
    },
  };
}
