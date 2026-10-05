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
    name: "platform-postgres",
    ports: [5441],
    profile: "platform",
    purpose: "云控制面的 PostgreSQL（平台设计 §13.4）",
    check: () => tcpOpen(HOST, 5441),
  },
  {
    name: "platform-redis",
    ports: [6391],
    profile: "platform",
    purpose: "云控制面与中继共用的 Redis",
    check: () => tcpOpen(HOST, 6391),
  },
  {
    name: "cloud",
    ports: [8100],
    profile: "platform",
    dependsOn: ["platform-postgres", "platform-redis"],
    purpose: "armadra-cloud 控制面（云仓；SaaS 路由预留，答 501）",
    check: async () => {
      // /ready 逐项报 PostgreSQL 与 Redis；well-known 落地前答 501（预留）。
      const ready = await get("http://127.0.0.1:8100/ready");
      expect(ready.status === 200, `ready status ${ready.status}`);
      await platformMode("http://127.0.0.1:8100", "saas");
    },
  },
  {
    name: "relay",
    ports: [8101],
    profile: "platform",
    dependsOn: ["platform-redis"],
    purpose: "多租户中继（saas 模式，本地走 HTTP，地址 *.src.localhost）",
    check: async () => {
      const { status } = await get("http://127.0.0.1:8101/health");
      expect(status === 200, `status ${status}`);
    },
  },
  {
    name: "relay-personal",
    ports: [8103],
    profile: "personal",
    purpose: "单人中转（personal 模式，不带数据库）",
    // R2 落地前只有 --tls plain；落地后是自签 TLS。两种都认，只对回环。
    check: async () => {
      const base = await first(
        ["https://127.0.0.1:8103", "http://127.0.0.1:8103"],
        "/health",
      );
      expect(base.status === 200, `status ${base.status}`);
      await platformMode(base.origin, "personal");
    },
  },
  {
    name: "armadra-server-nat",
    ports: [],
    profile: ["platform", "personal"],
    purpose:
      "模拟在 NAT 后、只能外连的 core：不发布端口，健康由容器内自己的 /health 给出",
    check: () => containerHealthy("armadra-server-nat"),
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
  {
    name: "pebble-va",
    ports: [14100, 15100],
    profile: "pebble-va",
    purpose: "真回连挑战地址的 ACME：tls-alpn-01 / http-01（§6.3）",
    check: async () => {
      const { status, body } = await get("https://127.0.0.1:14100/dir");
      expect(status === 200, `status ${status}`);
      expect(JSON.parse(body).newAccount, "no newAccount in directory");
    },
  },
  {
    name: "caddy",
    ports: [8444],
    profile: "caddy",
    purpose: "反向代理演练，部署指南 §3.3（§4.4）",
    // 上游没起时 Caddy 答 502；这里只确认代理本身在听。
    check: () => tcpOpen(HOST, 8444),
  },
  {
    name: "s3",
    ports: [8095],
    profile: "s3",
    purpose: "S3 兼容桶，更新镜像作业的替身（§3.3）",
    check: async () => {
      // 不带签名的请求只该被拒；答的是 S3 的 AccessDenied 才说明网关与鉴权都在。
      const { status, body } = await get("http://127.0.0.1:8095/");
      expect(status === 403, `status ${status}`);
      expect(body.includes("<Code>AccessDenied</Code>"), body.slice(0, 200));
    },
  },
];

/** dev-stack `s3` 的访问键：只在回环上、只给本地桶用，与 docker-compose.yml 一致。 */
export const S3_DEV = {
  endpoint: "http://127.0.0.1:8095",
  accessKeyId: "armadra-dev",
  secretAccessKey: "armadra-dev-mirror",
  region: "us-east-1",
};

/** 服务所属的 profile 列表（`profile` 可以是一个名字或一组）。 */
export function profilesOf(service) {
  if (!service.profile) return [];
  return Array.isArray(service.profile) ? service.profile : [service.profile];
}

/**
 * 这些 profile 是自成一体的环境：只选它们自己的服务，不连带默认那组。
 * 其余 profile（headscale、ntfy…）只是在默认那组之上加料。
 */
export const SCOPED_PROFILES = ["platform", "personal"];

/** Compose services that exist only to back another one. */
export const SUPPORT_SERVICES = ["glitchtip-postgres", "glitchtip-redis"];

/** dev-stack 的 compose 项目名（与 docker-compose.yml 的 `name:` 一致）。 */
export const PROJECT = "armadra-dev";

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

/**
 * 平台协议的 well-known：200 时 `mode` 必须对得上；501（SaaS 预留）与 404（personal 的 R2 之前）是落地前的回答，
 * 视为通过；其余都算失败。
 */
async function platformMode(origin, mode) {
  const { status, body } = await get(`${origin}/.well-known/armadra-platform`);
  if (status === 501 || status === 404) return;
  expect(status === 200, `well-known status ${status}`);
  expect(JSON.parse(body).mode === mode, `mode ${JSON.parse(body).mode}`);
}

/** 依次试几个回环源，取第一个连得上的（自签 TLS 与 plain 并存的过渡期）。 */
async function first(origins, path) {
  let last;
  for (const origin of origins) {
    try {
      return { origin, ...(await get(`${origin}${path}`)) };
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

/**
 * 没有发布端口的服务：进容器里打它自己的回环 /health（宿主机够不到它，这正是「NAT 后」的
 * 含义）。容器没在跑、或 /health 不答 200 都算失败。
 */
async function containerHealthy(service, port = 8443) {
  const { spawnSync } = await import("node:child_process");
  const docker = process.env.ARMADRA_DEV_STACK_DOCKER || "docker";
  const script = `process.env.NODE_TLS_REJECT_UNAUTHORIZED="0";fetch("https://127.0.0.1:${port}/health").then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))`;
  const result = spawnSync(
    docker,
    ["exec", `${PROJECT}-${service}-1`, "node", "-e", script],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(result.status === 0, `container ${service} /health failed`);
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
function tcpOpen(host, port, timeoutMs = 5000) {
  return new Promise((done, failed) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      failed(new Error(`tcp ${port} timeout`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      done(true);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      failed(error);
    });
  });
}

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
  if (profiles.some((profile) => SCOPED_PROFILES.includes(profile)))
    return SERVICES.filter((service) =>
      profilesOf(service).some((profile) => profiles.includes(profile)),
    );
  return SERVICES.filter(
    (service) =>
      profilesOf(service).length === 0 ||
      profilesOf(service).some((profile) => profiles.includes(profile)),
  );
}
