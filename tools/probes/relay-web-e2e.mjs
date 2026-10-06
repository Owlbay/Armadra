// 中继托管页面端到端探针（客户端包 §5，A3-4）。
//
// 真个人中转（armadra-cloud 的 `personal serve`，自签 TLS，`/app/` 托管本仓库的
// `apps/web/dist`）、真 core（登记到中继、隧道连上、中继账号绑定为主人）、新
// profile 的无头 Chrome：
//
//   1. 打开中继的 `/app/`：页面认出自己由中继托管，中继账号口令登录，只有一台
//      在线主机就直接进画布；
//   2. 经中继操作：画布出来、终端收发（`echo $((40+2))relay` → `42relay`）、
//      实时板（本机页面拖一下，中继页面看到；中继页面拖一下，本机看到）；
//   3. 杀掉中继再起：页面自己恢复（`me.stream` 重开 → 主机在线 → 叫醒），之后
//      终端与实时板照常；
//   4. 截图：390 / 1440 宽，明暗两主题（登录页与画布）。
//
// 一切都是临时的、回环的：随机端口、mktemp 出来的数据目录、HOME 与浏览器
// profile，跑完全部删除；core 用 file 后端的 SecretStore，不碰钥匙串。
//
// 用法（仓库根目录）：
//   pnpm libs:build && pnpm --filter @armadra/desktop build && pnpm --filter @armadra/web build
//   ARMADRA_PERSONAL_RELAY_HOME=<armadra-cloud 检出> node tools/probes/relay-web-e2e.mjs [输出目录]
//
// 产物默认在 target/relay-web-e2e/：result.json 与每一步的截图。
import { spawn } from "node:child_process";
import { X509Certificate, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  freePort,
  makeNode,
  root,
  scenario,
  sleep,
  startStack,
  until,
  writeResult,
} from "./ui-features/harness.mjs";
import { probeSession } from "./probe-session.mjs";

const cloudHome = process.env.ARMADRA_PERSONAL_RELAY_HOME?.trim() ?? "";
const output = resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ??
    join(root, "target/relay-web-e2e"),
);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

if (!cloudHome || !existsSync(join(cloudHome, "apps/relay/src/cli.ts"))) {
  console.error("要 ARMADRA_PERSONAL_RELAY_HOME 指到 armadra-cloud 的检出");
  process.exit(2);
}
const webRoot = join(root, "apps/web/dist");
if (!existsSync(join(webRoot, "index.html"))) {
  console.error("先 pnpm --filter @armadra/web build");
  process.exit(2);
}
// 只对这个探针进程：中继是自签的，取 CA 之前没有锚可钉。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const report = { status: "failed", output, scenarios: [] };
let stack;
let relay;
/** 失败时补截图与控制台的页面。 */
const opened = [];

/* --------------------------------- 中继 --------------------------------- */

function startRelay(dataDir, port, passwordFile) {
  const child = spawn(
    process.execPath,
    [
      "apps/relay/src/cli.ts",
      "personal",
      "serve",
      "--data-dir",
      dataDir,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--tls",
      "self-signed",
      "--web-root",
      webRoot,
      "--log-level",
      "warn",
    ],
    {
      cwd: cloudHome,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        RELAY_PERSONAL_ACCOUNT: "dev",
        RELAY_PERSONAL_PASSWORD_FILE: passwordFile,
      },
    },
  );
  let log = "";
  child.stdout.on("data", (chunk) => (log = (log + chunk).slice(-8000)));
  child.stderr.on("data", (chunk) => (log = (log + chunk).slice(-8000)));
  return { child, log: () => log };
}

