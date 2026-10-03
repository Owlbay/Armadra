// 桌面 Gateway 端到端探针（补全计划 G1-10，A 档）。
//
// 真进程：`apps/desktop/out/core/main.js` 以桌面模式起在临时数据目录上，经回环的
// `PUT /api/gateway` 打开 Gateway（本地 CA，只在回环上监听），然后：
//
//   1. 「另一个浏览器上下文」先不验证书取 `GET /ca.crt`，核对它的 SHA-256 与配对
//      载荷里的 `fp` 一致，之后只信这张 CA（完整验证 TLS 链，不再跳过校验）；
//   2. 用配对票成为 owner，建一块画布，签一张只读邀请；
//   3. 第三个上下文（同样只信 CA、Cookie 不共享）兑换邀请注册成员，读得到被
//      共享的画布、写被拒、`/api/gateway` 403；
//   4. 「从页面开关」（G2-7）：无头 Chrome 打开网页配对链接，页面自己配对成
//      owner；后台服务页里有 CA 安装引导、对外服务开着、二维码里是同一个来源、
//      已配对设备表里有这台；在页面上点开关关掉 Gateway，回环上读到已关，
//      再从回环打开继续后面的步骤；
//   5. 「成员注册 passkey 后用它登录」（G2-8）：公网来源设成
//      `https://localhost:<端口>`（WebAuthn 不认 IP 字面量），无头 Chrome 的
//      独立上下文里兑换邀请成为成员，CDP 的 WebAuthn 虚拟认证器代替指纹；
//      在设置 → 安全里点「添加通行密钥」，清掉 Cookie 后在同一页点「使用通行
//      密钥」登录回同一个成员；审计里有 `identity.passkey.add` 与
//      `identity.login`（`method: "passkey"`）；
//   6. 关掉 Gateway，连接被拒。
//
// 第 4、5 步要页面产物（`apps/web/dist`，CI 的 e2e 作业先 build）与 Chrome；
// 没有页面产物记 `page: "skipped"`。
//
// 设了 `ARMADRA_DEV_STACK=1` 且 dev-stack 的 step-ca 在跑时，加一段「指定文件」
// 来源：在 step-ca 容器里给 127.0.0.1 签一张叶证书（链 = 叶 + 中间 CA），切过去
// 之后 `fp` 是叶证书的指纹、`/ca.crt` 发链里最后一张、只信 step-ca 根的客户端
// 验得过。step-ca 不在跑就记 `skipped`，不起也不停任何容器。
//
// 一切都是临时的、回环的：随机端口，mktemp 出来的数据目录与工作空间，跑完删除。
//
// 用法（仓库根目录）：
//   pnpm libs:build && pnpm --filter @armadra/desktop build
//   node tools/probes/gateway-e2e.mjs [输出目录]
//
// 产物：<输出目录>/result.json，默认 target/gateway-e2e/。
import { spawn, spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { harness, sleep, startChrome } from "./shell-e2e-lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(process.argv[2] ?? join(root, "target/gateway-e2e"));
mkdirSync(output, { recursive: true });
const h = harness(output);
const { report, step, temp } = h;
report.failures = [];

function check(ok, name, detail = "") {
  if (ok) step(name, detail);
  else {
    report.failures.push({ name, detail });
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function collect(response, done) {
  const chunks = [];
  response.on("data", (chunk) => chunks.push(chunk));
  response.on("end", () =>
    done({
      status: response.statusCode ?? 0,
      headers: response.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    }),
  );
}

/** 回环上的 core：本机 owner，不带来源。 */
function local(base, method, path, body) {
  const url = new URL(path, base);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((done, failed) => {
    const client = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers:
          payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(payload)),
              },
      },
      (response) => collect(response, done),
    );
    client.on("error", failed);
    if (payload !== undefined) client.write(payload);
    client.end();
  });
}

/**
 * 一个「浏览器上下文」：自己的 Cookie 与 CSRF，只信给它的那张 CA。`trust` 为
 * `undefined` 时不验证书——只用于第一次取 CA。
 */
