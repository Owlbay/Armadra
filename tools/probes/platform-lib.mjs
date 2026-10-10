// 平台探针（personal-roundtrip、multi-source、link-join、nat-core-offline）共用的件。
//
// 都是 V1 `personal-roundtrip` 里长出来的、第二条探针开始要重复的东西：
//   * 对中继的 HTTPS 调用（钉 CA）与 CA 指纹；
//   * 页面小工具（节点选择器、按文字找按钮、终端收发）；
//   * 起一个真 Electron（临时数据目录与 HOME、mock 钥匙串）并连上它的渲染页；
//   * 经中继登记一台 core（`remoteAdd` → 注册令牌 → `identity.cloud.register` → 隧道
//     ready → 断言 → 绑定为主人）；
//   * 个人中转本身：`spawnRelay`（armadra-cloud 检出里直接 node 跑）与
//     `startDockerRelay`（同一个中继在容器里，可以 `docker pause`）。
//
// 探针只许碰自己造出来的东西：数据目录、HOME、容器、卷都带随机后缀，收尾只删自己的。
import { spawn, spawnSync } from "node:child_process";
import { X509Certificate, createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { join } from "node:path";

import { isolatedEnv, probeHome } from "./probe-home.mjs";
import { probeSession } from "./probe-session.mjs";
import { attachRenderer } from "./relay-desktop.mjs";
import { freePort, root, sleep, until } from "./ui-features/harness.mjs";

/* ------------------------------ 对中继的调用 ------------------------------ */

/** 钉着中继 CA 的 HTTPS 调用（issuer 是 `http:` 时走明文，本地 workerd 用）；答 `{ status, headers, body }`，不因状态码抛错。 */
export function relayRaw(
  issuer,
  ca,
  method,
  path,
  { body, token, headers } = {},
) {
  const url = new URL(path, issuer);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const plain = url.protocol === "http:";
  return new Promise((done, fail) => {
    const request = (plain ? httpRequest : httpsRequest)(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        ...(plain ? {} : { ca }),
        headers: {
          accept: "application/json",
          ...(payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(headers ?? {}),
        },
        timeout: 15_000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            /* 不是 JSON：原文。 */
          }
          done({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: parsed,
          });
        });
        response.on("error", fail);
      },
    );
    request.on("timeout", () => request.destroy(new Error("中继调用超时")));
    request.on("error", fail);
    request.end(payload);
  });
}

/**
 * 在同一条 keep-alive 连接上：POST `first` → 空闲 `idleMs` → POST `then(第一次的答复)`。
 *
 * iOS 的 WebKit 复用一条刚被服务端空闲关掉的连接发 POST 时不重试，直接报加载失败
 * （Chromium 会重试，所以浏览器探针看不出来）。这里不重试：服务端在空闲期间关了连接
 * 就记 `closedByServer`，第二次 POST 换了连接就记 `reused: false`。
 * 每一步是 `{ path, body, headers }`；答 `{ answers: [{status, body}…], reused,
 * closedByServer, idleMs }`。
 */
export async function idleKeepAlivePost(
  issuer,
  ca,
  first,
  then,
  idleMs = 6_500,
) {
  const agent = new HttpsAgent({ keepAlive: true, maxSockets: 1, ca });
  const sockets = new Set();
  let closedByServer = false;
  const post = ({ path, body = {}, headers = {} }) =>
    new Promise((done, fail) => {
      const url = new URL(path, issuer);
      const payload = JSON.stringify(body);
      const request = httpsRequest(
        {
          host: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method: "POST",
          agent,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
            ...headers,
          },
          timeout: 15_000,
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed = text;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              /* 不是 JSON：原文。 */
            }
            done({ status: response.statusCode ?? 0, body: parsed });
          });
          response.on("error", fail);
        },
      );
      request.on("socket", (socket) => {
        if (sockets.has(socket)) return;
        sockets.add(socket);
        socket.once("close", () => (closedByServer = true));
      });
      request.on("timeout", () => request.destroy(new Error("中继调用超时")));
      request.on("error", fail);
      request.end(payload);
    });
  try {
    const one = await post(first);
    await sleep(idleMs);
    const closedDuringIdle = closedByServer;
    const two = await post(then(one)).catch((error) => ({
      status: 0,
      body: `error: ${error.message}`,
    }));
    return {
      answers: [one, two],
      reused: sockets.size === 1,
      closedByServer: closedDuringIdle,
      idleMs,
    };
  } finally {
    agent.destroy();
  }
}

