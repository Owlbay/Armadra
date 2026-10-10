// 个人中转的 WebKit 跑法（B 档）：personal-roundtrip 里页面那几步，换成 Safari / iPad
// 用的引擎（Playwright 的 WebKit）再走一遍。
//
// 真个人中转（armadra-cloud 检出里直接 node 跑 `personal init` + `serve`，自签 TLS，
// `/app/` 托管本仓库的 `apps/web/dist`）、真 core（不带壳），没有模拟的服务端：
//
//   1. 中继起来、core 登记并绑定主人，画布上一个终端、一段 H.264；
//   2. WebKit 打开 `/app/`：账号口令登录 → 进画布；
//   3. 终端输入输出经中继往返（42webkit）；
//   4. 空闲 6 秒后再 POST：Node 的 keep-alive 空闲超时是 5 秒，WebKit 复用一条服务端
//      刚关掉的连接时不替非幂等请求重试——中继边缘与经中继到源的两种 POST 各三轮，
//      每一轮都要拿到 HTTP 答复而不是网络错误；之后终端再收发一次；
//   5. 媒体票经中继（契约 §37.4、cloud-api §12）：编辑器节点的 `<video>` 在 WebKit 里
//      按 Range 取到元数据（WebKit 不认不带 Range 的视频）。
//
// ACP 的 mock 发 prompt 不在这里：personal-roundtrip 里没有那一步。
//
// WebKit 来自 Playwright（根 devDependency `playwright-core`），浏览器本体要先装：
//   pnpm exec playwright-core install webkit        # Linux 再加 --with-deps
// 没装或没有 armadra-cloud 检出时退出码 2（e2e 清单里记 skipped / 缺什么）。
//
// 用法（仓库根目录）：
//   pnpm libs:build && pnpm --filter @armadra/desktop build && pnpm --filter @armadra/web build
//   node tools/ci/e2e.mjs --tier b --only webkit-roundtrip
//   node tools/probes/webkit-roundtrip.mjs [输出目录]
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CLOUD_ENTRY, findCloudSource } from "./cloud-source.mjs";
import {
  caFingerprint,
  nodeAt,
  ownerClient,
  registerSource,
  relayClient,
  secretLedger,
  seedWorkspace,
  spawnRelay,
  startPlainCore,
} from "./platform-lib.mjs";
import {
  freePort,
  makeNode,
  root,
  scenario,
  sleep,
  until,
  writeResult,
} from "./ui-features/harness.mjs";

const output = resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ??
    join(root, "target/webkit-roundtrip"),
);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const cloudHome = findCloudSource();
if (!cloudHome) {
  console.error(
    `没有 armadra-cloud 的本地检出（${CLOUD_ENTRY}）：设 ARMADRA_DEV_STACK_CLOUD_SRC 或放在仓库旁的 ../cloud`,
  );
  process.exit(2);
}
let webkit;
try {
  ({ webkit } = createRequire(join(root, "package.json"))("playwright-core"));
} catch {
  console.error("没有 playwright-core：先 pnpm install");
  process.exit(2);
}
if (!existsSync(webkit.executablePath())) {
  console.error(
    "没有 Playwright 的 WebKit：pnpm exec playwright-core install webkit（Linux 加 --with-deps）",
  );
  process.exit(2);
}
for (const [file, hint] of [
  ["apps/web/dist/index.html", "pnpm --filter @armadra/web build"],
  ["apps/desktop/out/core/main.js", "pnpm --filter @armadra/desktop build"],
]) {
  if (!existsSync(join(root, file))) {
    console.error(`先 ${hint}`);
    process.exit(2);
  }
}
if (process.platform === "win32") {
  console.error("探针要私有通道（core-control.sock），Windows 上不跑");
  process.exit(2);
}
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

const report = { status: "failed", output, scenarios: [], timings: {} };
const started = Date.now();
const ledger = secretLedger();
const { secret } = ledger;
let relay;
let core;
let browser;
let scratch;

const timed = async (name, work) => {
  const at = Date.now();
  try {
    return await work();
  } finally {
    report.timings[name] = Date.now() - at;
  }
};