function context(origin, trust) {
  let cookie = "";
  let csrf = "";
  const call = (path, { method = "GET", body, sendOrigin = true } = {}) => {
    const url = new URL(path, origin);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {};
    if (sendOrigin) headers.origin = origin;
    if (cookie) headers.cookie = cookie;
    if (csrf) headers["x-armadra-csrf"] = csrf;
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    return new Promise((done, failed) => {
      const client = httpsRequest(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          headers,
          ...(trust === undefined
            ? { rejectUnauthorized: false }
            : { ca: trust, rejectUnauthorized: true }),
        },
        (response) => collect(response, done),
      );
      client.on("error", failed);
      if (payload !== undefined) client.write(payload);
      client.end();
    });
  };
  return {
    call,
    adopt(answer) {
      cookie = (answer.headers["set-cookie"] ?? [])
        .map((value) => value.split(";")[0].trim())
        .join("; ");
      csrf = JSON.parse(answer.body).csrfToken;
    },
  };
}

function fingerprint(pem) {
  return createHash("sha256")
    .update(new X509Certificate(pem).raw)
    .digest("hex");
}

/** 页面产物：有就让 Gateway 托管它（第 4 步），没有就给一个空目录。 */
const webDist = join(root, "apps/web/dist");
const hasPage = existsSync(join(webDist, "index.html"));

async function startCore(dataDir) {
  const entry = join(root, "apps/desktop/out/core/main.js");
  const child = spawn(
    process.execPath,
    [entry, "--listen", "tcp:127.0.0.1:0", "--data-dir", dataDir],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ARMADRA_CORE: "ts",
        ARMADRA_NO_GLOBAL_WRITES: "1",
        ARMADRA_SECRET_BACKEND: "file",
        ARMADRA_GATEWAY_WEB_ROOT: hasPage
          ? webDist
          : temp("armadra-gateway-web-"),
      },
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stdout.resume();
  const address = await new Promise((done, failed) => {
    const timer = setTimeout(
      () => failed(new Error(`core 没有报地址：\n${stderr}`)),
      30_000,
    );
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const found = /Armadra core is listening .*"spec":"tcp:([^"]+)"/.exec(
        stderr,
      );
      if (found) {
        clearTimeout(timer);
        done(found[1]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      failed(new Error(`core 退出 ${code}：\n${stderr}`));
    });
  });
  h.cleanups.push(
    () =>
      new Promise((done) => {
        child.once("exit", () => done());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      }),
  );
  return `http://${address}`;
}

/** step-ca 在跑时给 127.0.0.1 签一张叶证书；不在跑返回 undefined。 */
function stepCaLeaf(directory) {
  const compose = [
    "compose",
    "--project-directory",
    join(root, "tools/dev-stack"),
    "-f",
    join(root, "tools/dev-stack/docker-compose.yml"),
  ];
  // 与 `pnpm dev-stack` 同一份 compose 参数：没有 env 文件时 compose 连插值都过不去。
  const envFile = join(root, "tools/dev-stack/.data/dev.env");
  if (existsSync(envFile)) compose.push("--env-file", envFile);
  const running = spawnSync("docker", [...compose, "ps", "-q", "step-ca"], {
    encoding: "utf8",
  });
  if (running.status !== 0 || running.stdout.trim() === "") return undefined;
  const exec = (args) =>
    spawnSync("docker", [...compose, "exec", "-T", "step-ca", ...args], {
      encoding: "utf8",
    });
  // 离线用 step-ca 自己的中间 CA 签（不经 JWK provisioner：它的口令镜像只打印
  // 在首次启动日志里）。链与 step-ca 在线签发的一样是「叶 + 中间 CA」。
  const issued = exec([
    "step",
    "certificate",
    "create",
    "127.0.0.1",
    "/tmp/armadra-leaf.crt",
    "/tmp/armadra-leaf.key",
    "--profile",
    "leaf",
    "--ca",
    "/home/step/certs/intermediate_ca.crt",
    "--ca-key",
    "/home/step/secrets/intermediate_ca_key",
    "--ca-password-file",
    "/home/step/secrets/password",
    "--san",
    "127.0.0.1",
    "--no-password",
    "--insecure",
    "--bundle",
    "--force",
  ]);
  if (issued.status !== 0)
    throw new Error(`step certificate create 失败：${issued.stderr}`);
  const cert = exec(["cat", "/tmp/armadra-leaf.crt"]).stdout;
  const key = exec(["cat", "/tmp/armadra-leaf.key"]).stdout;
  const rootPem = exec(["cat", "/home/step/certs/root_ca.crt"]).stdout;
  exec(["rm", "-f", "/tmp/armadra-leaf.crt", "/tmp/armadra-leaf.key"]);
  const certFile = join(directory, "leaf-chain.crt");
  const keyFile = join(directory, "leaf.key");
  writeFileSync(certFile, cert);
  writeFileSync(keyFile, key, { mode: 0o600 });
  return { certFile, keyFile, cert, root: rootPem };
}