/** PEM 证书的 SHA-256 指纹（64 位小写十六进制）。 */
export function caFingerprint(pem) {
  return createHash("sha256")
    .update(new X509Certificate(pem).raw)
    .digest("hex");
}

/** 给中继调用包一层：`call` 不抛错，`must` 状态码 ≥ 400 就抛。 */
export function relayClient(issuer, caPem) {
  const call = (method, path, options) =>
    relayRaw(issuer, caPem, method, path, options);
  const must = async (method, path, options) => {
    const answer = await call(method, path, options);
    if (answer.status >= 400)
      throw new Error(
        `${method} ${path} → ${answer.status} ${JSON.stringify(answer.body).slice(0, 200)}`,
      );
    return answer.body;
  };
  return { call, must };
}

/** 子进程用的环境：探针自己不放宽 TLS 校验，也不让它漏进子进程。 */
export const cliEnv = () => {
  const env = { ...process.env };
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  return env;
};

/** 在 armadra-cloud 检出里直接 node 跑中继 CLI（`personal <子命令>`）。 */
export function spawnRelay(cloudHome, args, env = {}) {
  const child = spawn(
    process.execPath,
    ["apps/relay/src/cli.ts", "personal", ...args],
    {
      cwd: cloudHome,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...cliEnv(), ...env },
    },
  );
  let log = "";
  const take = (chunk) => (log += chunk);
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  return { child, log: () => log };
}

/* ------------------------- 容器里的个人中转（可暂停） ------------------------- */

const docker = (args, options = {}) =>
  spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 600_000,
    ...options,
  });

/** Docker 守护进程答得上。 */
export function dockerReady() {
  return (
    spawnSync("docker", ["info"], { stdio: "ignore", timeout: 30_000 })
      .status === 0
  );
}

/**
 * 中继镜像：`ARMADRA_PROBE_RELAY_IMAGE` 指定就用它，否则从 armadra-cloud 检出
 * `docker build`（层缓存命中时是秒级）。
 */
export function ensureRelayImage(cloudHome) {
  const given = process.env.ARMADRA_PROBE_RELAY_IMAGE;
  if (given) return given;
  const tag = "armadra-probe-relay:local";
  const built = docker(
    ["build", "-q", "-f", "apps/relay/Dockerfile", "-t", tag, "."],
    { cwd: cloudHome },
  );
  if (built.status !== 0)
    throw new Error(`中继镜像构建失败：${(built.stderr ?? "").slice(-1500)}`);
  return tag;
}

/**
 * 容器里的个人中转：`personal init`（自签 TLS，对外地址 `https://127.0.0.1:<端口>`）
 * 后 `personal serve`，端口只发布到 127.0.0.1，`/app/` 与 `/j/` 托管 `webRoot`。
 *
 * 地址与监听用同一个随机端口（容器内外一致），这样证书、断言的签发方与客户端
 * 访问的地址三者相同——和 V1 里直接 node 跑的中继同一个形状，只是它在容器里，
 * 能 `docker pause` 把它整个冻住。
 *
 * 返回 `{ issuer, port, caPem, fingerprint, password, account, call, must,
 * pause(), unpause(), alive(), logs(), stop() }`。
 */
