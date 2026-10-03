/**
 * dev-stack 的服务表：固定端口、用途与宿主机一侧的健康检查。
 *
 * 这是端口的唯一来源——`docker-compose.yml` 的 `ports` 必须与这里一致
 * （`stack.test.mjs` 守），探针与集成测试也从这里取地址，而不是各写各的。
 *
 * 健康检查都从宿主机发，走 127.0.0.1：容器里的 healthcheck 只说明进程活着，
 * 这里说明的是「测试真正会走的那条路」通了。自签证书的服务（pebble、step-ca、
 * armadra-server）只在这里、只对回环地址跳过证书校验。
 */
import { request as httpRequest } from "node:http";
import { connect } from "node:net";

export const HOST = "127.0.0.1";

/**
 * `ports` 是宿主机端口（容器端口相同时省略）。`profile` 标了的是可选服务，
 * 只有 `pnpm dev-stack up --profile <名>` 才起。`check` 返回 `true` 或抛错。
 */
export const SERVICES = [
  {
    name: "release",
    ports: [8090],
    purpose: "更新检查、latest.json、下载与验签（§3）",
    check: async () => {
      const { status, body } = await get(
        "http://127.0.0.1:8090/repos/armadra/armadra/releases",
      );
      expect(status === 200, `status ${status}`);
      const releases = JSON.parse(body);
      expect(
        releases.some((release) =>
          release.assets.some((asset) => asset.name === "latest.json"),
        ),
        "no latest.json asset",
      );
    },
  },
  {
    name: "pebble",
    ports: [14000, 15000],
    purpose: "ACME 签发、续期与失败（§6.3）",
    check: async () => {
      const { status, body } = await get("https://127.0.0.1:14000/dir");
      expect(status === 200, `status ${status}`);
      expect(JSON.parse(body).newAccount, "no newAccount in directory");
    },
  },
  {
    name: "step-ca",
    ports: [9000],
    purpose: "第二个 ACME 实现与本地 CA 根（§6.3 / §6.4）",
    check: async () => {
      const { status, body } = await get("https://127.0.0.1:9000/health");
      expect(status === 200, `status ${status}`);
      expect(JSON.parse(body).status === "ok", body);
    },
  },
  {
    name: "dex",
    ports: [5556],
    purpose: "OIDC 授权码 + PKCE，静态用户（§7.1）",
    check: () => discovery("http://127.0.0.1:5556/dex"),
  },
  {
    name: "keycloak",
    ports: [8080],
    purpose: "第二个 issuer、发现文档差异、SSO 登出（§7.1）",
    check: () => discovery("http://127.0.0.1:8080/realms/armadra"),
  },
  {
    name: "mailpit",
    ports: [1025, 8025],
    purpose: "SMTP 发送与收件断言（§7.5）",
    check: async () => {
      const { status } = await get("http://127.0.0.1:8025/api/v1/info");
      expect(status === 200, `status ${status}`);
      const banner = await smtpBanner(HOST, 1025);
      expect(banner.startsWith("220"), `smtp banner ${banner}`);
    },
  },
  {
    name: "gitea",
    ports: [3000],
    purpose: "core/forge 的 Gitea / Forgejo 实现（§10.2）",
    check: async () => {
      const { status, body } = await get("http://127.0.0.1:3000/api/healthz");
      expect(status === 200, `status ${status}`);
      expect(JSON.parse(body).status === "pass", body);
    },
  },
  {
    name: "glitchtip",
    ports: [8000],
    purpose: "可选崩溃上报的事件形状与剥离（§11.2）",
    dependsOn: ["glitchtip-postgres", "glitchtip-redis"],
    check: async () => {
      const { status } = await get("http://127.0.0.1:8000/_health/");
      expect(status === 200, `status ${status}`);
    },
  },
  {
    name: "push-sink",
    ports: [8091],
    purpose: "假 APNs / FCM / Web Push / 中继：记录请求、校验 JWT（§5.2）",
    check: async () => {
      const { status } = await get("http://127.0.0.1:8091/health");
      expect(status === 200, `status ${status}`);
    },
  },
  {
    name: "hibp",
    ports: [8092],
    purpose: "Pwned Passwords range API 固定响应（§7.4）",
    check: async () => {
      // SHA-1("password") = 5BAA6 1E4C9B93F3F0682250B6CF8331B7EE68FD8
      const { status, body } = await get("http://127.0.0.1:8092/range/5BAA6");
      expect(status === 200, `status ${status}`);
      expect(body.includes("1E4C9B93F3F0682250B6CF8331B7EE68FD8:"), body);
    },
  },
  {
    name: "armadra-server",
    ports: [8443],
    purpose: "容器化服务器壳本身（§4.4）",
    check: async () => {
      const { status } = await get("https://127.0.0.1:8443/health");
      expect(status === 200, `status ${status}`);
    },
  },
  {
    name: "headscale",
    ports: [8094],
    profile: "headscale",
    purpose: "自托管控制面，只做文档验证，不进 CI（§6.2）",
    check: async () => {
      const { status } = await get("http://127.0.0.1:8094/health");
      expect(status === 200, `status ${status}`);
    },
  },
  {
    name: "ntfy",
    ports: [8093],
    profile: "ntfy",
    purpose: "UnifiedPush 分发（§5.2）",
    check: async () => {
      const { status, body } = await get("http://127.0.0.1:8093/v1/health");
      expect(status === 200, `status ${status}`);
      expect(JSON.parse(body).healthy === true, body);
    },
  },
];