async function relayCall(issuer, method, path, { body, token } = {}) {
  const answer = await fetch(`${issuer}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await answer.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!answer.ok)
    throw new Error(
      `${method} ${path} → ${answer.status} ${text.slice(0, 200)}`,
    );
  return parsed;
}

async function relayUp(issuer, process_) {
  await until(
    async () => {
      if (process_.child.exitCode !== null)
        throw new Error(`中继退出：${process_.log()}`);
      try {
        return (await relayCall(issuer, "GET", "/.well-known/armadra-platform"))
          ?.webApp;
      } catch {
        return null;
      }
    },
    "个人中转起来",
    { timeout: 30_000 },
  );
}

/* ------------------------------ 页面小工具 ------------------------------ */

const nodeAt = (id) => `.react-flow__node[data-id="${id}"]`;

const positionOf = (page, id) =>
  page.evaluate(`
    const node = document.querySelector('${nodeAt(id)}');
    if (!node) return null;
    const m = /translate\\(([-\\d.]+)px,\\s*([-\\d.]+)px\\)/.exec(node.style.transform);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  `);

async function dragNode(page, id, dx, dy) {
  const from = await page.until(
    `const header = document.querySelector('${nodeAt(id)} [data-slot="node-header"]');
     if (!header) return null;
     const r = header.getBoundingClientRect();
     const point = { x: r.left + 24, y: r.top + r.height / 2 };
     return header.contains(document.elementFromPoint(point.x, point.y)) ? point : null;`,
    `节点 ${id.slice(0, 8)} 的标题栏可以按到`,
  );
  await page.drag(from, { x: from.x + dx, y: from.y + dy }, 14);
}

const waitAt = (page, id, at, what) =>
  page.until(
    `const node = document.querySelector('${nodeAt(id)}');
     const m = /translate\\(([-\\d.]+)px,\\s*([-\\d.]+)px\\)/.exec(node?.style.transform ?? "");
     return m && Math.abs(Number(m[1]) - ${at.x}) < 2 && Math.abs(Number(m[2]) - ${at.y}) < 2;`,
    what,
    { timeout: 30_000 },
  );

async function terminalRoundTrip(page, id, tag) {
  await page.clickOn(
    `return document.querySelector('${nodeAt(id)} .xterm-screen')`,
    "终端画面",
  );
  await sleep(300);
  await page.type(`echo $((40+2))${tag}`);
  await page.key("Enter");
  await page.until(
    `return (document.querySelector('${nodeAt(id)} .xterm-rows')?.innerText ?? "").includes("42${tag}")`,
    `终端回显 42${tag}`,
    { timeout: 30_000 },
  );
}

async function setTheme(page, theme) {
  await page.call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: theme }],
  });
  await page.until(
    `const root = document.documentElement;
     const value = root.dataset.theme ?? (root.classList.contains("dark") ? "dark" : "light");
     return value === ${JSON.stringify(theme)};`,
    `切到${theme === "dark" ? "暗" : "亮"}色`,
    { timeout: 10_000 },
  );
  await sleep(300);
}

/* --------------------------------- 主线 --------------------------------- */

try {
  stack = await startStack({
    log: "warn",
    env: { ARMADRA_SECRET_BACKEND: "file" },
  });
  report.chrome = stack.chrome;
  const run = scenario(report, "中继托管页面（A3-4）", output);

  // 中继
  const relayData = join(stack.scratch, "relay");
  mkdirSync(relayData, { recursive: true, mode: 0o700 });
  const passwordFile = join(stack.scratch, "relay.password");
  const password = randomBytes(18).toString("base64url");
  writeFileSync(passwordFile, password, { mode: 0o600 });
  const relayPort = await freePort();
  const issuer = `https://127.0.0.1:${relayPort}`;
  relay = startRelay(relayData, relayPort, passwordFile);
  await relayUp(issuer, relay);
  const caPem = await (await fetch(`${issuer}/ca.crt`)).text();
  const fingerprint = createHash("sha256")
    .update(new X509Certificate(caPem).raw)
    .digest("hex");
  run.ok("个人中转起来（自签 TLS，/app/ 托管 apps/web/dist）", issuer);

  // core 登记到中继，中继账号绑定为主人：本机主人的会话经私有通道签票配对。
  const session = await probeSession({
    dataDir: stack.data,
    base: stack.origin,
  });
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
  await owner("/api/rpc/sources/remoteAdd", {
    method: "POST",
    body: JSON.stringify({
      json: { kind: "personal", issuer, account: "dev", password, fingerprint },
    }),
  });
  const device = { platform: "desktop", name: "relay-web-e2e" };
  const login = await relayCall(issuer, "POST", "/v1/auth/login", {
    body: { account: "dev", password, device },
  });
  const cloudToken = login.session.accessToken;
  const { registrationToken } = await relayCall(
    issuer,
    "POST",
    "/v1/sources/registration-tokens",
    { body: {}, token: cloudToken },
  );
  await owner("/api/identity/cloud/register", {
    method: "POST",
    body: JSON.stringify({ issuer, registrationToken, label: "e2e-host" }),
  });
  const tunnel = async () => {
    const status = await owner("/api/identity/cloud");
    return {
      sourceId: status.sourceId,
      state: status.registrations?.[0]?.tunnel?.state ?? "none",
    };
  };
  const registered = await until(
    async () => {
      const now = await tunnel();
      return now.state === "ready" ? now : null;
    },
    "隧道连上",
    { timeout: 30_000 },
  );
  const sourceId = registered.sourceId;
  const { assertion } = await relayCall(
    issuer,
    "POST",
    `/v1/sources/${sourceId}/assertion`,
    { body: { device }, token: cloudToken },
  );
  await owner("/api/identity/cloud/bind", {
    method: "POST",
    body: JSON.stringify({ assertion }),
  });
  run.ok("core 登记、隧道 ready、中继账号绑定为主人", sourceId);

  // 工作空间、画布：一张便签、一个终端
  const project = join(stack.scratch, "relay-project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# relay\n");
  const { workspace, board } = await stack.workspace("经中继", project);
  const sticky = makeNode(
    board.id,
    "sticky",
    "便签",
    { x: 120, y: 120 },
    { width: 240, height: 150 },
    { kind: "sticky", content: "经中继同步" },
  );
  const terminal = makeNode(
    board.id,
    "terminal",
    "终端",
    { x: 420, y: 120 },
    { width: 520, height: 300 },
    { kind: "terminal", cwd: project },
  );
  await stack.seedBoard(workspace.id, board.id, [sticky, terminal]);
  const query = `?workspace=${workspace.id}&board=${board.id}`;

  /* --------------------------- 1. 登录与进画布 --------------------------- */
  await stack.browser.call("Security.setIgnoreCertificateErrors", {
    ignore: true,
  });
  const page = await stack.browser.page(await stack.browser.context());
  opened.push(["relay", page]);
  const sockets = [];
  const frames = [];
  report.relaySockets = sockets;
  stack.browser.on((message) => {
    if (message.sessionId !== page.sessionId) return;
    const { method, params } = message;
    if (
      method === "Network.responseReceived" &&
      /\/(api|v1)\//.test(params.response.url)
    )
      sockets.push({
        http: params.response.status,
        url: params.response.url.replace(/^https?:\/\/[^/]+/, "").slice(0, 120),
      });
    else if (method === "Network.loadingFailed")
      sockets.push({
        failed: params.errorText,
        blocked: params.blockedReason,
        id: params.requestId,
      });
    else if (
      method === "Network.requestWillBeSent" &&
      /\/(api|v1)\//.test(params.request.url)
    )
      sockets.push({
        sent: params.request.method,
        url: params.request.url.replace(/^https?:\/\/[^/]+/, "").slice(0, 120),
        id: params.requestId,
      });
    else if (method === "Network.webSocketCreated")
      sockets.push({
        id: params.requestId,
        url: params.url.replace(/^wss?:\/\/[^/]+/, ""),
      });
    else if (method === "Network.webSocketHandshakeResponseReceived") {
      const entry = sockets.find((item) => item.id === params.requestId);
      if (entry) entry.status = params.response.status;
    } else if (method === "Network.webSocketFrameReceived") {
      frames.push({
        id: params.requestId,
        data: String(params.response.payloadData ?? "").slice(0, 400),
      });
      if (frames.length > 2000) frames.shift();
    } else if (method === "Network.webSocketClosed") {
      const entry = sockets.find((item) => item.id === params.requestId);
      if (entry) entry.closed = true;
    } else if (method === "Network.webSocketFrameError") {
      const entry = sockets.find((item) => item.id === params.requestId);
      if (entry) entry.error = params.errorMessage;
    }
  });
  await page.call("Network.enable");
  // 中继给页面的 CSP 只许同源：页面里不该有任何跨源连接被拦。
  page.allowed.push(/WebSocket connection to .* failed/);
  await page.goto(`${issuer}/app/${query}`);
  await page.settle();
  await setTheme(page, "dark");
  await page.until(
    `return !!document.querySelector('[data-slot="relay-sign-in"]')`,
    "中继登录页",
  );
  const signInText = await page.evaluate(
    `return document.querySelector('[data-slot="relay-sign-in"]').innerText;`,
  );
  run.check(
    signInText.includes("登录个人中转") &&
      signInText.includes(`127.0.0.1:${relayPort}`),
    "页面认出自己由中继托管：登录页写着中转的地址",
  );
  await run.shot(page, "01-sign-in-1440-dark");
  await setTheme(page, "light");
  await run.shot(page, "01-sign-in-1440-light");
  await page.viewport(390, 844, true);
  await sleep(300);
  await run.shot(page, "01-sign-in-390-light");
  await setTheme(page, "dark");
  await run.shot(page, "01-sign-in-390-dark");
  await page.viewport(1440, 900);
  await setTheme(page, "light");

  await page.clickOn(
    `return document.querySelector('[data-slot="relay-sign-in"] input[autocomplete="username"]')`,
    "账号框",
  );
  await page.type("dev");
  await page.clickOn(
    `return document.querySelector('[data-slot="relay-sign-in"] input[type="password"]')`,
    "口令框",
  );
  await page.type(password);
  await page.key("Enter");
  await page.until(
    `return !!document.querySelector('${nodeAt(sticky.id)}')`,
    "经中继进画布、便签出现",
    { timeout: 45_000 },
  );
  run.ok("中继账号登录后直接进画布（只有一台在线主机）");
  const traffic = await page.evaluate(`
    return performance.getEntriesByType("resource")
      .map((entry) => new URL(entry.name))
      .filter((url) => url.pathname.startsWith("/s/") || url.pathname.startsWith("/v1/"))
      .map((url) => url.origin);
  `);
  run.check(
    traffic.length > 0 && traffic.every((origin) => origin === issuer),
    "请求都发往中继自己（/v1 与 /s/<源>，同源）",
    { requests: traffic.length },
  );

  /* ----------------------------- 2. 经中继操作 ---------------------------- */
  await page.until(
    `return !!document.querySelector('${nodeAt(terminal.id)} .xterm')`,
    "终端挂上 xterm",
    { timeout: 30_000 },
  );
  await terminalRoundTrip(page, terminal.id, "relay");
  run.ok("经中继开终端、收发数据");

  const local = await stack.browser.page(await stack.browser.context());
  opened.push(["local", local]);
  await local.goto(stack.boardUrl(workspace.id, board.id));
  await local.settle();
  await local.until(
    `return !!document.querySelector('${nodeAt(sticky.id)}')`,
    "本机页面渲染出画布",
    { timeout: 30_000 },
  );
  await local.until(
    `const bar = document.querySelector('[data-slot="presence-bar"][data-mode="realtime"]');
     return bar && bar.querySelectorAll('[data-peer]').length >= 1;`,
    "本机页面的在线条列出中继页面",
    { timeout: 30_000 },
  );
  await dragNode(local, sticky.id, 0, 140);
  const moved = await positionOf(local, sticky.id);
  await waitAt(page, sticky.id, moved, "中继页面看到本机拖的便签");
  await dragNode(page, sticky.id, 160, 0);
  const movedBack = await positionOf(page, sticky.id);
  await waitAt(local, sticky.id, movedBack, "本机页面看到中继页面拖的便签");
  run.ok("实时板经中继双向同步", { moved, movedBack });

  await run.shot(page, "02-canvas-1440-light");
  await setTheme(page, "dark");
  await run.shot(page, "02-canvas-1440-dark");
  await page.viewport(390, 844, true);
  await sleep(800);
  // 窄屏进来侧栏抽屉是开着的：收起来看画布。
  await page.key("Escape");
  await sleep(500);
  await run.shot(page, "02-canvas-390-dark");
  await setTheme(page, "light");
  await run.shot(page, "02-canvas-390-light");
  await page.viewport(1440, 900);
  await sleep(500);

  /**
   * 控制面的事件订阅续上：最新那条 `/api/ws` 上收到本机拖动物化出的
   * `board.changed`（订阅重订、按 lastEventId 续上）。
   */
  const controlResumed = (when) => {
    const latest = sockets
      .filter((item) => item.url?.endsWith("/api/ws"))
      .at(-1)?.id;
    return until(
      () =>
        latest !== undefined &&
        frames.some(
          (frame) =>
            frame.id === latest && frame.data.includes("board.changed"),
        )
          ? true
          : null,
      `${when}控制面收到 board.changed（事件订阅续上）`,
      { timeout: 30_000 },
    );
  };

  /* ------------------------ 3. 主机下线再上线 ------------------------ */
  // 主机这一侧停掉隧道：中继答源离线（4404 / 503），me.stream 推 sourceOffline；
  // 再开：sourceOnline 叫醒页面。
  await owner("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({ cloud: { relay: { enabled: false } } }),
  });
  await page.until(
    `return [...document.querySelectorAll('[data-slot="banner"]')].some((b) => b.innerText.includes("等待上线"))`,
    "主机下线：通知条「等待上线」",
    { timeout: 30_000 },
  );
  await run.shot(page, "03-waiting-for-host-1440");
  const offlineAt = Date.now();
  await owner("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({ cloud: { relay: { enabled: true } } }),
  });
  await page.until(
    `return ![...document.querySelectorAll('[data-slot="banner"]')].some((b) => b.innerText.includes("等待上线"))`,
    "主机上线：通知条收起",
    { timeout: 60_000 },
  );
  await terminalRoundTrip(page, terminal.id, "online");
  await dragNode(local, sticky.id, 60, 0);
  const afterOnline = await positionOf(local, sticky.id);
  await waitAt(
    page,
    sticky.id,
    afterOnline,
    "主机上线后中继页面又看到本机的拖动",
  );
  await controlResumed("主机上线后");
  run.ok(
    "主机下线 → 等待上线；上线 → me.stream 叫醒，终端、实时板、控制面事件照常",
    {
      backMs: Date.now() - offlineAt,
    },
  );

  /* ---------------------------- 3. 中继重启 ---------------------------- */
  relay.child.kill("SIGTERM");
  await new Promise((done) => relay.child.once("exit", done));
  await page.until(
    `return [...document.querySelectorAll('[data-slot="banner"]')].some((b) => b.innerText.trim() !== "")`,
    "中继停了，页面出现通知条",
    { timeout: 30_000 },
  );
  await run.shot(page, "04-relay-down-1440");
  const downAt = Date.now();
  await sleep(2_000);
  relay = startRelay(relayData, relayPort, passwordFile);
  await relayUp(issuer, relay);
  await until(
    async () => ((await tunnel()).state === "ready" ? true : null),
    "隧道重连",
    { timeout: 60_000 },
  );
  const tunnelBackMs = Date.now() - downAt;
  // 页面恢复：实时板与终端都回来了。
  await dragNode(local, sticky.id, 0, -100);
  const again = await positionOf(local, sticky.id);
  await waitAt(page, sticky.id, again, "中继重启后中继页面又看到本机的拖动");
  await terminalRoundTrip(page, terminal.id, "again");
  const recoveredMs = Date.now() - downAt;
  await page.until(
    `return ![...document.querySelectorAll('[data-slot="banner"]')].some((b) => /等待上线|断开/.test(b.innerText))`,
    "通知条收起",
    { timeout: 30_000 },
  );
  await controlResumed("中继重启后");
  run.ok("杀掉中继再起：页面不刷新自己恢复（实时板、终端、控制面事件）", {
    tunnelBackMs,
    recoveredMs,
  });
  await run.shot(page, "05-recovered-1440");

  const problems = page.unexpected();
  report.consoleProblems = problems;
  run.ok("控制台（中继页面）", problems.length === 0 ? "无错误" : problems);
  run.entry.status = "ok";
  report.status = "ok";
} catch (error) {
  report.error =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`  FAIL  ${report.error}`);
  if (relay) report.relayLog = relay.log().slice(-3000);
  for (const [name, opened_] of opened) {
    try {
      await opened_.capture(join(output, `zz-failure-${name}.png`));
      report[`${name}Console`] = opened_.consoleLines.slice(-60);
      report[`${name}Text`] = await opened_.evaluate(
        "return document.body.innerText.slice(0, 2000)",
      );
      report[`${name}Requests`] = await opened_.evaluate(
        `return [location.href, ...performance.getEntriesByType("resource").map((e) => e.name.replace(/^https?:\\/\\/[^/]+/, "")).filter((n) => !n.includes("/assets/")).slice(-40)]`,
      );
    } catch {
      /* 页面已经关了：没有可补的。 */
    }
  }
  if (stack) report.coreLog = stack.coreLog().slice(-3000);
} finally {
  try {
    relay?.child.kill("SIGKILL");
  } catch {
    /* 已经退出。 */
  }
  await stack?.stop();
  writeResult(output, report);
  console.log(`  报告  ${join(output, "result.json")}`);
  process.exit(report.status === "ok" ? 0 : 1);
}