export async function startDockerRelay({
  cloudHome,
  webRoot,
  scratch,
  password,
  account = "dev",
}) {
  if (!dockerReady()) throw new Error("Docker 守护进程没有运行");
  const image = ensureRelayImage(cloudHome);
  const suffix = randomBytes(4).toString("hex");
  const name = `armadra-probe-relay-${suffix}`;
  const volume = `${name}-data`;
  const port = await freePort();
  const issuer = `https://127.0.0.1:${port}`;
  const passwordDir = mkdtempSync(join(scratch, "relay-pw-"));
  const passwordFile = join(passwordDir, "password");
  writeFileSync(passwordFile, password, { mode: 0o644 });
  chmodSync(passwordDir, 0o755);

  const created = docker(["volume", "create", volume]);
  if (created.status !== 0) throw new Error(`建卷失败：${created.stderr}`);
  const common = ["--data-dir", "/data", "--host", "127.0.0.1"];
  const initRun = docker([
    "run",
    "--rm",
    "-v",
    `${volume}:/data`,
    "-v",
    `${passwordFile}:/run/relay-password:ro`,
    image,
    "personal",
    "init",
    ...common,
    "--account",
    account,
    "--port",
    String(port),
    "--tls",
    "self-signed",
    "--password-file",
    "/run/relay-password",
  ]);
  const initText = `${initRun.stdout ?? ""}${initRun.stderr ?? ""}`;
  if (initRun.status !== 0) {
    docker(["volume", "rm", "-f", volume]);
    throw new Error(`personal init 失败：${initText.slice(-1500)}`);
  }
  const started = docker([
    "run",
    "-d",
    "--name",
    name,
    "-p",
    `127.0.0.1:${port}:${port}`,
    "-v",
    `${volume}:/data`,
    "-v",
    `${webRoot}:/app/web:ro`,
    image,
    "personal",
    "serve",
    ...common,
    "--port",
    String(port),
    "--listen",
    `0.0.0.0:${port}`,
    "--tls",
    "self-signed",
    "--web-root",
    "/app/web",
    "--log-level",
    "info",
  ]);
  if (started.status !== 0) {
    docker(["volume", "rm", "-f", volume]);
    throw new Error(`personal serve 起不来：${started.stderr}`);
  }
  const caFile = join(passwordDir, "ca.crt");
  const relay = {
    name,
    volume,
    image,
    issuer,
    port,
    password,
    account,
    initText,
    pausedNow: false,
    logs: () => {
      const out = docker(["logs", name]);
      return `${out.stdout ?? ""}${out.stderr ?? ""}`;
    },
    pause() {
      const run = docker(["pause", name]);
      if (run.status !== 0) throw new Error(`docker pause：${run.stderr}`);
      relay.pausedNow = true;
    },
    unpause() {
      const run = docker(["unpause", name]);
      if (run.status !== 0) throw new Error(`docker unpause：${run.stderr}`);
      relay.pausedNow = false;
    },
    alive: () =>
      docker(["inspect", "-f", "{{.State.Running}}", name]).stdout?.trim() ===
      "true",
    async stop() {
      docker(["rm", "-f", name]);
      docker(["volume", "rm", "-f", volume]);
    },
  };
  try {
    // CA 在 serve 签完证书后才落盘：等它出现再取。
    await until(
      () => docker(["cp", `${name}:/data/tls/ca.crt`, caFile]).status === 0,
      "中继的自签 CA 落盘",
      { timeout: 60_000, every: 500 },
    );
    relay.caPem = readFileSync(caFile, "utf8");
    relay.fingerprint = caFingerprint(relay.caPem);
    Object.assign(relay, relayClient(issuer, relay.caPem));
    relay.info = await until(
      async () => {
        if (!relay.alive()) throw new Error(`中继容器退出：${relay.logs()}`);
        try {
          const answer = await relay.call(
            "GET",
            "/.well-known/armadra-platform",
          );
          return answer.status === 200 ? answer.body : null;
        } catch {
          return null;
        }
      },
      "个人中转起来",
      { timeout: 60_000, every: 500 },
    );
  } catch (error) {
    await relay.stop();
    throw error;
  }
  return relay;
}

/* --------------------------------- 页面小工具 --------------------------------- */

export const nodeAt = (id) => `.react-flow__node[data-id="${id}"]`;

/** 点可见文字等于 `texts` 之一的按钮（取最后一个：对话框在 body 末尾）。 */
export const buttonByText = (texts, selector = "button") => `
  const texts = ${JSON.stringify([texts].flat())};
  return [...document.querySelectorAll(${JSON.stringify(selector)})]
    .filter((n) => n.getClientRects().length > 0 && !n.disabled)
    .filter((n) => texts.some((t) => (n.innerText ?? "").trim() === t || n.getAttribute("aria-label") === t))
    .at(-1) ?? null;`;

