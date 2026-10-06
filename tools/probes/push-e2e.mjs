// 推送端到端探针（补全计划 G1-13，A 档）。
//
// 真进程走一遍「core → 假 APNs / FCM / Web Push / 中继」：
//
//   1. 服务器壳（`apps/server/out/main.js serve`）在临时数据目录里起来，环境变量
//      给 APNs `.p8` 与 FCM 服务账号的**文件路径**，`ARMADRA_PUSH_*_ENDPOINT`
//      指向 push-sink；用启动日志里的配对票换一个会话（Cookie + CSRF）。
//   2. 建工作空间与一个 Claude 终端节点；设备以 iOS / direct 登记（带 X25519
//      公钥）；向 hook 面报一次权限请求与一次 Stop，两条都夹着一段「终端原文」。
//      断言：push-sink 收到两条 APNs 请求，provider token 是 ES256、kid / iss
//      对、用 `.p8` 的公钥验得过；正文是信封，设备私钥解开是 §19.4 的载荷
//      （approval、agentDone），线上与明文里都没有那段终端原文。
//   3. 同一台设备改成 Android / direct：令牌端点收到 RS256 断言，FCM 数据消息的
//      `data.enc` 解得开。
//   4. 改成浏览器 Web Push：VAPID 由 push-sink 自己验签，aes128gcm 订阅者能解。
//   5. 起 `apps/push-relay`（上游也指 push-sink），设置改成 relay：App 向中继换
//      中继令牌、以 relay 登记；苹果那一侧收到的仍是同一个信封，设备私钥能解。
//   6. UnifiedPush（契约 §27.2）：Android 只带分发器端点（push-sink 的
//      `/up/<topic>`）登记，不看 `push.transport`；分发器收到的是信封。dev-stack
//      的 ntfy（`--profile ntfy`，127.0.0.1:8093）在的话再对真 ntfy 走一遍：
//      core POST 到 ntfy 的 UP 端点，从 ntfy 的订阅接口取回消息，设备私钥能解。
//   7. 设备偏好（契约 §27.1）：PATCH 只留「审批」，再报一次权限请求与一次 Stop，
//      分发器只收到审批那一条。
//
// ntfy：`--ntfy <url>` 或 `ARMADRA_NTFY`；否则看 127.0.0.1:8093 在不在，不在就
// 记一笔跳过（CI 没有 Docker）。
//
// push-sink 的来源：`--sink <url>` 或 `ARMADRA_PUSH_SINK`；否则先看 dev-stack 的
// 127.0.0.1:8091 在不在（`pnpm dev-stack up`），不在就在本进程里起一份
// （`tools/dev-stack/push-sink.mjs`，同一份代码）——所以没有 Docker 的 CI 也能跑。
//
// 用法（仓库根目录）：
//   pnpm libs:build
//   pnpm --filter @armadra/server build
//   pnpm --filter @armadra/push-relay build
//   node tools/probes/push-e2e.mjs [输出目录] [--sink http://127.0.0.1:8091]
//
// 产物：<输出目录>/result.json，默认 target/push-e2e/。临时目录、临时 HOME、
// 随机端口，跑完全部删除；不碰任何真实账号与真实推送服务。
import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startPushSink } from "../dev-stack/push-sink.mjs";
import { child, harness, killTmux, sleep } from "./shell-e2e-lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const sinkFlag = args.indexOf("--sink");
const sinkArg =
  sinkFlag >= 0 ? args.splice(sinkFlag, 2)[1] : process.env.ARMADRA_PUSH_SINK;
const ntfyFlag = args.indexOf("--ntfy");
const ntfyArg =
  ntfyFlag >= 0 ? args.splice(ntfyFlag, 2)[1] : process.env.ARMADRA_NTFY;
const output = resolve(args[0] ?? join(root, "target/push-e2e"));
mkdirSync(output, { recursive: true });
const h = harness(output);
const { report, step } = h;
report.failures = [];

function check(ok, name, detail = "") {
  if (ok) step(name, detail);
  else {
    report.failures.push({ name, detail });
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* --------------------------------- 密码学 --------------------------------- */

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const fromB64url = (text) => Buffer.from(text, "base64url");

function x25519Raw(key) {
  return key.export({ format: "jwk" }).x;
}

function x25519Public(raw) {
  return createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: raw },
    format: "jwk",
  });
}

