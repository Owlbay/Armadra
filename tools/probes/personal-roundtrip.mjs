// 个人中转全流程探针（平台计划 V1，里程碑 M1 的验收探针，A 档）。
//
// 真个人中转（armadra-cloud 的 `personal init` + `personal serve`，自签 TLS，`/app/`
// 与 `/j/` 托管本仓库的 `apps/web/dist`）、真 core、真 Electron、无头 Chrome，没有
// 模拟的服务端。七步，每步都有断言：
//
//   1. 中继 init：状态目录、CA 指纹、口令不进输出；serve 起来，`/.well-known` 答 personal；
//   2. core 登记：注册令牌 → `identity.cloud.register` → 隧道 ready，中继目录里有这台源，
//      中继账号绑定为主人；错口令被拒；
//   3. 浏览器开中继托管的 `/app/`：账号口令登录 → 进画布 → 终端收发 → 实时板与本机页面双向同步；
//   4. 分享链接：`/j/<id>#…` 落地、片段被抹掉、访客加入、打开链接指向的工作空间、开终端；
//   5. 桌面 Electron 粘贴链接挂载（核对指纹）、打开工作空间、开终端；
//   6. 手机：390 宽模拟（页面来源是拦截出来的 `https://localhost`，扫码结果注入）扫码挂载、开终端；
//   7. 撤销链接：accept 与落地页报错，已加入的访客被断开；撤销登记：隧道停、core 用远程
//      服务会话一并删掉中继侧的源记录（契约 §31.4）、经中继被拒、主人页面等待上线、断言被拒。
//
// 全程：随机端口、临时数据目录与 HOME、file 后端的 SecretStore，不碰钥匙串与操作员配置。
// 最后扫一遍中继、core、Electron 与探针自己的输出，口令、令牌、链接秘密一个都不许出现。
//
// 中继来自 armadra-cloud 的本地检出（`tools/probes/cloud-source.mjs`：
// ARMADRA_DEV_STACK_CLOUD_SRC，或仓库旁的 ../armadra-cloud）；没有检出时退出码 2，
// e2e 清单里依赖 `cloud` 的条目在 CI 上记为 skipped。
//
// 用法（仓库根目录）：
//   pnpm libs:build && pnpm --filter @armadra/desktop build && pnpm --filter @armadra/web build
//   node tools/ci/e2e.mjs --only personal-roundtrip
//   node tools/probes/personal-roundtrip.mjs [输出目录]
//
// 产物默认在 target/personal-roundtrip/：result.json、每一步的截图与失败时的现场。
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { extname, join, resolve } from "node:path";

import { CLOUD_ENTRY, findCloudSource } from "./cloud-source.mjs";
import {
  buttonByText,
  buttonExists,
  caFingerprint,
  clickText,
  hasText,
  launchElectron,
  nodeAt,
  ownerClient,
  registerSource,
  relayClient,
  secretLedger,
  spawnRelay as spawnRelayIn,
  terminalInPage,
  terminalRoundTrip,
} from "./platform-lib.mjs";
import { probeSession } from "./probe-session.mjs";
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

const output = resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ??
    join(root, "target/personal-roundtrip"),
);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const cloudHome = findCloudSource();
if (!cloudHome) {
  console.error(
    `没有 armadra-cloud 的本地检出（${CLOUD_ENTRY}）：设 ARMADRA_DEV_STACK_CLOUD_SRC 或放在仓库旁的 ../armadra-cloud`,
  );
  process.exit(2);
}
const webRoot = join(root, "apps/web/dist");
if (!existsSync(join(webRoot, "index.html"))) {
  console.error("先 pnpm --filter @armadra/web build");
  process.exit(2);
}
if (process.platform === "win32") {
  console.error("探针要私有通道（core-control.sock），Windows 上不跑");
  process.exit(2);
}
// 探针自己对中继的调用都带钉住的 CA（见 `platform-lib.mjs` 的 `relayRaw`）；不放宽进程的 TLS 校验，也不让
// 它漏进子进程。
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