export const buttonExists = (texts) =>
  `return !!(() => { ${buttonByText(texts)} })();`;

export const hasText = (page, text, what, timeout = 30_000) =>
  page.until(
    `return document.body.innerText.includes(${JSON.stringify(text)}) ? true : null;`,
    what,
    { timeout },
  );

/** 浏览器页面（harness 的页面）里：终端挂上 xterm、点进去、敲一条算式并等回显。 */
export async function terminalRoundTrip(page, id, tag) {
  await page.until(
    `return !!document.querySelector('${nodeAt(id)} .xterm')`,
    "终端挂上 xterm",
    { timeout: 60_000 },
  );
  await page.clickOn(
    `return document.querySelector('${nodeAt(id)} .xterm-screen')`,
    "终端画面",
  );
  await sleep(400);
  await page.type(`echo $((40+2))${tag}`);
  await page.key("Enter");
  await page.until(
    `return (document.querySelector('${nodeAt(id)} .xterm-rows')?.innerText ?? "").includes("42${tag}")`,
    `终端回显 42${tag}`,
    { timeout: 30_000 },
  );
}

/** Electron 渲染页（`attachRenderer` 给的最小页面工具）里开终端并收发。 */
export async function terminalInPage(win, id, tag) {
  await win.until(
    `return !!document.querySelector('${nodeAt(id)} .xterm')`,
    "终端挂上 xterm",
    { timeout: 90_000 },
  );
  // 窗口在后台时 xterm 的输入框拿不到焦点：模拟焦点，再把输入框聚上。
  await win.call("Emulation.setFocusEmulationEnabled", { enabled: true });
  await win.clickOn(
    `return document.querySelector('${nodeAt(id)} .xterm-screen')`,
    "终端画面",
  );
  await win.until(
    `const area = document.querySelector('${nodeAt(id)} .xterm-helper-textarea');
     if (!area) return null;
     area.focus();
     return document.activeElement === area ? true : null;`,
    "终端输入框获得焦点",
    { timeout: 30_000 },
  );
  await win.type(`echo $((40+2))${tag}`);
  await win.enter();
  await win.until(
    `return (document.querySelector('${nodeAt(id)} .xterm-rows')?.innerText ?? "").includes("42${tag}")`,
    `终端回显 42${tag}`,
    { timeout: 30_000 },
  );
}

/* ---------------------------------- Electron ---------------------------------- */

/**
 * 起一个开发构建的 Electron（`apps/desktop/out/main`），它自己起一台 core；数据目录、
 * HOME 与 Chromium profile 都在 `scratch` 下 / 临时目录里（mock 钥匙串、file 后端的
 * SecretStore、不写全局配置）。连上它的渲染页，返回
 * `{ page, data, log(), stop(), stopped, base(), session() }`。
 */