await h.run(async () => {
  const dataDir = temp("armadra-gateway-e2e-");
  const base = await startCore(dataDir);
  step("core 起在回环上", base);

  const opened = await local(base, "PUT", "/api/gateway", {
    enabled: true,
    listen: "loopback",
  });
  const status = JSON.parse(opened.body);
  check(
    opened.status === 200 && status.running && status.tls.source === "localCa",
    "PUT /api/gateway 打开 Gateway（本地 CA）",
    status.origin,
  );
  const origin = status.origin;

  const stranger = context(origin);
  const caAnswer = await stranger.call("/ca.crt", { sendOrigin: false });
  check(caAnswer.status === 200, "GET /ca.crt 匿名");
  const ca = caAnswer.body;
  const pairing = JSON.parse(
    (await local(base, "POST", "/api/gateway/pairing", {})).body,
  );
  check(
    fingerprint(ca) === pairing.fingerprint &&
      pairing.webUrl.endsWith(`&fp=${pairing.fingerprint}`),
    "CA 的指纹与配对载荷的 fp 一致",
    pairing.fingerprint,
  );

  const owner = context(origin, ca);
  const paired = await owner.call("/api/identity/pair", {
    method: "POST",
    body: { ticket: pairing.ticket },
  });
  check(paired.status === 200, "只信 CA 的上下文配对成 owner");
  owner.adopt(paired);

  const rootPath = temp("armadra-gateway-ws-");
  writeFileSync(join(rootPath, "README.md"), "shared");
  const created = await owner.call("/api/workspaces", {
    method: "POST",
    body: { name: "shared", rootPath },
  });
  const workspaceId = JSON.parse(created.body).id;
  const invited = await owner.call("/api/identity/invitations", {
    method: "POST",
    body: { role: "viewer", targetWorkspaceId: workspaceId },
  });
  check(invited.status === 201, "owner 签一张只读邀请");

  const member = context(origin, ca);
  const registered = await member.call("/api/identity/register", {
    method: "POST",
    body: {
      token: JSON.parse(invited.body).token,
      displayName: "成员",
      password: "correct horse battery",
    },
  });
  check(registered.status === 201, "另一个上下文兑换邀请注册成员");
  member.adopt(registered);
  const read = await member.call(`/api/workspaces/${workspaceId}/boards`);
  check(read.status === 200, "成员读得到被共享的画布");
  const write = await member.call(`/api/workspaces/${workspaceId}/boards`, {
    method: "POST",
    body: { name: "x" },
  });
  check(write.status === 403, "只读成员写被拒", String(write.status));
  const gateway = await member.call("/api/gateway");
  check(
    gateway.status === 403,
    "成员碰不到 /api/gateway",
    String(gateway.status),
  );

  if (hasPage) {
    await fromThePage(base, origin);
    await passkeyFromThePage(base, owner, workspaceId);
  } else {
    report.page = "skipped";
    report.passkey = "skipped";
    step("没有 apps/web/dist，「从页面开关」与 passkey 两段 skipped");
  }

  if (process.env.ARMADRA_DEV_STACK === "1") {
    const leaf = stepCaLeaf(temp("armadra-gateway-stepca-"));
    if (leaf === undefined) {
      report.stepCa = "skipped";
      step("step-ca 不在跑，「指定文件」一段 skipped");
    } else {
      const switched = JSON.parse(
        (
          await local(base, "PUT", "/api/gateway", {
            tls: {
              source: "file",
              certFile: leaf.certFile,
              keyFile: leaf.keyFile,
            },
          })
        ).body,
      );
      const [leafPem] = leaf.cert.match(
        /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
      );
      check(
        switched.running && switched.tls.fingerprint === fingerprint(leafPem),
        "指定文件（step-ca 签的链）：fp 是叶证书的",
      );
      const anchor = await context(switched.origin).call("/ca.crt", {
        sendOrigin: false,
      });
      check(
        anchor.status === 200 &&
          new X509Certificate(anchor.body).subject !==
            new X509Certificate(leafPem).subject,
        "/ca.crt 发链里最后一张",
        new X509Certificate(anchor.body).subject,
      );
      const trusted = await context(
        switched.origin,
        `${leaf.root}${anchor.body}`,
      ).call("/health");
      check(trusted.status === 200, "只信 step-ca 根的客户端验得过");
      report.stepCa = "ok";
    }
  } else {
    report.stepCa = "skipped";
  }

  const closed = JSON.parse(
    (await local(base, "PUT", "/api/gateway", { enabled: false })).body,
  );
  let refused = false;
  try {
    await stranger.call("/health");
  } catch (error) {
    refused = /ECONNREFUSED/.test(String(error));
  }
  check(!closed.running && refused, "关掉之后连接被拒");
});