/** App 一侧的解法，按契约 §19.5 独立写一遍，不借 core 的实现。 */
function openEnvelope(envelope, privateKey) {
  if (envelope.v !== 1 || envelope.alg !== "x25519-hkdf-sha256-a256gcm")
    throw new Error(`不认识的信封 ${JSON.stringify(envelope).slice(0, 80)}`);
  const shared = diffieHellman({
    privateKey,
    publicKey: x25519Public(envelope.epk),
  });
  const recipient = x25519Raw(createPublicKey(privateKey));
  const info = Buffer.concat([
    Buffer.from("armadra-push-v1"),
    Buffer.from([0]),
    fromB64url(envelope.epk),
    fromB64url(recipient),
  ]);
  const key = Buffer.from(
    hkdfSync("sha256", shared, fromB64url(envelope.salt), info, 32),
  );
  const sealed = fromB64url(envelope.ct);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    fromB64url(envelope.iv),
  );
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return JSON.parse(
    Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - 16)),
      decipher.final(),
    ]).toString("utf8"),
  );
}

/** 浏览器一侧的 RFC 8291 解法。 */
function openWebPush(body, ua, auth) {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(ua.privateKey);
  const shared = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      fromB64url(auth),
      Buffer.concat([Buffer.from("WebPush: info\0"), ua.publicKey, asPublic]),
      32,
    ),
  );
  const derive = (label, length) =>
    Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from(label), length));
  const decipher = createDecipheriv(
    "aes-128-gcm",
    derive("Content-Encoding: aes128gcm\0", 16),
    derive("Content-Encoding: nonce\0", 12),
  );
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([
    decipher.update(record.subarray(0, record.length - 16)),
    decipher.final(),
  ]);
  return JSON.parse(padded.subarray(0, padded.lastIndexOf(2)).toString());
}

/* ------------------------------ 服务器壳会话 ------------------------------ */

/** 自签名证书只在回环上、只在这里跳过校验。 */
function https(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((done, fail) => {
    const encoded =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = httpsRequest(
      url,
      {
        method,
        rejectUnauthorized: false,
        headers: {
          ...(encoded === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": encoded.length,
              }),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          done({
            status: response.statusCode,
            headers: response.headers,
            body: text ? JSON.parse(text) : null,
          });
        });
      },
    );
    request.on("error", fail);
    request.end(encoded);
  });
}

function session(origin) {
  const jar = new Map();
  let csrf = "";
  const absorb = (headers) => {
    for (const line of headers["set-cookie"] ?? []) {
      const [pair] = line.split(";");
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
  };
  const cookie = () =>
    [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  const call = async (path, { method = "GET", body } = {}) => {
    const unsafe = !["GET", "HEAD"].includes(method);
    if (unsafe && csrf === "") {
      const renewed = await https(`${origin}/api/identity/session/csrf`, {
        method: "POST",
        headers: { origin, cookie: cookie() },
      });
      absorb(renewed.headers);
      csrf = renewed.body?.csrfToken ?? "";
    }
    const answer = await https(`${origin}${path}`, {
      method,
      body,
      headers: {
        origin,
        cookie: cookie(),
        ...(unsafe ? { "x-armadra-csrf": csrf } : {}),
      },
    });
    absorb(answer.headers);
    return answer;
  };
  const pair = async (ticket) => {
    const answer = await https(`${origin}/api/identity/pair`, {
      method: "POST",
      body: { ticket },
      headers: { origin },
    });
    absorb(answer.headers);
    if (answer.status !== 200)
      throw new Error(
        `配对失败 ${answer.status} ${JSON.stringify(answer.body)}`,
      );
    return answer.body;
  };
  return { call, pair };
}

async function must(promise, what) {
  const answer = await promise;
  if (answer.status < 200 || answer.status >= 300)
    throw new Error(
      `${what} → ${answer.status} ${JSON.stringify(answer.body)}`,
    );
  return answer.body;
}

/* --------------------------------- push-sink -------------------------------- */

async function reachable(url) {
  try {
    const answer = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return answer.ok;
  } catch {
    return false;
  }
}

async function chooseSink(keyDir) {
  if (sinkArg) return { base: sinkArg.replace(/\/+$/, ""), source: "given" };
  if (await reachable("http://127.0.0.1:8091"))
    return { base: "http://127.0.0.1:8091", source: "dev-stack" };
  const sink = await startPushSink({ port: 0, keyDir });
  h.cleanups.push(() => sink.close());
  return { base: sink.base, source: "in-process" };
}

async function sinkRecords(base) {
  const answer = await fetch(`${base}/_sink/requests`);
  return (await answer.json()).requests;
}

async function clearSink(base) {
  await fetch(`${base}/_sink/requests`, { method: "DELETE" });
}

/** 只看这次跑出来的记录：dev-stack 的 sink 可能也在给别的包用。 */
async function waitRecords(base, predicate, count, what) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = (await sinkRecords(base)).filter(predicate);
    if (found.length >= count) return found;
    await sleep(100);
  }
  throw new Error(`push-sink 没等到 ${what}`);
}