const report = { status: "failed", output, scenarios: [], timings: {} };
const started = Date.now();
let stack;
let relay;
let electron;
const opened = [];

/** 探针自己打印的行与登记过的秘密：最后和各进程日志一起扫。 */
const ledger = secretLedger();
const { secret } = ledger;

/** 中继边缘按 IP 限流的窗口（`edge.connect.ip`：200 次 / 60 秒），留一点余量。 */
const RATE_WINDOW_MS = 62_000;

const timed = async (name, work) => {
  const at = Date.now();
  try {
    return await work();
  } finally {
    report.timings[name] = Date.now() - at;
  }
};

const spawnRelay = (args, env) => spawnRelayIn(cloudHome, args, env);

/* ------------------------------ 页面小工具 ------------------------------ */

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

/* --------------------------------- 主线 --------------------------------- */

try {
  stack = await startStack({
    log: "info",
    env: { ARMADRA_SECRET_BACKEND: "file" },
    // 手机模拟的页面来源是拦截出来的 https://localhost，Chrome 把它当公网页面，访问
    // 回环上的中继会被本地网络访问检查拦下；原生 WebView 没有这一层。
    chromeArgs: ["--disable-features=LocalNetworkAccessChecks"],
  });
  report.chrome = stack.chrome;
  const run = scenario(report, "个人中转全流程（V1 / M1）", output);
  const shotAt = (page, name) => run.shot(page, name);

  /* ------------------------------ 1. 中继 init ------------------------------ */
  const relayData = join(stack.scratch, "relay");
  const passwordFile = join(stack.scratch, "relay.password");
  const password = secret("中继口令", randomBytes(18).toString("base64url"));
  writeFileSync(passwordFile, password, { mode: 0o600 });
  const relayPort = await freePort();
  const issuer = `https://127.0.0.1:${relayPort}`;

  const initOutput = await timed("1-init", async () => {
    const init = spawnRelay([
      "init",
      "--data-dir",
      relayData,
      "--account",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      String(relayPort),
      "--tls",
      "self-signed",
      "--password-file",
      passwordFile,
    ]);
    const code = await new Promise((done) => init.child.once("exit", done));
    return { code, text: init.log() };
  });
  run.check(initOutput.code === 0, "personal init 退出码 0", initOutput.text);
  const initFingerprint = /CA 指纹：([0-9a-f]{64})/.exec(initOutput.text)?.[1];
  run.check(
    initOutput.text.includes("账号：dev") &&
      initOutput.text.includes(`对外地址：${issuer}`) &&
      initFingerprint,
    "init 输出账号、对外地址与 64 位 CA 指纹",
  );
  run.check(!initOutput.text.includes(password), "init 的输出里没有口令");
  run.check(
    existsSync(join(relayData, "state.json")) &&
      existsSync(join(relayData, "tls", "ca.crt")),
    "状态目录里有 state.json 与自签 CA",
  );
  const reinit = spawnRelay([
    "init",
    "--data-dir",
    relayData,
    "--account",
    "dev",
    "--host",
    "127.0.0.1",
    "--port",
    String(relayPort),
    "--tls",
    "self-signed",
    "--password-file",
    passwordFile,
  ]);
  run.check(
    (await new Promise((done) => reinit.child.once("exit", done))) !== 0,
    "已初始化的目录再 init 被拒，不覆盖",
  );

  const caPem = readFileSync(join(relayData, "tls", "ca.crt"), "utf8");
  const fingerprint = caFingerprint(caPem);
  run.check(
    fingerprint === initFingerprint,
    "磁盘上的 CA 指纹与 init 打印的一致",
  );
  const { call, must } = relayClient(issuer, caPem);

  const startServe = () => {
    const serve = spawnRelay([
      "serve",
      "--data-dir",
      relayData,
      "--host",
      "127.0.0.1",
      "--port",
      String(relayPort),
      "--tls",
      "self-signed",
      "--web-root",
      webRoot,
      "--log-level",
      "info",
    ]);
    return serve;
  };
  relay = startServe();
  const info = await until(
    async () => {
      if (relay.child.exitCode !== null)
        throw new Error(`中继退出：${relay.log()}`);
      try {
        const answer = await call("GET", "/.well-known/armadra-platform");
        return answer.status === 200 ? answer.body : null;
      } catch {
        return null;
      }
    },
    "个人中转起来",
    { timeout: 30_000 },
  );
  run.check(
    info.mode === "personal" && info.webApp === `${issuer}/app/`,
    "serve 起来：/.well-known 答 personal、webApp 指向 /app/",
    { mode: info.mode, webApp: info.webApp },
  );
  const served = await call("GET", "/app/");
  run.check(
    served.status === 200 && String(served.body).includes('<div id="root"'),
    "/app/ 托管 apps/web 的构建产物",
    served.status,
  );
  const wrong = await call("POST", "/v1/auth/login", {
    body: {
      account: "dev",
      password: "not-the-password-0",
      device: { platform: "desktop", name: "probe-wrong" },
    },
  });
  run.check(wrong.status === 401 || wrong.status === 400, "错口令登录被拒", {
    status: wrong.status,
    code: wrong.body?.code,
  });

  /* ------------------------------ 2. core 登记 ------------------------------ */
  const session = await probeSession({
    dataDir: stack.data,
    base: stack.origin,
  });
  secret("core 本机主人会话", session.headers.authorization.slice(7));
  const { owner, rpc } = ownerClient(session);

  const registered = await timed("2-tunnel", () =>
    registerSource({
      relay: { issuer, fingerprint, account: "dev", password, must },
      core: { owner, rpc },
      label: "roundtrip-host",
      device: { platform: "desktop", name: "personal-roundtrip" },
      onSecret: secret,
    }),
  );
  const { device, serviceId, sourceId, cloudToken } = registered;
  const tunnel = registered.tunnel;
  const loginOwner = async () =>
    secret("中继访问令牌", await registered.loginOwner());
  run.check(
    serviceId,
    "core 把个人中转登记为远程服务（钉 CA 指纹）",
    serviceId,
  );
  run.ok("core 登记、隧道 ready", sourceId);
  const sourceRow = (registered.listed.sources ?? registered.listed).find(
    (row) => row.sourceId === sourceId,
  );
  run.check(
    sourceRow && sourceRow.online !== false,
    "中继目录里有这台源且在线",
    sourceRow && { name: sourceRow.name, online: sourceRow.online },
  );
  run.ok("中继账号绑定为这台 core 的主人");

  // 主人的画布：一张便签、一个终端。
  const ownerProject = join(stack.scratch, "owner-project");
  mkdirSync(ownerProject, { recursive: true });
  writeFileSync(join(ownerProject, "README.md"), "# roundtrip\n");
  const { workspace, board } = await stack.workspace("个人中转", ownerProject);
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
    { kind: "terminal", cwd: ownerProject },
  );
  await stack.seedBoard(workspace.id, board.id, [sticky, terminal]);
  const query = `?workspace=${workspace.id}&board=${board.id}`;

  await stack.browser.call("Security.setIgnoreCertificateErrors", {
    ignore: true,
  });
  const newPage = async (width = 1440, height = 900, mobile = false) => {
    const page = await stack.browser.page(await stack.browser.context());
    opened.push([`page-${opened.length}`, page]);
    if (width !== 1440) await page.viewport(width, height, mobile);
    // 中继给页面的 CSP 只许同源：页面里不该有任何跨源连接被拦。
    page.allowed.push(/WebSocket connection to .* failed/);
    return page;
  };

  /* ---------------------- 3. 浏览器：/app/ 登录、画布 ---------------------- */
  const page = await newPage();
  await timed("3-app", async () => {
    await page.goto(`${issuer}/app/${query}`);
    await page.settle();
    await page.until(
      `return !!document.querySelector('[data-slot="relay-sign-in"]')`,
      "中继登录页",
    );
    const signInText = await page.evaluate(
      `return document.querySelector('[data-slot="relay-sign-in"]').innerText;`,
    );
    run.check(
      signInText.includes(`127.0.0.1:${relayPort}`),
      "/app/ 认出自己由中继托管：登录页写着中转的地址",
    );
    await shotAt(page, "03-sign-in-1440");
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
      "账号口令登录后进画布、便签出现",
      { timeout: 45_000 },
    );
    run.ok("账号口令登录后直接进画布");
    const origins = await page.evaluate(`
      return performance.getEntriesByType("resource")
        .map((entry) => new URL(entry.name))
        .filter((url) => url.pathname.startsWith("/s/") || url.pathname.startsWith("/v1/"))
        .map((url) => url.origin);
    `);
    run.check(
      origins.length > 0 && origins.every((origin) => origin === issuer),
      "请求都发往中继自己（/v1 与 /s/<源>，同源）",
      { requests: origins.length },
    );
    await terminalRoundTrip(page, terminal.id, "relay");
    run.ok("经中继开终端并收发（42relay）");

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
    await shotAt(page, "03-canvas-1440");
    await local.close();
  });

  /* --------------------------- 分享链接的小工具 --------------------------- */
  let relayToken = { value: cloudToken, at: Date.now() };
  const ownerToken = async () => {
    if (Date.now() - relayToken.at > 8 * 60_000)
      relayToken = { value: await loginOwner(), at: Date.now() };
    return relayToken.value;
  };
  let shares = 0;
  /** 每条链接一个自己的工作空间与终端：几个访客不抢同一个终端的输入。 */
  const newShare = async (name, ttlMs = 86_400_000) => {
    shares += 1;
    const dir = join(stack.scratch, `share-${shares}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), `# ${name}\n`);
    const made = await stack.workspace(name, dir);
    const shell = makeNode(
      made.board.id,
      "terminal",
      "终端",
      { x: 120, y: 120 },
      { width: 520, height: 300 },
      { kind: "terminal", cwd: dir },
    );
    await stack.seedBoard(made.workspace.id, made.board.id, [shell]);
    const invitation = await owner("/api/identity/invitations", {
      method: "POST",
      body: JSON.stringify({
        role: "operator",
        targetWorkspaceId: made.workspace.id,
        ttlMs,
      }),
    });
    secret("邀请令牌", invitation.token);
    const link = await must("POST", "/v1/links", {
      token: await ownerToken(),
      body: {
        kind: "source_invite",
        sourceId,
        invitationId: invitation.invitationId,
        label: name,
        role: "operator",
        expiresAtMs: Math.min(invitation.expiresAtMs, Date.now() + ttlMs),
      },
    });
    secret("链接秘密", link.secret);
    return {
      name,
      url: `${link.url}#${link.secret}.${invitation.token}`,
      linkId: link.linkId,
      invitationId: invitation.invitationId,
      secret: link.secret,
      terminal: shell,
      workspace: made.workspace,
    };
  };
  const revokeLink = async (linkId) =>
    call("DELETE", `/v1/links/${linkId}`, { token: await ownerToken() });
  const acceptLink = (share) =>
    call("POST", `/v1/links/${share.linkId}/accept`, {
      body: {
        secret: share.secret,
        device: { platform: "browser", name: "probe-accept" },
      },
    });

  /* ------------------------ 4. 分享链接：浏览器访客 ------------------------ */
  const browserShare = await newShare("guest-browser");
  const guest = await newPage();
  await timed("4-guest", async () => {
    await guest.goto(browserShare.url);
    await guest.settle();
    await guest.until(buttonExists("加入"), "落地页的「加入」按钮");
    const landing = await guest.evaluate(`return document.body.innerText;`);
    run.check(
      landing.includes(browserShare.name) || landing.includes("roundtrip-host"),
      "/j/ 落地页显示分享的源",
    );
    const hash = await guest.evaluate(`return location.hash;`);
    run.check(
      !hash.includes(browserShare.secret) && !hash.includes("."),
      "落地页把片段（秘密与邀请令牌）从地址栏抹掉",
      hash,
    );
    await shotAt(guest, "04-join-landing-1440");
    await guest.clickOn(buttonByText("加入"), "加入");
    await guest.until(
      `return location.pathname === "/app/" ? true : null;`,
      "加入后地址换成 /app/",
      { timeout: 45_000 },
    );
    run.ok("访客加入：地址换成 /app/");
    await terminalRoundTrip(guest, browserShare.terminal.id, "guest");
    run.ok("访客自动打开链接指向的工作空间、开终端并收发（42guest）");
    await shotAt(guest, "04-guest-canvas-1440");
    const invitations = await owner("/api/identity/invitations");
    const row = (invitations.invitations ?? invitations).find(
      (item) => item.invitationId === browserShare.invitationId,
    );
    run.check(row, "core 的邀请列表里有这条邀请");
    run.check(
      Number(row.uses) === 1 && row.consumedAtMs > 0,
      "访客兑换后一次性邀请计一次（uses 加一、记消费时间）",
      { uses: row.uses, consumedAtMs: row.consumedAtMs },
    );
  });

  /* --------------------------- 5. 桌面 Electron --------------------------- */
  const desktopShare = await newShare("guest-desktop");
  await timed("5-desktop", async () => {
    electron = await launchElectron({
      scratch: stack.scratch,
      tag: "roundtrip",
    });
    const win = electron.page;
    const click = (texts, what, selector) =>
      clickText(win, texts, what, selector);
    const fill = (selector, value) =>
      win.until(
        `const el = document.querySelector(${JSON.stringify(selector)});
         if (!el) return null;
         el.focus();
         Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
         el.dispatchEvent(new Event("input", { bubbles: true }));
         return true;`,
        `填 ${selector}`,
      );
    // 粘贴链接：设置 → 远程服务 → 通过链接加入。
    await click(["设置", "Settings"], "设置");
    await click(
      ["远程服务", "Remote services"],
      "远程服务",
      "button, a, [role=tab], [role=link]",
    );
    await click(["通过链接加入", "Join by link"], "通过链接加入");
    await fill("#join-link", desktopShare.url);
    await win.capture(join(output, "05-desktop-pasted.png"));
    await click(["加入", "Join"], "加入");
    await win.until(
      `return document.body.innerText.includes("核对证书指纹") ? true : null;`,
      "核对签发方指纹",
      { timeout: 30_000 },
    );
    const shown = await win.evaluate(
      `return document.querySelector('[data-slot="fingerprint"]')?.innerText.toLowerCase().replace(/[^0-9a-f]/g, "") ?? "";`,
    );
    run.check(shown === fingerprint, "桌面首次挂载核对的指纹与中继 CA 一致");
    await win.capture(join(output, "05-desktop-fingerprint.png"));
    await click(
      ["指纹一致，继续", "Fingerprint matches, continue"],
      "确认指纹",
    );
    // 挂载 → 壳放行新来源后重载 → 自动打开链接指向的工作空间。
    await terminalInPage(win, desktopShare.terminal.id, "desktop");
    run.ok("桌面粘贴链接挂载、打开工作空间、开终端并收发（42desktop）");
    await win.capture(join(output, "05-desktop-terminal.png"));
    const sourcesAnswer = await electron.session.fetch("/api/sources");
    const sources = await sourcesAnswer.json();
    const mounted = (sources.sources ?? []).find(
      (row) => row.sourceId === sourceId,
    );
    run.check(
      mounted?.kind === "relayed",
      "桌面 core 的源表里有经中继挂载的源（relayed）",
      mounted && { kind: mounted.kind },
    );
    run.check(
      win.problems.length === 0,
      "桌面页面无异常",
      win.problems.slice(0, 5),
    );
    await electron.stop();
  });

  /* ------------------------- 6. 手机：390 宽、扫码 ------------------------- */
  // 中继边缘对每个来源 IP 每分钟只放 200 次（预检、请求、升级共用，写死在中继里），而
  // 这里所有客户端都来自回环、共用一个额度；手机页面启动时一口气发出几十个请求，
  // 前面几步刚用掉的额度要等窗口过去。
  const mobileShare = await newShare("guest-mobile");
  await sleep(RATE_WINDOW_MS);
  await timed("6-mobile", async () => {
    const mobile = await newPage(390, 844, true);
    const fake = `
      (function(){
        const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
        const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));
        try { localStorage.setItem("armadra.locale", "zh-CN"); } catch {}
        window.Capacitor = {
          isNativePlatform: () => true,
          Plugins: { ArmadraNative: {
            getSessions: async () => ({ sessions: read("fake.sessions", []) }),
            setSession: async ({ session }) => { const all = read("fake.sessions", []).filter((s) => !(s.sourceId === session.sourceId && s.via === session.via)); all.push(session); write("fake.sessions", all); },
            removeSession: async ({ sourceId }) => write("fake.sessions", read("fake.sessions", []).filter((s) => s.sourceId !== sourceId)),
            getRemotes: async () => ({ remotes: read("fake.remotes", []) }),
            setRemote: async ({ remote }) => { const all = read("fake.remotes", []).filter((r) => r.serviceId !== remote.serviceId); all.push(remote); write("fake.remotes", all); },
            removeRemote: async ({ serviceId }) => write("fake.remotes", read("fake.remotes", []).filter((r) => r.serviceId !== serviceId)),
            peek: async ({ origin }) => ({ fingerprint: ${JSON.stringify(fingerprint)}, trusted: false, pinned: read("fake.pins", []).includes(origin) }),
            pin: async ({ origin, fingerprint }) => { if (fingerprint !== ${JSON.stringify(fingerprint)}) throw new Error("mismatch"); write("fake.pins", [...read("fake.pins", []), origin]); },
            scan: async () => ({ text: localStorage.getItem("fake.scan") ?? "" }),
          } },
        };
      })();`;
    await mobile.call("Page.addScriptToEvaluateOnNewDocument", {
      source: fake,
    });
    // 页面来源是原生 App 的 https://localhost：从构建产物应答，其余请求照常发出。
    await mobile.call("Fetch.enable", {
      patterns: [{ urlPattern: "https://localhost/*" }],
    });
    const types = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".json": "application/json",
      ".woff2": "font/woff2",
      ".wasm": "application/wasm",
    };
    stack.browser.on(async (message) => {
      if (
        message.sessionId !== mobile.sessionId ||
        message.method !== "Fetch.requestPaused"
      )
        return;
      const url = new URL(message.params.request.url);
      let file = join(webRoot, decodeURIComponent(url.pathname));
      if (
        !file.startsWith(webRoot) ||
        !existsSync(file) ||
        url.pathname === "/"
      )
        file = join(webRoot, "index.html");
      await stack.browser
        .call(
          "Fetch.fulfillRequest",
          {
            requestId: message.params.requestId,
            responseCode: 200,
            responseHeaders: [
              {
                name: "content-type",
                value: types[extname(file)] ?? "application/octet-stream",
              },
            ],
            body: readFileSync(file).toString("base64"),
          },
          mobile.sessionId,
        )
        .catch(() => undefined);
    });
    await mobile.call("Network.enable");
    const netUrls = new Map();
    report.mobileNet = [];
    stack.browser.on((message) => {
      if (message.sessionId !== mobile.sessionId) return;
      const { method, params } = message;
      if (
        method === "Network.requestWillBeSent" &&
        !params.request.url.startsWith("https://localhost")
      )
        netUrls.set(
          params.requestId,
          `${params.request.method} ${params.request.url.replace(/^https:\/\/127\.0\.0\.1:\d+/, "")}`.slice(
            0,
            140,
          ),
        );
      else if (
        method === "Network.loadingFailed" &&
        netUrls.has(params.requestId)
      )
        report.mobileNet.push({
          failed: netUrls.get(params.requestId),
          error: params.errorText,
          cors: params.corsErrorStatus,
        });
      else if (
        method === "Network.responseReceived" &&
        netUrls.has(params.requestId)
      )
        report.mobileNet.push({
          status: params.response.status,
          url: netUrls.get(params.requestId),
        });
    });
    await mobile.goto("https://localhost/");
    await mobile.evaluate(
      `localStorage.setItem("fake.scan", ${JSON.stringify(mobileShare.url)}); return true;`,
    );
    await mobile.until(buttonExists("扫码"), "连接页的「扫码」", {
      timeout: 30_000,
    });
    await shotAt(mobile, "06-mobile-connect-390");
    await mobile.until(
      `const b = (() => { ${buttonByText("扫码")} })(); if (!b) return null; b.click(); return true;`,
      "点「扫码」",
    );
    await hasText(mobile, "核对指纹", "手机核对指纹");
    await shotAt(mobile, "06-mobile-fingerprint-390");
    await mobile.until(
      `const b = (() => { ${buttonByText("信任并继续")} })(); if (!b) return null; b.click(); return true;`,
      "点「信任并继续」",
    );
    await terminalRoundTrip(mobile, mobileShare.terminal.id, "mobile");
    run.ok("手机扫码挂载、重载进画布、开终端并收发（42mobile）");
    const stored = await mobile.evaluate(
      `return JSON.parse(localStorage.getItem("fake.sessions") ?? "[]").map((s) => s.via + ":" + s.sourceId);`,
    );
    run.check(
      stored.includes(`relayed:${sourceId}`),
      "手机的会话进（假）钥匙串，路径是 relayed",
      stored,
    );
    await shotAt(mobile, "06-mobile-canvas-390");
    run.check(
      mobile.unexpected().length === 0,
      "手机页面无控制台错误",
      mobile.unexpected().slice(0, 3),
    );
  });

  /* ----------------------------- 7. 撤销 ----------------------------- */
  await timed("7-revoke", async () => {
    // 7a 链接：撤销后 accept 与落地页都报错，已加入的访客被断开。
    const revokedShare = await newShare("guest-revoked");
    const revokedAt = await revokeLink(revokedShare.linkId);
    run.check(
      revokedAt.status >= 200 && revokedAt.status < 300,
      "撤销链接（links.revoke）成功",
      revokedAt.status,
    );
    const accepted = await acceptLink(revokedShare);
    run.check(
      accepted.status >= 400 && typeof accepted.body?.code === "string",
      "撤销的链接 accept 被拒，带稳定的错误码",
      { status: accepted.status, code: accepted.body?.code },
    );
    const bad = await newPage(390, 844, true);
    await bad.goto(revokedShare.url);
    await hasText(bad, "链接已停用或不存在", "落地页提示链接已停用或不存在");
    await shotAt(bad, "07-revoked-landing-390");
    run.ok("撤销的链接打开落地页即提示「链接已停用或不存在」");

    const joined = await revokeLink(browserShare.linkId);
    run.check(joined.status < 300, "撤销已被访客用过的链接", joined.status);
    const guestBanner = await guest.until(
      `return [...document.querySelectorAll('[data-slot="banner"]')].map((b) => b.innerText.trim()).find((t) => t !== "") ?? null;`,
      "已加入的访客页面出现通知条（会话被撤销）",
      { timeout: 30_000 },
    );
    await shotAt(guest, "07-guest-after-revoke-1440");
    run.ok("撤销链接后已加入的访客被断开", guestBanner);

    // 7b 登记：本机撤销登记 → 隧道停、中继答源离线、主人页面等待上线。
    const assertion = await must("POST", `/v1/sources/${sourceId}/assertion`, {
      body: { device },
      token: await ownerToken(),
    });
    secret("中继令牌", assertion.relayToken);
    const healthy = await call("GET", `/s/${sourceId}/health`, {
      headers: { "armadra-relay-token": assertion.relayToken },
    });
    run.check(
      healthy.status === 200,
      "撤销前经中继访问源的 /health 通",
      healthy.status,
    );
    await owner("/api/identity/cloud/register", {
      method: "DELETE",
      body: JSON.stringify({ issuer }),
    });
    const stopped = await until(
      async () => {
        const now = await tunnel();
        return now.count === 0 ? now : null;
      },
      "登记撤销后 core 不再有登记",
      { timeout: 30_000 },
    );
    run.ok("core 撤销登记：登记表清空、隧道停", stopped.state);
    // 这台 core 有远程服务的 owner 会话：撤销连同中继侧的源记录一起删（契约
    // §31.4），中继随之作废发给它的中继令牌，经中继答 401 而不是离线 503。
    const offline = await until(
      async () => {
        const answer = await call("GET", `/s/${sourceId}/health`, {
          headers: { "armadra-relay-token": assertion.relayToken },
        });
        return answer.status >= 400 ? answer : null;
      },
      "中继拒绝经它访问已撤销的源",
      { timeout: 30_000 },
    );
    run.check(
      offline.status === 401 || offline.status === 503,
      "撤销登记后经中继访问被拒（401 令牌随源作废，或 503 离线）",
      { status: offline.status, code: offline.body?.code },
    );
    const ownerBanner = await page.until(
      `return [...document.querySelectorAll('[data-slot="banner"]')].map((b) => b.innerText.trim()).find((t) => t !== "") ?? null;`,
      "主人页面出现通知条（主机已下线）",
      { timeout: 60_000 },
    );
    await shotAt(page, "07-owner-after-revoke-1440");
    run.ok("撤销登记后经中继的主人页面收到下线通知", ownerBanner);
    const pending = await owner("/api/identity/cloud/relay-pending");
    run.check(
      Array.isArray(pending?.pending) && pending.pending.length === 0,
      "core 撤销时已删掉中继侧的源记录，不欠清理",
      pending,
    );
    const listed = await must("GET", "/v1/me/sources", {
      token: await ownerToken(),
    });
    run.check(
      !(listed.sources ?? []).some((one) => one.sourceId === sourceId),
      "中继的源目录里已经没有这台源",
      (listed.sources ?? []).map((one) => one.sourceId),
    );
    const refused = await call("POST", `/v1/sources/${sourceId}/assertion`, {
      body: { device },
      token: await ownerToken(),
    });
    run.check(
      refused.status >= 400 && typeof refused.body?.code === "string",
      "中继侧撤销后不再签断言，带错误码",
      { status: refused.status, code: refused.body?.code },
    );
  });

  /* ----------------------- 控制台与日志里不得有秘密 ----------------------- */
  run.consoleClean(page, guest);
  const logs = {
    relay: relay.log(),
    core: stack.coreLog(),
    electron: electron?.log() ?? "",
    probe: ledger.printed(),
  };
  const leaks = ledger.scan(logs);
  run.check(
    leaks.length === 0,
    "中继、core、Electron 与探针的日志里没有口令、令牌与链接秘密",
    {
      scanned: Object.fromEntries(
        Object.entries(logs).map(([k, v]) => [k, v.length]),
      ),
      secrets: ledger.secrets.size,
      leaks,
    },
  );

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
      report[`${name}Console`] = opened_.consoleLines.slice(-40);
      report[`${name}Text`] = await opened_.evaluate(
        "return document.body.innerText.slice(0, 1500)",
      );
    } catch {
      /* 页面已经关了：没有可补的。 */
    }
  }
  if (electron?.page && !electron.stopped) {
    await electron.page
      .capture(join(output, "zz-failure-desktop.png"))
      .catch(() => undefined);
    report.electronLog = electron.log().slice(-3000);
  }
  if (stack) report.coreLog = stack.coreLog().slice(-3000);
} finally {
  report.timings.totalMs = Date.now() - started;
  try {
    relay?.child.kill("SIGKILL");
  } catch {
    /* 已经退出。 */
  }
  if (electron && !electron.stopped) await electron.stop().catch(() => {});
  await stack?.stop();
  writeResult(output, report);
  console.log(`  报告  ${join(output, "result.json")}`);
  process.exit(report.status === "ok" ? 0 : 1);
}