export async function launchElectron({ scratch, tag, extraEnv = {} }) {
  const require = createRequire(join(root, "apps/desktop/package.json"));
  const electronBinary = require("electron");
  if (!existsSync(join(root, "apps/desktop/out/main/index.js")))
    throw new Error("桌面壳未构建：apps/desktop/out/main/index.js");
  const data = join(scratch, `ed-${tag}`);
  mkdirSync(data, { recursive: true });
  const isolated = probeHome(`armadra-${tag}-desktop-`);
  const port = await freePort();
  const app = spawn(
    electronBinary,
    [
      join(root, "apps/desktop"),
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${join(data, "electron")}`,
      "--use-mock-keychain",
    ],
    {
      env: isolatedEnv(isolated, {
        ARMADRA_DATA_DIR: data,
        ARMADRA_DESKTOP_OWNS_RUNTIME: "1",
        ARMADRA_RUNTIME_PORT: String(await freePort()),
        ARMADRA_SECRET_BACKEND: "file",
        ARMADRA_NO_GLOBAL_WRITES: "1",
        ARMADRA_LOG: "info",
        ...extraEnv,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  const take = (chunk) => (log = (log + chunk).slice(-4_000_000));
  app.stdout.on("data", take);
  app.stderr.on("data", take);
  const electron = {
    data,
    log: () => log,
    stopped: false,
    async stop() {
      electron.stopped = true;
      electron.page?.close();
      app.kill("SIGTERM");
      for (let i = 0; i < 50 && app.exitCode === null; i += 1) await sleep(100);
      if (app.exitCode === null) app.kill("SIGKILL");
      isolated.remove();
    },
  };
  try {
    electron.page = await attachRenderer(port, () => log);
    await electron.page.until(
      `return !document.getElementById("splash-root") && document.readyState === "complete"`,
      "桌面页面就绪",
      { timeout: 60_000 },
    );
    electron.httpBase = await electron.page.until(
      `return window.armadra?.transport?.endpointsSync?.()?.httpBase ?? null;`,
      "桌面壳报出 core 地址",
      { timeout: 60_000 },
    );
    electron.session = await probeSession({
      dataDir: data,
      base: electron.httpBase,
    });
  } catch (error) {
    await electron.stop();
    throw error;
  }
  return electron;
}

/** 在 Electron 页面里：点文字匹配的按钮（`selector` 缺省 button）。 */
export const clickText = (win, texts, what, selector) =>
  win.clickOn(
    buttonByText(texts, selector),
    what ?? `点「${[texts].flat()[0]}」`,
  );

/**
 * 让桌面页面认出刚挂上的源：页面经设置页挂源时做的那两件事——壳重读源表（CSP、钉扎、
 * Origin 改写名单）、记下「挂过源」——然后重载。
 */
export async function reloadAfterMount(win) {
  await win.evaluate(`
    await window.armadra.sources.changed();
    localStorage.setItem("armadra.sources.mounted", "1");
    return true;
  `);
  await win.call("Page.reload", {});
  await sleep(1_500);
  await win.until(
    `return !document.getElementById("splash-root") && document.readyState === "complete"`,
    "页面重载完成",
    { timeout: 60_000 },
  );
}

/** `GET <origin>/ca.crt`，不验链（取的就是要钉的那份 CA）；答 PEM。 */
function fetchCaPem(origin) {
  const url = new URL("/ca.crt", origin);
  return new Promise((done, fail) => {
    const request = httpsRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        rejectUnauthorized: false,
        timeout: 10_000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
        response.on("error", fail);
      },
    );
    request.on("timeout", () => request.destroy(new Error("取 CA 超时")));
    request.on("error", fail);
    request.end();
  });
}

/* ------------------------------- 直连的服务器壳 ------------------------------- */

/**
 * `armadra-server serve`（`apps/server/out/main.js`）：回环上的明文监听、临时数据目录与
 * HOME、file 后端的 SecretStore。返回 `{ dataDir, origin, pairLink, session, log(),
 * stop() }`（另有 `fingerprint`：对外证书的 CA 指纹）——`origin` 是对外的 HTTPS（自签）来源，`pairLink` 是启动日志里的配对链接，
 * `session` 是经私有通道在 core 回环 HTTP 上换来的本机主人会话。
 */
export async function startDirectServer({
  scratch,
  tag = "direct",
  extraEnv = {},
}) {
  const entry = join(root, "apps/server/out/main.js");
  if (!existsSync(entry))
    throw new Error(
      `服务器壳未构建：${entry}（pnpm --filter @armadra/server build）`,
    );
  const dataDir = join(scratch, `server-${tag}`);
  mkdirSync(dataDir, { recursive: true });
  const isolated = probeHome(`armadra-${tag}-server-`);
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [entry, "serve", "--data-dir", dataDir, "--listen", `127.0.0.1:${port}`],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: isolatedEnv(isolated, {
        ARMADRA_DATA_DIR: dataDir,
        ARMADRA_SECRET_BACKEND: "file",
        ARMADRA_NO_GLOBAL_WRITES: "1",
        ARMADRA_LOG: "info",
        // out/main.js 把 node-pty 留作外部模块，从桌面包的依赖里找（与
        // server-perf、tools/dev-stack/Dockerfile.dev 同一个做法）；不设时直连源上
        // 开的终端一连就断。
        NODE_PATH: join(root, "apps/desktop/node_modules"),
        ...extraEnv,
      }),
    },
  );
  let log = "";
  const take = (chunk) => (log = (log + chunk).slice(-2_000_000));
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  const server = {
    dataDir,
    log: () => log,
    async stop() {
      child.kill("SIGTERM");
      for (let i = 0; i < 50 && child.exitCode === null; i += 1)
        await sleep(100);
      if (child.exitCode === null) child.kill("SIGKILL");
      isolated.remove();
    },
  };
  try {
    server.pairLink = await until(
      () => {
        if (child.exitCode !== null)
          throw new Error(`服务器壳退出：${log.slice(-2000)}`);
        return /armadra-server pairing (\S+)/.exec(log)?.[1] ?? null;
      },
      "服务器壳的启动日志里有配对链接",
      { timeout: 60_000, every: 200 },
    );
    // 对外的 HTTPS 监听（配对链接指向它）与 core 自己的回环 HTTP（探针、CLI 用）是两个端点。
    server.origin = new URL(server.pairLink).origin;
    server.fingerprint = caFingerprint(await fetchCaPem(server.origin));
    const loopback = await until(
      () => {
        try {
          return JSON.parse(
            readFileSync(join(dataDir, "endpoints.json"), "utf8"),
          ).runtime.http;
        } catch {
          return null;
        }
      },
      "服务器壳写出 endpoints.json",
      { timeout: 30_000, every: 200 },
    );
    server.session = await probeSession({ dataDir, base: loopback });
  } catch (error) {
    await server.stop();
    throw error;
  }
  return server;
}

/**
 * 再起一台不带壳的 core（`apps/desktop/out/core/main.js`，浏览器后端是它自己起的
 * headless Chromium）：临时数据目录与 HOME、file 后端的 SecretStore。答
 * `{ dataDir, origin, session, log(), stop() }`，`session` 经私有通道换来。
 */
export async function startPlainCore({ scratch, tag, extraEnv = {} }) {
  const entry = join(root, "apps/desktop/out/core/main.js");
  if (!existsSync(entry))
    throw new Error(
      `core 未构建：${entry}（pnpm --filter @armadra/desktop build）`,
    );
  const dataDir = join(scratch, `core-${tag}`);
  mkdirSync(dataDir, { recursive: true });
  const isolated = probeHome(`armadra-${tag}-core-`);
  const child = spawn(
    process.execPath,
    [entry, "--listen", "tcp:127.0.0.1:0", "--data-dir", dataDir],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: isolatedEnv(isolated, {
        ARMADRA_DATA_DIR: dataDir,
        ARMADRA_SECRET_BACKEND: "file",
        ARMADRA_NO_GLOBAL_WRITES: "1",
        ARMADRA_LOG: "info",
        ...extraEnv,
      }),
    },
  );
  let log = "";
  const take = (chunk) => (log = (log + chunk).slice(-2_000_000));
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  const core = {
    dataDir,
    log: () => log,
    async stop() {
      child.kill("SIGTERM");
      for (let i = 0; i < 50 && child.exitCode === null; i += 1)
        await sleep(100);
      if (child.exitCode === null) child.kill("SIGKILL");
      // core 关停时保留 tmux 会话：按这台 core 自己的 socket 停掉它的服务器。
      spawnSync("tmux", ["-S", join(dataDir, "tmux.sock"), "kill-server"], {
        stdio: "ignore",
      });
      isolated.remove();
    },
  };
  try {
    core.origin = await until(
      () => {
        if (child.exitCode !== null)
          throw new Error(`core 退出：${log.slice(-2000)}`);
        try {
          return JSON.parse(
            readFileSync(join(dataDir, "endpoints.json"), "utf8"),
          ).runtime.http;
        } catch {
          return null;
        }
      },
      "core 写出 endpoints.json",
      { timeout: 60_000, every: 200 },
    );
    core.session = await probeSession({ dataDir, base: core.origin });
  } catch (error) {
    await core.stop();
    throw error;
  }
  return core;
}

/* ------------------------------- core 的 JSON 调用 ------------------------------- */

/** 本机主人会话上的 `owner`（REST 路径）与 `rpc`（`/api/rpc/<过程>`）两个小调用。 */
export function ownerClient(session) {
  const owner = async (path, init = {}) => {
    const answer = await session.fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
    const text = await answer.text();
    if (!answer.ok)
      throw new Error(
        `${init.method ?? "GET"} ${path} → ${answer.status} ${text.slice(0, 300)}`,
      );
    return text ? JSON.parse(text) : null;
  };
  const rpc = async (procedure, input = {}) => {
    const answer = await owner(`/api/rpc/${procedure.replaceAll(".", "/")}`, {
      method: "POST",
      body: JSON.stringify({ json: input }),
    });
    return answer.json ?? answer;
  };
  return { owner, rpc };
}

/**
 * 在 `owner` 会话指向的 core 上建一个工作空间与它的第一块画布，并整块替换画布文档。
 * `nodesFor(boardId)` 返回要放的节点（`makeNode`）；答 `{ workspace, board, nodes }`。
 */
export async function seedWorkspace(owner, name, rootPath, nodesFor) {
  mkdirSync(rootPath, { recursive: true });
  const workspace = await owner("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({
      name,
      rootPath,
      permissions: { read: true, write: true, execute: true },
    }),
  });
  const boards = await owner(`/api/workspaces/${workspace.id}/boards`);
  const board =
    boards[0] ??
    (await owner(`/api/workspaces/${workspace.id}/boards`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }));
  const nodes = nodesFor(board.id);
  const path = `/api/workspaces/${workspace.id}/boards/${board.id}/document`;
  const document = await owner(path);
  await owner(path, {
    method: "PUT",
    body: JSON.stringify({
      expectedUpdatedAt: document.board.updatedAt,
      nodes,
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      whiteboard: "",
    }),
  });
  return { workspace, board, nodes };
}

/**
 * 在个人中转登记一台 core 并绑定账号：`sources.remoteAdd`（钉指纹）→ 登录中继 →
 * 注册令牌 → `identity.cloud.register` → 等隧道 ready → 断言 → `identity.cloud.bind`。
 * 令牌与访问令牌经 `onSecret(标签, 值)` 交给调用方登记（日志扫描用）。
 *
 * 答 `{ serviceId, sourceId, cloudToken, device, tunnel(), loginOwner(), listed }`。
 */
export async function registerSource({
  relay,
  core,
  label,
  device = { platform: "desktop", name: label },
  onSecret = () => {},
  tunnelTimeoutMs = 30_000,
}) {
  const { owner, rpc } = core;
  const loginOwner = async () => {
    const answer = await relay.must("POST", "/v1/auth/login", {
      body: { account: relay.account, password: relay.password, device },
    });
    return answer.session.accessToken;
  };
  const added = await rpc("sources.remoteAdd", {
    kind: "personal",
    issuer: relay.issuer,
    account: relay.account,
    password: relay.password,
    fingerprint: relay.fingerprint,
  });
  const serviceId = added.remote?.serviceId;
  if (!serviceId) throw new Error("remoteAdd 没有给出 serviceId");
  const cloudToken = onSecret("中继访问令牌", await loginOwner());
  const { registrationToken } = await relay.must(
    "POST",
    "/v1/sources/registration-tokens",
    { body: {}, token: cloudToken },
  );
  onSecret("注册令牌", registrationToken);
  await owner("/api/identity/cloud/register", {
    method: "POST",
    body: JSON.stringify({
      issuer: relay.issuer,
      registrationToken,
      label,
    }),
  });
  const tunnel = async () => {
    const status = await owner("/api/identity/cloud");
    return {
      sourceId: status.sourceId,
      state: status.registrations?.[0]?.tunnel?.state ?? "none",
      count: status.registrations?.length ?? 0,
    };
  };
  const ready = await until(
    async () => {
      const now = await tunnel();
      return now.state === "ready" ? now : null;
    },
    "隧道连上",
    { timeout: tunnelTimeoutMs },
  );
  const sourceId = ready.sourceId;
  const listed = await relay.must("GET", "/v1/me/sources", {
    token: cloudToken,
  });
  const bound = await relay.must("POST", `/v1/sources/${sourceId}/assertion`, {
    body: { device },
    token: cloudToken,
  });
  await owner("/api/identity/cloud/bind", {
    method: "POST",
    body: JSON.stringify({ assertion: bound.assertion }),
  });
  return {
    serviceId,
    sourceId,
    cloudToken,
    device,
    tunnel,
    loginOwner,
    listed,
  };
}

/* --------------------------- 经中继直接对一台源说话 --------------------------- */

/**
 * 像原生客户端那样经中继连一台源（不经页面）：断言 + 中继令牌 → 经中继
 * `cloud/login` 换 core 会话（来源 `https://localhost`）。答
 * `{ base, relayToken, api(method, path, body?), raw(method, path, headers?),
 * protocols(), socket(path, protocols) }`；`raw` 不解析正文，给 `Range` 一类用。
 */
export async function relayedRoute({
  relay,
  cloudToken,
  sourceId,
  device,
  onSecret = () => {},
}) {
  const origin = "https://localhost";
  const access = await relay.must("POST", `/v1/sources/${sourceId}/assertion`, {
    body: { device },
    token: cloudToken,
  });
  const relayToken = onSecret("中继令牌", access.relayToken);
  const base = `/s/${sourceId}`;
  const headers = { origin, "armadra-relay-token": relayToken };
  const login = await relay.must("POST", `${base}/api/identity/cloud/login`, {
    body: { assertion: access.assertion },
    headers,
  });
  const accessToken = onSecret(
    "经中继的 core 会话",
    login.session.native.accessToken,
  );
  const api = (method, path, body) =>
    relay.must(method, `${base}${path}`, {
      body,
      token: accessToken,
      headers,
    });
  const raw = (method, path, extra = {}) =>
    relay.call(method, path, { headers: extra });
  const protocols = async () => {
    const { ticket } = await api("POST", "/api/identity/ws-ticket", {});
    return [`armadra-ticket.${ticket}`, `armadra-relay.${relayToken}`];
  };
  const WebSocketImpl = createRequire(join(root, "apps/desktop/package.json"))(
    "ws",
  );
  const socket = (path, list) =>
    new WebSocketImpl(
      `${relay.issuer.replace(/^http/, "ws")}${base}${path}`,
      list,
      { ca: relay.caPem, servername: "", origin, maxPayload: 64 * 1024 * 1024 },
    );
  return { base, relayToken, api, raw, protocols, socket };
}

/** 等一条 `ws` 连接打开；升级被拒时带上状态码。 */
export function socketOpened(socket) {
  return new Promise((done, fail) => {
    socket.once("open", done);
    socket.once("error", fail);
    socket.once("unexpected-response", (_request, response) =>
      fail(new Error(`升级被拒 ${response.statusCode}`)),
    );
  });
}

/* ------------------------------ 日志里的秘密扫描 ------------------------------ */

/**
 * 探针自己打印的行 + 登记过的秘密：`scan(logs)` 返回泄露清单。V1 与后继探针同一套规则：
 * 口令、令牌、链接秘密一个都不许出现在任何日志里，带片段的 `/j/<id>#…` 也不行。
 */
export function secretLedger() {
  const printed = [];
  for (const name of ["log", "error"]) {
    const original = console[name].bind(console);
    console[name] = (...args) => {
      printed.push(args.map(String).join(" "));
      original(...args);
    };
  }
  const secrets = new Map();
  const secret = (label, value) => {
    if (typeof value === "string" && value.length >= 8)
      secrets.set(value, label);
    return value;
  };
  return {
    secret,
    secrets,
    printed: () => printed.join("\n"),
    scan(logs) {
      const leaks = [];
      for (const [name, text] of Object.entries(logs))
        for (const [value, label] of secrets)
          if (text.includes(value)) leaks.push(`${name} 含 ${label}`);
      for (const [name, text] of Object.entries(logs))
        if (/\/j\/[A-Za-z0-9_-]+#/.test(text))
          leaks.push(`${name} 含带片段的链接`);
      return leaks;
    },
  };
}