try {
  scratch = mkdtempSync(join(tmpdir(), "armadra-webkit-"));
  const run = scenario(report, "个人中转的 WebKit 跑法", output);

  /* ----------------------- 1. 中继、core 登记、画布 ----------------------- */
  const relayData = join(scratch, "relay");
  const passwordFile = join(scratch, "relay.password");
  const password = secret("中继口令", randomBytes(18).toString("base64url"));
  writeFileSync(passwordFile, password, { mode: 0o600 });
  const port = await freePort();
  const issuer = `https://127.0.0.1:${port}`;
  const common = ["--data-dir", relayData, "--host", "127.0.0.1"];
  const init = spawnRelay(cloudHome, [
    "init",
    ...common,
    "--account",
    "dev",
    "--port",
    String(port),
    "--tls",
    "self-signed",
    "--password-file",
    passwordFile,
  ]);
  const initCode = await new Promise((done) => init.child.once("exit", done));
  run.check(initCode === 0, "personal init 退出码 0", initCode);
  const serve = spawnRelay(cloudHome, [
    "serve",
    ...common,
    "--port",
    String(port),
    "--tls",
    "self-signed",
    "--web-root",
    join(root, "apps/web/dist"),
    "--log-level",
    "info",
  ]);
  relay = {
    issuer,
    account: "dev",
    password,
    logs: serve.log,
    stop: async () => {
      serve.child.kill("SIGTERM");
      for (let i = 0; i < 50 && serve.child.exitCode === null; i += 1)
        await sleep(100);
      if (serve.child.exitCode === null) serve.child.kill("SIGKILL");
    },
  };
  relay.caPem = await until(
    () => {
      if (serve.child.exitCode !== null)
        throw new Error(`中继退出：${serve.log()}`);
      try {
        return readFileSync(join(relayData, "tls", "ca.crt"), "utf8");
      } catch {
        return null;
      }
    },
    "中继的自签 CA 落盘",
    { timeout: 30_000, every: 200 },
  );
  relay.fingerprint = caFingerprint(relay.caPem);
  Object.assign(relay, relayClient(issuer, relay.caPem));
  await until(
    async () => {
      try {
        return (await relay.call("GET", "/.well-known/armadra-platform"))
          .status === 200
          ? true
          : null;
      } catch {
        return null;
      }
    },
    "个人中转起来",
    { timeout: 30_000, every: 200 },
  );
  run.ok("个人中转起来", issuer);

  core = await timed("1-core", () => startPlainCore({ scratch, tag: "wk" }));
  secret("core 本机会话", core.session.headers.authorization.slice(7));
  const owner = ownerClient(core.session);
  const registered = await timed("1-register", () =>
    registerSource({
      relay,
      core: owner,
      label: "webkit-host",
      onSecret: secret,
    }),
  );
  const project = join(scratch, "project");
  mkdirSync(project, { recursive: true });
  copyFileSync(
    join(root, "tools/probes/fixtures/clip-h264.mp4"),
    join(project, "clip.mp4"),
  );
  const seeded = await seedWorkspace(
    owner.owner,
    "webkit-workspace",
    project,
    (boardId) => [
      makeNode(
        boardId,
        "terminal",
        "终端",
        { x: 120, y: 120 },
        { width: 520, height: 300 },
        { kind: "terminal", cwd: project },
      ),
      makeNode(
        boardId,
        "editor",
        "clip.mp4",
        { x: 700, y: 120 },
        { width: 480, height: 320 },
        { kind: "editor", path: "clip.mp4" },
      ),
    ],
  );
  const [terminal, editor] = seeded.nodes;
  run.ok(
    "core 登记到中继、隧道 ready，画布上一个终端与一段视频",
    registered.sourceId,
  );

  /* ------------------------- 2. WebKit 打开 /app/ ------------------------- */
  browser = await webkit.launch();
  report.webkit = browser.version();
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
  });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(String(error).slice(0, 300)));
  // 媒体那几条请求的状态（票抹掉）：失败时知道断在哪一步。
  const media = [];
  const mark = (url) => url.replace(/[A-Za-z0-9_-]{43}/, "<票>");
  page.on("response", (response) => {
    const url = response.url();
    if (
      /mediaTicket|media-tickets|\/_relay\/m\/|\/api\/media\/|file-download/.test(
        url,
      )
    )
      media.push(
        `${response.status()} ${response.request().method()} ${mark(url)} ${response.headers()["content-range"] ?? ""}`,
      );
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (/_relay|api\/media|file-download/.test(url))
      media.push(`failed ${mark(url)} ${request.failure()?.errorText ?? ""}`);
  });
  report.media = media;
  await timed("2-sign-in", async () => {
    await page.goto(
      `${issuer}/app/?workspace=${seeded.workspace.id}&board=${seeded.board.id}`,
    );
    const form = page.locator('[data-slot="relay-sign-in"]');
    await form.waitFor({ timeout: 45_000 });
    await form.locator('input[autocomplete="username"]').fill("dev");
    await form.locator('input[type="password"]').fill(password);
    await form.locator('input[type="password"]').press("Enter");
    await page.locator(nodeAt(terminal.id)).waitFor({ timeout: 60_000 });
  });
  await page.screenshot({ path: join(output, "02-canvas.png") });
  run.ok("WebKit 里账号口令登录后进画布", report.webkit);

  /* --------------------------- 3. 终端经中继往返 --------------------------- */
  const echo = async (tag) => {
    const screen = page.locator(`${nodeAt(terminal.id)} .xterm-screen`);
    await screen.waitFor({ timeout: 90_000 });
    await screen.click();
    await page.keyboard.type(`echo $((40+2))${tag}`);
    await page.keyboard.press("Enter");
    await until(
      async () =>
        (
          (await page
            .locator(`${nodeAt(terminal.id)} .xterm-rows`)
            .innerText()
            .catch(() => "")) ?? ""
        ).includes(`42${tag}`) || null,
      `终端回显 42${tag}`,
      { timeout: 30_000, every: 200 },
    );
  };
  await timed("3-terminal", () => echo("webkit"));
  run.ok("WebKit 里经中继开终端并收发（42webkit）");

  /* ------------------------- 4. 空闲 6 秒后再 POST ------------------------- */
  const sourceBase = `/s/${registered.sourceId}`;
  const rounds = [];
  for (let round = 0; round < 3; round += 1) {
    await sleep(6_500);
    const answer = await page.evaluate(async (base) => {
      const post = async (path, body) => {
        try {
          const response = await fetch(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          return response.status;
        } catch (error) {
          return `network: ${String(error)}`;
        }
      };
      return {
        // 中继自己答：错口令 401 / 400。
        relay: await post("/v1/auth/login", {
          account: "dev",
          password: "not-the-password-0",
          device: { platform: "browser", name: "webkit-idle" },
        }),
        // 经中继到源：不带中继令牌，边缘答 401。
        source: await post(`${base}/api/identity/ws-ticket`, {}),
      };
    }, sourceBase);
    rounds.push(answer);
  }
  run.check(
    rounds.every(
      (round) =>
        typeof round.relay === "number" && typeof round.source === "number",
    ),
    "空闲 6 秒后再 POST：三轮里中继与经中继的源都答了 HTTP 状态，没有网络错误",
    rounds,
  );
  await echo("idle");
  run.ok("空闲之后终端照样收发（42idle）");

  /* ------------------------- 5. 媒体票经中继的 Range ------------------------- */
  const video = await timed("5-media", () =>
    until(
      async () =>
        page.evaluate((selector) => {
          const element = document.querySelector(`${selector} video`);
          if (!element) return null;
          return element.readyState >= 1 && element.duration > 0
            ? {
                src: element.getAttribute("src"),
                duration: element.duration,
                readyState: element.readyState,
              }
            : null;
        }, nodeAt(editor.id)),
      "WebKit 里视频经中继取到元数据",
      { timeout: 60_000, every: 300 },
    ),
  ).catch(async (error) => {
    report.videoFailure = await page
      .evaluate((selector) => {
        const node = document.querySelector(selector);
        const element = node?.querySelector("video");
        return {
          text: node?.innerText?.slice(0, 200) ?? null,
          src: (element?.getAttribute("src") ?? "").replace(
            /[A-Za-z0-9_-]{43}$/,
            "<票>",
          ),
          error: element?.error?.code ?? null,
          canPlay: document
            .createElement("video")
            .canPlayType('video/mp4; codecs="avc1.42E01E"'),
        };
      }, nodeAt(editor.id))
      .catch((cause) => String(cause));
    throw error;
  });
  run.check(
    /\/_relay\/m\/[A-Za-z0-9_-]{43}$/.test(video.src ?? "") &&
      !(video.src ?? "").includes("clip"),
    "WebKit 的 <video src> 是中继的媒体票地址，按 Range 取到元数据",
    { duration: video.duration, readyState: video.readyState },
  );
  await page.screenshot({ path: join(output, "05-video.png") });
  run.check(
    problems.length === 0,
    "WebKit 页面无未捕获异常",
    problems.slice(0, 5),
  );

  const leaks = ledger.scan({
    relay: relay.logs(),
    core: core.log(),
    probe: ledger.printed(),
  });
  run.check(leaks.length === 0, "中继、core 与探针的日志里没有口令与令牌", {
    secrets: ledger.secrets.size,
    leaks,
  });
  run.entry.status = "ok";
  report.status = "ok";
} catch (error) {
  report.error =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`  FAIL  ${report.error}`);
  if (relay) report.relayLog = relay.logs().slice(-3000);
  if (core) report.coreLog = core.log().slice(-3000);
} finally {
  report.timings.totalMs = Date.now() - started;
  await browser?.close().catch(() => {});
  await core?.stop().catch(() => {});
  await relay?.stop().catch(() => {});
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  writeResult(output, report);
  console.log(`  报告  ${join(output, "result.json")}`);
  process.exit(report.status === "ok" ? 0 : 1);
}
