// 探针在桌面壳起的 core 上拿一个本机主人的会话（契约 §3.2，安全审查 L9）。
//
// 桌面壳不把 ARMADRA_LOOPBACK_OWNER 带给 core，壳起的 core 不放行回环上没带
// 凭据的请求。探针从 Node 直接打它的接口时和托盘一样：向数据目录下的私有通道
// （0600 的 Unix socket，`core-control.sock`）要一张票，在回环监听上
// `POST /api/identity/pair` 换一份 Bearer。来源用 core 自己的回环基址。
//
// 私有通道在 Windows 上不开（那里壳经 fork 的 IPC 取票，探针够不着），所以这
// 个辅助只在 macOS 与 Linux 上用。
import { request as httpRequest } from "node:http";
import { join } from "node:path";

/** 升级 WebSocket 时在 `Sec-WebSocket-Protocol` 里带的票的前缀。 */
export const WS_TICKET_PROTOCOL = "armadra-ticket.";

function controlTicket(dataDir, origin) {
  const body = Buffer.from(
    JSON.stringify({ origin, deviceName: "probe" }),
    "utf8",
  );
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath: join(dataDir, "core-control.sock"),
        path: "/control/identity/ticket",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.byteLength),
        },
        timeout: 5_000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode !== 200) {
            reject(
              new Error(`私有通道拒绝签票：${response.statusCode} ${text}`),
            );
            return;
          }
          resolve(JSON.parse(text).ticket);
        });
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error("签票超时")));
    request.on("error", reject);
    request.end(body);
  });
}

/**
 * `{ origin, headers, fetch(path, init), wsProtocol() }`。`fetch` 的 `path`
 * 相对 `base`，调用方的头叠在会话的头之上。
 */
export async function probeSession({ dataDir, base }) {
  if (process.platform === "win32") {
    throw new Error("Windows 上探针拿不到桌面壳 core 的票（私有通道不开）");
  }
  const root = String(base).replace(/\/+$/, "");
  const origin = new URL(root).origin;
  // 私有通道是 core 装配时异步绑的，可能比 endpoints.json 晚一点出现。
  let ticket;
  for (let attempt = 0; ; attempt += 1) {
    try {
      ticket = await controlTicket(dataDir, origin);
      break;
    } catch (error) {
      if (attempt >= 50) throw error;
      await new Promise((done) => setTimeout(done, 200));
    }
  }
  const paired = await fetch(`${root}/api/identity/pair`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  if (!paired.ok) {
    throw new Error(`配对失败：${paired.status} ${await paired.text()}`);
  }
  const { native } = await paired.json();
  if (!native?.accessToken) throw new Error("配对没有给出原生会话的密钥");
  const headers = { origin, authorization: `Bearer ${native.accessToken}` };
  const authed = (path, init = {}) =>
    fetch(new URL(path, `${root}/`), {
      ...init,
      headers: { ...(init.headers ?? {}), ...headers },
    });
  return {
    origin,
    headers,
    fetch: authed,
    async wsProtocol() {
      const answer = await authed("/api/identity/ws-ticket", {
        method: "POST",
      });
      if (!answer.ok) throw new Error(`ws-ticket：${answer.status}`);
      return `${WS_TICKET_PROTOCOL}${(await answer.json()).ticket}`;
    },
  };
}

/**
 * 安全审查 L9 的守门：本机另一个回环端口上的网页（这里用一个编出来的回环来源）
 * 直接打 `/api/settings`、升级事件流，都该被拒。答 `{ settings, upgrade }`，
 * 两个都是状态码（升级被拒时是 HTTP 状态，升上去了是 101）。
 */
export async function strangerRefused(base, workspaceId) {
  const stranger = "http://127.0.0.1:9";
  const settings = (
    await fetch(new URL("/api/settings", base), {
      headers: { origin: stranger },
    })
  ).status;
  const url = new URL(`/api/workspaces/${workspaceId}/events`, base);
  const upgrade = await new Promise((resolve) => {
    const request = httpRequest({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        origin: stranger,
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
      timeout: 5_000,
    });
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(0));
    request.end();
  });
  return { settings, upgrade };
}