/**
 * 第 4 步：页面上的对外服务（补全计划 G2-7）。Chrome 带 `--ignore-certificate-errors`，
 * 只为本地 CA；页面经 Gateway 打开，所有请求走 Gateway 的 Cookie 模式。
 */
async function fromThePage(base, origin) {
  const pairing = JSON.parse(
    (await local(base, "POST", "/api/gateway/pairing", {})).body,
  );
  const chrome = await startChrome(h);
  const page = await chrome.open({ name: "gateway-page" });
  await page.navigate(pairing.webUrl);
  await page.settle();
  await page.waitFor(`return document.body.innerText.includes("服务所有者");`, {
    what: "配对链接打开即配对成 owner",
    timeout: 30_000,
  });
  step("网页配对链接在浏览器里配对成 owner", origin);

  const guide = await page.waitFor(
    `const link = [...document.querySelectorAll("a[download]")]
       .find((node) => node.getAttribute("href")?.endsWith("/ca.crt"));
     return link && document.body.innerText.includes("安装证书")
       ? link.getAttribute("href") : null;`,
    { what: "配对页的 CA 安装引导" },
  );
  check(
    guide === `${origin}/ca.crt`,
    "经 Gateway 打开的配对页给出 CA 安装引导与下载",
    guide,
  );

  const qr = await page.waitFor(
    `return document.querySelector('[role="switch"][aria-label="对外服务"]')
       ?.getAttribute("aria-checked") === "true"
       && document.querySelector("svg[data-qr-text]")?.getAttribute("data-qr-text");`,
    { what: "对外服务开着、二维码出来" },
  );
  check(
    typeof qr === "string" && qr.startsWith(`${origin}/#pair=`),
    "页面上的二维码是这个 Gateway 的配对链接",
    String(qr).slice(0, 48),
  );
  await page.waitFor(
    `return [...document.querySelectorAll("table td")]
       .some((cell) => cell.innerText.includes("Gateway 配对"));`,
    { what: "已配对设备表里有这台" },
  );
  step("已配对设备表里有这台");
  await page.capture("gateway-page-on");
  await page.evaluate(
    `document.querySelector("table")?.scrollIntoView({ block: "center" }); return true;`,
  );
  await sleep(300);
  await page.capture("gateway-page-devices");

  await page.click('[role="switch"][aria-label="对外服务"]');
  let after = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    after = JSON.parse((await local(base, "GET", "/api/gateway")).body);
    if (!after.enabled) break;
    await sleep(200);
  }
  check(
    after && !after.enabled && !after.running,
    "在页面上点开关关掉对外服务（PUT 经 Gateway 自己）",
  );
  report.page = "ok";

  // 后面的步骤还要它开着：从回环再打开，端口已写回设置，来源不变。
  const reopened = JSON.parse(
    (await local(base, "PUT", "/api/gateway", { enabled: true })).body,
  );
  check(
    reopened.running && reopened.origin === origin,
    "从回环再打开，来源不变",
    reopened.origin,
  );
}

/**
 * 第 5 步：成员注册 passkey 后用它登录（补全计划 G2-8）。WebAuthn 只认域名，
 * 所以先把公网来源设成 `https://localhost:<端口>`——Gateway 的来源集合与证书
 * 主机名随之加上 localhost，RP ID 取它的主机名。认证器是 CDP 的虚拟认证器
 * （内置、可发现凭据、用户验证自动通过），页面里跑的是真的
 * `navigator.credentials.create / get`。
 */