/** Compose services that exist only to back another one. */
export const SUPPORT_SERVICES = ["glitchtip-postgres", "glitchtip-redis"];

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * GET over http or https. For https it skips certificate verification: every
 * dev-stack TLS endpoint is self-signed and on loopback, and this function is
 * refused anything else.
 */
export async function get(url, { timeoutMs = 5000 } = {}) {
  const target = new URL(url);
  if (target.hostname !== HOST)
    throw new Error(`dev-stack checks only ${HOST}`);
  // https 按需加载：设了 NODE_USE_SYSTEM_CA 时它要读系统证书库，没 Docker 的
  // 快速退出路径不该为此等待。
  const request =
    target.protocol === "https:"
      ? (await import("node:https")).request
      : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = request(
      target,
      {
        method: "GET",
        // ACME（RFC 8555 §6.1）要求带 User-Agent，pebble 不带就答 400。
        headers: { "user-agent": "armadra-dev-stack" },
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );
    outgoing.on("timeout", () => outgoing.destroy(new Error("timed out")));
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function discovery(issuer) {
  const { status, body } = await get(
    `${issuer}/.well-known/openid-configuration`,
  );
  expect(status === 200, `status ${status}`);
  const document = JSON.parse(body);
  expect(document.issuer === issuer, `issuer ${document.issuer}`);
  expect(
    (document.code_challenge_methods_supported ?? []).includes("S256"),
    "no S256 PKCE",
  );
}

function smtpBanner(host, port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("smtp timed out"));
    }, timeoutMs);
    socket.once("data", (chunk) => {
      clearTimeout(timer);
      socket.end("QUIT\r\n");
      resolve(chunk.toString("utf8").trim());
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Run one service's check; never throws. */
export async function checkService(service) {
  const started = Date.now();
  try {
    await service.check();
    return { service: service.name, ok: true, ms: Date.now() - started };
  } catch (error) {
    return {
      service: service.name,
      ok: false,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Services selected by name and/or profile; default = everything not in a profile. */
export function selectServices({ names = [], profiles = [] } = {}) {
  if (names.length > 0) {
    const unknown = names.filter(
      (name) =>
        !SERVICES.some((service) => service.name === name) &&
        !SUPPORT_SERVICES.includes(name),
    );
    if (unknown.length > 0)
      throw new Error(`unknown dev-stack service: ${unknown.join(", ")}`);
    return SERVICES.filter((service) => names.includes(service.name));
  }
  return SERVICES.filter(
    (service) => !service.profile || profiles.includes(service.profile),
  );
}