/* ---------------------------------- 主线 ----------------------------------- */

await h.run(async () => {
  for (const [what, file] of [
    ["服务器壳", "apps/server/out/main.js"],
    ["推送中继", "apps/push-relay/out/main.js"],
  ]) {
    if (!existsSync(join(root, file)))
      throw new Error(`${what}未构建：${file}（见文件头的构建命令）`);
  }

  const keys = h.temp("armadra-push-e2e-keys-");
  const KEY_ID = "E2EKEY0001";
  const TEAM_ID = "E2ETEAM001";
  const TOPIC = "dev.armadra.e2e";
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const p8 = join(keys, `AuthKey_${KEY_ID}.p8`);
  writeFileSync(p8, ec.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const account = join(keys, "service-account.json");
  writeFileSync(
    account,
    JSON.stringify({
      type: "service_account",
      project_id: "armadra-e2e",
      client_email: "push@armadra-e2e.iam.gserviceaccount.com",
      private_key: rsa.privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
    { mode: 0o600 },
  );

  const sink = await chooseSink(keys);
  report.sink = sink;
  step("push-sink 就绪", `${sink.source} ${sink.base}`);
  // 这次运行的设备令牌带一个随机前缀，好在共享的 sink 里认出自己的记录。
  const run = randomBytes(4).toString("hex");
  const mine = (record) =>
    JSON.stringify(record).includes(run) ||
    (record.kind === "fcm-token" &&
      record.jwt?.claims?.iss === "push@armadra-e2e.iam.gserviceaccount.com");

  /* ------------------------------ 1. 服务器壳 ------------------------------ */

  const data = h.temp("armadra-push-e2e-data-");
  // 这条线不看页面：给服务器壳一个只有 index.html 的产物目录，不必先构建 apps/web。
  const webRoot = h.temp("armadra-push-e2e-web-");
  writeFileSync(
    join(webRoot, "index.html"),
    "<!doctype html><title>e2e</title>\n",
  );
  const home = h.temp("armadra-push-e2e-home-");
  h.cleanups.push(() => killTmux(data));
  const server = child(
    h,
    process.execPath,
    [
      join(root, "apps/server/out/main.js"),
      "serve",
      "--data-dir",
      data,
      "--web-root",
      webRoot,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ARMADRA_LOG: "warn",
        ARMADRA_NO_GLOBAL_WRITES: "1",
        ARMADRA_SECRET_BACKEND: "file",
        ARMADRA_PUSH_APNS_KEY_FILE: p8,
        ARMADRA_PUSH_APNS_KEY_ID: KEY_ID,
        ARMADRA_PUSH_APNS_TEAM_ID: TEAM_ID,
        ARMADRA_PUSH_APNS_BUNDLE_ID: TOPIC,
        ARMADRA_PUSH_APNS_ENDPOINT: sink.base,
        ARMADRA_PUSH_FCM_CREDENTIALS_FILE: account,
        ARMADRA_PUSH_FCM_ENDPOINT: sink.base,
      },
    },
  );
  let pairing = "";
  for (let attempt = 0; attempt < 300 && !pairing; attempt += 1) {
    if (server.process.exitCode !== null)
      throw new Error(`服务器壳退出：${server.tail()}`);
    pairing = /armadra-server pairing (\S+)/.exec(server.tail())?.[1] ?? "";
    if (!pairing) await sleep(100);
  }
  if (!pairing) throw new Error(`启动日志里没有配对链接：${server.tail()}`);
  const origin = new URL(pairing).origin;
  const api = session(origin);
  await api.pair(new URL(pairing).hash.replace(/^#pair=/, ""));
  step("服务器壳已起并完成配对", origin);

  // 深链带签发它的源（契约 §19.4 的 `?s=`）：手机据此切到对应的连接。
  const hello = await must(api.call("/api/identity/hello"), "hello");
  const hostId = typeof hello.hostId === "string" ? hello.hostId : "";
  if (hostId === "")
    throw new Error(`hello 没有 hostId：${JSON.stringify(hello)}`);

  const config = await must(api.call("/api/push/config"), "推送配置");
  check(
    config.native.transport === "direct" &&
      config.native.status === "ready" &&
      config.native.platforms.join(",") === "ios,android" &&
      typeof config.webpush.publicKey === "string",
    "只给环境变量里的文件路径，原生走直连、两个平台就绪、Web Push 有 VAPID 公钥",
    JSON.stringify(config),
  );

  /* ------------------------ 2. 工作空间与终端节点 ------------------------- */

  const projectRoot = h.temp("armadra-push-e2e-project-");
  const workspace = await must(
    api.call("/api/workspaces", {
      method: "POST",
      body: { name: "推送探针", rootPath: projectRoot },
    }),
    "建工作空间",
  );
  const boards = await must(
    api.call(`/api/workspaces/${workspace.id}/boards`),
    "列画布",
  );
  const board = boards[0];
  const document = await must(
    api.call(`/api/workspaces/${workspace.id}/boards/${board.id}/document`),
    "读画布",
  );
  const nodeId = randomUUID();
  const stamp = new Date().toISOString();
  await must(
    api.call(`/api/workspaces/${workspace.id}/boards/${board.id}/document`, {
      method: "PUT",
      body: {
        expectedUpdatedAt: document.board.updatedAt,
        nodes: [
          {
            id: nodeId,
            boardId: board.id,
            type: "terminal",
            title: "Claude",
            color: "#0a84ff",
            position: { x: 120, y: 120 },
            size: { width: 640, height: 420 },
            labels: [],
            note: "",
            data: { kind: "terminal", cwd: ".", agent: { id: "claude" } },
            createdAt: stamp,
            updatedAt: stamp,
          },
        ],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        whiteboard: "",
      },
    }),
    "写画布",
  );
  step("建好工作空间与一个 Claude 终端节点", nodeId);

  /* ------------------------ 3. iOS 直连：两条事件 ------------------------- */

  const device = generateKeyPairSync("x25519");
  const devicePublic = x25519Raw(device.publicKey);
  await must(
    api.call("/api/push/devices", {
      method: "PUT",
      body: {
        platform: "ios",
        transport: "direct",
        token: `e2e-ios-${run}`,
        publicKey: devicePublic,
        appVersion: "0.0.0-e2e",
        locale: "zh-CN",
      },
    }),
    "登记 iOS 设备",
  );

  const hookEnv = Object.fromEntries(
    readFileSync(join(data, "hook-endpoint.env"), "utf8")
      .split("\n")
      .map((line) => /^([A-Z_]+)='(.*)'$/.exec(line))
      .filter(Boolean)
      .map((match) => [match[1], match[2]]),
  );
  const SECRET = `TERMINAL-OUTPUT-${run}-rm -rf ~/secret`;
  // hook 面在 Unix 上是一个 socket，Windows 上是回环端口（`hook-endpoint.env`）。
  const hook = (payload, extra = {}) =>
    new Promise((done, fail) => {
      const body = Buffer.from(
        JSON.stringify({ nodeId, version: 1, payload, ...extra }),
      );
      const request = httpRequest(
        {
          ...(hookEnv.ARMADRA_HOOK_SOCK
            ? { socketPath: hookEnv.ARMADRA_HOOK_SOCK }
            : { host: "127.0.0.1", port: Number(hookEnv.ARMADRA_HOOK_PORT) }),
          path: "/hook/claude",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": body.length,
            "x-armadra-hook-token": hookEnv.ARMADRA_HOOK_TOKEN,
          },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () =>
            response.statusCode === 204
              ? done()
              : fail(
                  new Error(
                    `hook 上报 ${response.statusCode} ${Buffer.concat(chunks)}`,
                  ),
                ),
          );
        },
      );
      request.on("error", fail);
      request.end(body);
    });
  if (sink.source !== "in-process") await clearSink(sink.base);
  await hook({ hook_event_name: "SessionStart", session_id: `s-${run}` });
  await hook({ hook_event_name: "UserPromptSubmit", prompt: SECRET });
  await hook(
    {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: SECRET },
    },
    { pendingId: `pend-${randomUUID()}` },
  );
  await hook({ hook_event_name: "Stop", last_assistant_message: SECRET });
  const apns = await waitRecords(
    sink.base,
    (record) => record.kind === "apns" && mine(record),
    2,
    "两条 APNs 请求",
  );
  const kinds = [];
  for (const record of apns) {
    const wire = Buffer.from(record.body, "base64").toString("utf8");
    check(
      !wire.includes(run) && !wire.includes("推送探针"),
      "APNs 正文里没有终端原文、也没有工作空间名",
    );
    const jwt = record.jwt;
    check(
      jwt?.ok === true &&
        jwt.header?.alg === "ES256" &&
        jwt.header?.kid === KEY_ID &&
        jwt.claims?.iss === TEAM_ID &&
        record.headers["apns-topic"] === TOPIC &&
        record.headers["apns-push-type"] === "alert" &&
        record.httpVersion === "2",
      "APNs：HTTP/2、topic、push-type、provider token 的 alg / kid / iss",
      JSON.stringify({ jwt, headers: record.headers }),
    );
    const payload = openEnvelope(JSON.parse(wire).enc, device.privateKey);
    kinds.push(payload.kind);
    check(
      !JSON.stringify(payload).includes(run) &&
        payload.title === "推送探针" &&
        payload.url ===
          `armadra://w/${workspace.id}/n/${nodeId}?s=${encodeURIComponent(hostId)}`,
      `设备私钥解开 ${payload.kind}：标题是工作空间名、深链指向节点并带签发它的源、明文里没有终端原文`,
      JSON.stringify(payload),
    );
  }
  check(
    kinds.sort().join(",") === "agentDone,approval",
    "两条事件各一条通知（等人审批、Agent 完成）",
    kinds.join(","),
  );
  // 签名：进程内的 sink 拿到了 .p8 所在目录，真验 ES256；dev-stack 容器里没有
  // 这把钥，只能记 `unchecked`（形状照样验过）。
  check(
    apns.every((record) =>
      sink.source === "in-process"
        ? record.jwt?.signature === "verified"
        : ["verified", "unchecked"].includes(record.jwt?.signature),
    ),
    "provider token 的签名",
    apns.map((record) => record.jwt?.signature).join(","),
  );

  /* --------------------------- 4. Android 直连 ---------------------------- */

  await must(
    api.call("/api/push/devices", {
      method: "PUT",
      body: {
        platform: "android",
        transport: "direct",
        token: `e2e-fcm-${run}`,
        publicKey: devicePublic,
      },
    }),
    "改登记为 Android",
  );
  await must(api.call("/api/push/test", { method: "POST" }), "测试通知");
  const fcm = await waitRecords(
    sink.base,
    (record) => record.kind === "fcm" && mine(record),
    1,
    "FCM 数据消息",
  );
  const tokenRequest = (await sinkRecords(sink.base)).find(
    (record) =>
      record.kind === "fcm-token" &&
      record.jwt?.claims?.iss === "push@armadra-e2e.iam.gserviceaccount.com",
  );
  check(
    tokenRequest?.status === 200 &&
      tokenRequest.jwt.header.alg === "RS256" &&
      tokenRequest.jwt.claims.scope ===
        "https://www.googleapis.com/auth/firebase.messaging" &&
      tokenRequest.jwt.claims.aud === `${sink.base}/token`,
    "FCM：服务账号断言 RS256、scope 与 aud 对，换到了 access token",
    JSON.stringify(tokenRequest?.jwt),
  );
  {
    const message = JSON.parse(
      Buffer.from(fcm[0].body, "base64").toString("utf8"),
    ).message;
    const payload = openEnvelope(
      JSON.parse(message.data.enc),
      device.privateKey,
    );
    check(
      fcm[0].path === "/v1/projects/armadra-e2e/messages:send" &&
        message.android?.priority === "HIGH" &&
        payload.kind === "test",
      "FCM v1 数据消息，data.enc 设备私钥能解",
      JSON.stringify(payload),
    );
  }

  /* ------------------------------ 5. Web Push ------------------------------ */

  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = b64url(randomBytes(16));
  await must(
    api.call("/api/push/devices", {
      method: "PUT",
      body: {
        platform: "web",
        transport: "webpush",
        locale: "en",
        subscription: {
          endpoint: `${sink.base}/wp/e2e-${run}`,
          keys: { p256dh: b64url(ua.getPublicKey()), auth },
        },
      },
    }),
    "改登记为浏览器订阅",
  );
  await must(api.call("/api/push/test", { method: "POST" }), "测试通知");
  const [webpush] = await waitRecords(
    sink.base,
    (record) => record.kind === "webpush" && mine(record),
    1,
    "Web Push 请求",
  );
  {
    const payload = openWebPush(
      Buffer.from(webpush.body, "base64"),
      { privateKey: ua.getPrivateKey(), publicKey: ua.getPublicKey() },
      auth,
    );
    check(
      webpush.status === 201 &&
        webpush.jwt?.ok === true &&
        webpush.jwt?.signature === "verified" &&
        webpush.headers["content-encoding"] === "aes128gcm" &&
        payload.kind === "test" &&
        payload.body === "Push notifications are working",
      "Web Push：VAPID 验签过、aes128gcm、订阅者解开按设备语言渲染的载荷",
      JSON.stringify({ status: webpush.status, jwt: webpush.jwt, payload }),
    );
  }

  /* -------------------------------- 6. 中继 -------------------------------- */

  const secret = join(keys, "relay.secret");
  writeFileSync(secret, randomBytes(32), { mode: 0o600 });
  const relayPortProbe = await new Promise((done) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
  const relay = child(
    h,
    process.execPath,
    [join(root, "apps/push-relay/out/main.js")],
    {
      cwd: root,
      env: {
        ...process.env,
        ARMADRA_RELAY_PORT: String(relayPortProbe),
        ARMADRA_RELAY_SECRET_FILE: secret,
        ARMADRA_RELAY_APNS_KEY_FILE: p8,
        ARMADRA_RELAY_APNS_KEY_ID: KEY_ID,
        ARMADRA_RELAY_APNS_TEAM_ID: TEAM_ID,
        ARMADRA_RELAY_APNS_TOPIC: TOPIC,
        ARMADRA_RELAY_APNS_ENDPOINT: sink.base,
      },
    },
  );
  const relayUrl = `http://127.0.0.1:${relayPortProbe}`;
  let relayUp = false;
  for (let attempt = 0; attempt < 100 && !relayUp; attempt += 1) {
    if (relay.process.exitCode !== null)
      throw new Error(`中继退出：${relay.tail()}`);
    relayUp = await reachable(relayUrl);
    if (!relayUp) await sleep(100);
  }
  if (!relayUp) throw new Error(`中继没起来：${relay.tail()}`);
  await must(
    api.call("/api/settings", {
      method: "PATCH",
      body: { push: { transport: "relay", relayUrl } },
    }),
    "设置改成中继",
  );
  const relayConfig = await must(api.call("/api/push/config"), "推送配置");
  check(
    relayConfig.native.transport === "relay" &&
      relayConfig.native.status === "ready",
    "设置页改成中继后原生走 relay",
    JSON.stringify(relayConfig.native),
  );
  const registered = await fetch(`${relayUrl}/v1/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "ios", token: `e2e-relay-${run}` }),
  }).then((answer) => answer.json());
  check(
    typeof registered.relayToken === "string" &&
      !registered.relayToken.includes(run),
    "中继令牌不露平台令牌",
  );
  await must(
    api.call("/api/push/devices", {
      method: "PUT",
      body: {
        platform: "ios",
        transport: "relay",
        token: registered.relayToken,
        publicKey: devicePublic,
      },
    }),
    "以中继登记",
  );
  await must(api.call("/api/push/test", { method: "POST" }), "测试通知");
  const [viaRelay] = await waitRecords(
    sink.base,
    (record) =>
      record.kind === "apns" && record.deviceToken === `e2e-relay-${run}`,
    1,
    "中继转发的 APNs 请求",
  );
  {
    const wire = Buffer.from(viaRelay.body, "base64").toString("utf8");
    const payload = openEnvelope(JSON.parse(wire).enc, device.privateKey);
    check(
      viaRelay.jwt?.ok === true &&
        viaRelay.jwt.claims?.iss === TEAM_ID &&
        payload.kind === "test" &&
        !wire.includes("Armadra"),
      "core → 中继 → APNs：苹果拿到的是信封，设备私钥能解",
      JSON.stringify(payload),
    );
  }

  /* ----------------------------- 7. UnifiedPush ----------------------------- */

  const upTopic = `up${run}`;
  const upRegistered = await must(
    api.call("/api/push/devices", {
      method: "PUT",
      body: {
        platform: "android",
        transport: "direct",
        publicKey: devicePublic,
        locale: "en",
        unifiedpush: { endpoint: `${sink.base}/up/${upTopic}?up=1` },
      },
    }),
    "只带 UnifiedPush 端点登记",
  );
  check(
    upRegistered.device.unifiedpush === true &&
      !JSON.stringify(upRegistered).includes(upTopic),
    "登记回执说走 UnifiedPush，端点本身不出接口",
    JSON.stringify(upRegistered.device),
  );
  await must(api.call("/api/push/test", { method: "POST" }), "测试通知");
  const openUp = (record) =>
    openEnvelope(
      JSON.parse(Buffer.from(record.body, "base64").toString("utf8")),
      device.privateKey,
    );
  const [viaUp] = await waitRecords(
    sink.base,
    (record) => record.kind === "unifiedpush" && record.topic === upTopic,
    1,
    "UnifiedPush 请求",
  );
  {
    const wire = Buffer.from(viaUp.body, "base64").toString("utf8");
    const payload = openUp(viaUp);
    check(
      viaUp.status === 200 &&
        viaUp.headers["content-type"] === "application/json" &&
        typeof viaUp.headers.topic === "string" &&
        !wire.includes("Armadra") &&
        !wire.includes("armadra://") &&
        payload.kind === "test" &&
        payload.body === "Push notifications are working",
      "core → UnifiedPush 分发器：设置停在 relay 也走设备自己的端点，分发器只见信封，设备私钥能解",
      JSON.stringify({ headers: viaUp.headers, payload }),
    );
  }

  // 真 ntfy（dev-stack 的 `ntfy` profile）：UnifiedPush 端点是
  // `<ntfy>/<topic>?up=1`，消息从 `<ntfy>/<topic>/json?poll=1` 取回。
  const ntfy =
    ntfyArg?.replace(/\/+$/, "") ??
    ((await fetch("http://127.0.0.1:8093/v1/health", {
      signal: AbortSignal.timeout(1500),
    })
      .then((answer) => answer.ok)
      .catch(() => false))
      ? "http://127.0.0.1:8093"
      : undefined);
  report.ntfy = ntfy ?? null;
  if (ntfy === undefined) {
    step(
      "真 ntfy 跳过",
      "127.0.0.1:8093 不在（pnpm dev-stack up --profile ntfy）",
    );
  } else {
    const ntfyTopic = `upArmadraE2e${run}`;
    await must(
      api.call("/api/push/devices", {
        method: "PUT",
        body: {
          platform: "android",
          transport: "direct",
          publicKey: devicePublic,
          locale: "zh-CN",
          unifiedpush: { endpoint: `${ntfy}/${ntfyTopic}?up=1` },
        },
      }),
      "以 ntfy 的 UnifiedPush 端点登记",
    );
    await must(api.call("/api/push/test", { method: "POST" }), "测试通知");
    let message;
    for (let attempt = 0; attempt < 50 && message === undefined; attempt += 1) {
      const lines = await fetch(`${ntfy}/${ntfyTopic}/json?poll=1`)
        .then((answer) => answer.text())
        .catch(() => "");
      message = lines
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((item) => item.event === "message");
      if (message === undefined) await sleep(200);
    }
    const text =
      message?.encoding === "base64"
        ? Buffer.from(message.message, "base64").toString("utf8")
        : (message?.message ?? "");
    let payload;
    try {
      payload = openEnvelope(JSON.parse(text), device.privateKey);
    } catch (error) {
      payload = { error: String(error) };
    }
    check(
      payload.kind === "test" &&
        payload.body === "推送已连通" &&
        !text.includes("Armadra"),
      "core → 真 ntfy（UnifiedPush）→ 订阅取回：ntfy 存的是信封，设备私钥能解",
      JSON.stringify({ ntfy, payload }),
    );
    // 换回 push-sink 的端点，下一步只看 sink。
    await must(
      api.call("/api/push/devices", {
        method: "PUT",
        body: {
          platform: "android",
          transport: "direct",
          publicKey: devicePublic,
          locale: "en",
          unifiedpush: { endpoint: `${sink.base}/up/${upTopic}?up=1` },
        },
      }),
      "换回 push-sink 的端点",
    );
  }

  /* ------------------------------ 8. 设备偏好 ------------------------------ */

  const listed = await must(api.call("/api/push/devices"), "列设备");
  const current = listed.devices.find((item) => item.current);
  const patched = await must(
    api.call(`/api/push/devices/${current.deviceId}`, {
      method: "PATCH",
      body: { kinds: ["approval"] },
    }),
    "只留审批",
  );
  check(
    patched.device.kinds.join(",") === "approval",
    "PATCH 之后这台设备只收审批",
    JSON.stringify(patched.device.kinds),
  );
  const before = (await sinkRecords(sink.base)).filter(
    (record) => record.kind === "unifiedpush" && record.topic === upTopic,
  ).length;
  // 先离开 done（新的一轮），再要一次审批、再完成一次。
  await hook({ hook_event_name: "UserPromptSubmit", prompt: SECRET });
  await hook(
    {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: SECRET },
    },
    { pendingId: `pend-${randomUUID()}` },
  );
  await hook({ hook_event_name: "Stop", last_assistant_message: SECRET });
  await waitRecords(
    sink.base,
    (record) => record.kind === "unifiedpush" && record.topic === upTopic,
    before + 1,
    "审批那一条",
  );
  // 完成那一条若要发，也早该到了。
  await sleep(1500);
  const delivered = (await sinkRecords(sink.base))
    .filter(
      (record) => record.kind === "unifiedpush" && record.topic === upTopic,
    )
    .slice(before)
    .map((record) => openUp(record).kind);
  check(
    delivered.join(",") === "approval",
    "关掉「Agent 完成」之后只收到审批",
    delivered.join(","),
  );
  // 对照：恢复全部之后同样一轮两条都到——上面少的那条确实是偏好拦下的。
  await must(
    api.call(`/api/push/devices/${current.deviceId}`, {
      method: "PATCH",
      body: { kinds: listed.devices.find((item) => item.current).kinds },
    }),
    "恢复全部种类",
  );
  const restoredFrom = before + delivered.length;
  await hook({ hook_event_name: "UserPromptSubmit", prompt: SECRET });
  await hook(
    {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: SECRET },
    },
    { pendingId: `pend-${randomUUID()}` },
  );
  await hook({ hook_event_name: "Stop", last_assistant_message: SECRET });
  const both = (
    await waitRecords(
      sink.base,
      (record) => record.kind === "unifiedpush" && record.topic === upTopic,
      restoredFrom + 2,
      "恢复后的两条",
    )
  )
    .slice(restoredFrom)
    .map((record) => openUp(record).kind)
    .sort();
  check(
    both.join(",") === "agentDone,approval",
    "恢复全部种类后同一轮收到审批与完成",
    both.join(","),
  );
});