async function passkeyFromThePage(base, owner, workspaceId) {
  const port = new URL(
    JSON.parse((await local(base, "GET", "/api/gateway")).body).origin,
  ).port;
  const publicOrigin = `https://localhost:${port}`;
  const configured = JSON.parse(
    (await local(base, "PUT", "/api/gateway", { publicOrigin })).body,
  );
  check(
    configured.running && configured.publicOrigin === publicOrigin,
    "公网来源设成 localhost（passkey 不认 IP）",
    publicOrigin,
  );
  const invited = await owner.call("/api/identity/invitations", {
    method: "POST",
    body: { role: "viewer", targetWorkspaceId: workspaceId },
  });
  check(
    invited.status === 201,
    "owner 再签一张邀请给 passkey 成员",
    invited.status === 201 ? "" : invited.body,
  );
  const token = JSON.parse(invited.body).token;

  const chrome = await startChrome(h);
  const page = await chrome.open({ name: "passkey-page", isolated: true });
  await page.call("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await page.call(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  await page.navigate(`${publicOrigin}/`);
  await page.settle();
  const registered = await page.evaluate(`
    const answer = await fetch("/api/identity/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: ${JSON.stringify(token)},
        displayName: "通行密钥成员", password: "correct horse battery staple" }),
    });
    const body = await answer.json();
    return { status: answer.status, principalId: body.device?.principalId ?? "" };
  `);
  check(
    registered.status === 201 && registered.principalId !== "",
    "页面里兑换邀请成为成员（localhost 来源）",
  );
  await page.navigate(`${publicOrigin}/`);
  await page.settle();

  const openSecurity = async () => {
    await page.click("button", "设置");
    await page.waitFor(
      `return !!document.querySelector('[role="dialog"] nav');`,
    );
    await page.click('[role="dialog"] nav button', "安全");
    await sleep(600);
  };
  await openSecurity();
  await page.click('[role="dialog"] button', "添加通行密钥");
  await page.waitFor(
    `return [...document.querySelectorAll('[role="dialog"] table td')]
       .some((cell) => cell.innerText.includes("Chrome"));`,
    { what: "通行密钥表里出现新登记的一行", timeout: 30_000 },
  );
  const { credentials } = await page.call("WebAuthn.getCredentials", {
    authenticatorId,
  });
  check(
    credentials.length === 1 && credentials[0].isResidentCredential,
    "虚拟认证器里有一把可发现凭据，页面列表里有这一行",
    credentials[0]?.rpId,
  );
  check(
    credentials[0]?.rpId === "localhost",
    "RP ID 是公网来源的主机名",
    credentials[0]?.rpId,
  );
  await page.capture("passkey-added");

  // 登出：清掉这个上下文的 Cookie，页面重载后安全页就是登录。
  await page.call("Network.clearBrowserCookies");
  await page.navigate(`${publicOrigin}/`);
  await page.settle();
  await openSecurity();
  await page.waitFor(
    `return [...document.querySelectorAll('[role="dialog"] button')]
       .some((node) => node.innerText.includes("使用通行密钥"));`,
    { what: "没登录时安全页给出登录（含通行密钥按钮）" },
  );
  await page.capture("passkey-sign-in");
  await page.click('[role="dialog"] button', "使用通行密钥");
  await page.waitFor(
    `return [...document.querySelectorAll('[role="dialog"] h3')]
       .some((node) => node.innerText.includes("会话与设备"));`,
    { what: "用通行密钥登录后安全页回来", timeout: 30_000 },
  );
  const who = await page.evaluate(`
    const answer = await fetch("/api/identity/session");
    const body = await answer.json();
    return body.device?.principalId ?? "";
  `);
  check(
    who === registered.principalId,
    "通行密钥登录回同一个成员",
    who.slice(0, 8),
  );
  await page.capture("passkey-signed-in");

  const audit = JSON.parse(
    (
      await owner.call(
        `/api/identity/audit?principalId=${registered.principalId}&action=identity.passkey&action=identity.login`,
      )
    ).body,
  );
  const actions = (audit.entries ?? []).map((entry) => entry.action);
  check(
    actions.includes("identity.passkey.add") &&
      audit.entries.some(
        (entry) =>
          entry.action === "identity.login" &&
          entry.detail?.method === "passkey",
      ),
    "审计里有登记与 passkey 登录（按动作族筛）",
    actions.join(","),
  );
  const leaked = page.drain();
  check(
    leaked.errors.length === 0,
    "passkey 这一段页面没有控制台错误",
    JSON.stringify(leaked.errors).slice(0, 200),
  );
  report.passkey = "ok";
}
