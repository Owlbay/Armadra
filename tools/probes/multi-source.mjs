// 多源并存探针（平台计划 V2，A 档）。
//
// 一个真 Electron（桌面页面，自己的 core 是本机源）同时挂着三个源，两台远端 core 都经
// 同一个个人中转挂载（`sources.mount`，relayed）：
//
//   本机源        Electron 自己的 core；
//   经中继源 NAT  一台在 NAT 后、只会往外连的 core（宿主进程，没有桌面壳）；
//   经中继源 第二台 另一台不带壳的 core（浏览器后端是它自己起的 headless Chromium），
//                 同样只经隧道出去，桌面不直连它。
//
// 步骤，每步都有断言与截图：
//   1. 起中继容器、两台 core 各自登记；桌面挂上两个经中继的源，页面重载；
//   2. 侧栏：本机的工作空间在树里，两个经中继的源各一组（就绪、各列出自己的工作空间）；
//   3. 每个源各开一个终端并回显——先点服务器组，再点 NAT 组，最后点（此时成了一组的）
//      本机；三个源都在侧栏里当过「组」；
//   4. 媒体经中继（契约 §37.4、cloud-api §12）：服务器组里编辑器节点打开一段 H.264，
//      `<video src>` 是中继的媒体票地址、按 Range 取到元数据；探针自己再按票取一次
//      `Range: bytes=0-1023`，经中继回 206；
//   5. 语言会话经中继（§35.6 的独立连接）：开会话、连流、`initialize` + `didOpen`，
//      mock 语言服务器的诊断经中继回来；断开后新开一条会话照样能用（页面断线后重开）；
//   6. 浏览器画面经中继：第二台 core 上的浏览器节点开画面流，点一下页面，重画后的新帧经中继回来；
//   7. NAT 的源下线（杀掉那台 core）：它那一组灰显、状态不再就绪，本机终端照常输入，
//      服务器组不受影响；
//   8. 它回来（同一数据目录再起）：隧道重连，那一组恢复就绪，终端又能收发。
//
// 中继在容器里（`docker run`，随机端口、随机名字，收尾只删自己的）；镜像可用
// `ARMADRA_PROBE_RELAY_IMAGE` 指定，否则从 armadra-cloud 检出构建。中继来自
// armadra-cloud 的本地检出（`cloud-source.mjs`）；没有检出或没有 Docker 时退出码 2
// （e2e 清单里记 skipped）。
//
// 用法（仓库根目录）：
//   pnpm libs:build && pnpm --filter @armadra/desktop build && pnpm --filter @armadra/web build
//   node tools/ci/e2e.mjs --only multi-source
//   node tools/probes/multi-source.mjs [输出目录]
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

import { CLOUD_ENTRY, findCloudSource } from "./cloud-source.mjs";
import {
  dockerReady,
  launchElectron,
  ownerClient,
  reloadAfterMount,
  nodeAt,
  registerSource,
  relayedRoute,
  secretLedger,
  seedWorkspace,
  socketOpened,
  startDockerRelay,
  startPlainCore,
  terminalInPage,
} from "./platform-lib.mjs";
import { probeSession } from "./probe-session.mjs";
import {
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
    join(root, "target/multi-source"),
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
if (!dockerReady()) {
  console.error("Docker 守护进程没有运行：个人中转在容器里跑");
  process.exit(2);
}
for (const [file, hint] of [
  ["apps/web/dist/index.html", "pnpm --filter @armadra/web build"],
  ["apps/desktop/out/main/index.js", "pnpm --filter @armadra/desktop build"],
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
let stack;
let direct;
let electron;
let pageServer;
const sockets = [];

const timed = async (name, work) => {
  const at = Date.now();
  try {
    return await work();
  } finally {
    report.timings[name] = Date.now() - at;
  }
};

try {
  stack = await startStack({
    log: "info",
    env: { ARMADRA_SECRET_BACKEND: "file" },
  });
  report.chrome = stack.chrome;
  const run = scenario(
    report,
    "多源并存（V2 multi-source，两台 core 都经中继）",
    output,
  );

  /* ---------------- 1. 中继容器、两台经中继的 core（NAT、第二台） ---------------- */
  const password = secret("中继口令", randomBytes(18).toString("base64url"));
  relay = await timed("1-relay", () =>
    startDockerRelay({
      cloudHome,
      webRoot: join(root, "apps/web/dist"),
      scratch: stack.scratch,
      password,
    }),
  );
  run.ok("个人中转在容器里起来", relay.issuer);

  // NAT 后的源：stack 的 core（宿主进程，只往外连）。
  const natSession = await probeSession({
    dataDir: stack.data,
    base: stack.origin,
  });
  secret("NAT core 本机会话", natSession.headers.authorization.slice(7));
  const nat = ownerClient(natSession);
  const natRegistered = await timed("1-register-nat", () =>
    registerSource({
      relay,
      core: nat,
      label: "nat-host",
      onSecret: secret,
    }),
  );
  const natId = natRegistered.sourceId;
  const natProject = join(stack.scratch, "nat-project");
  const natSeed = await seedWorkspace(
    nat.owner,
    "nat-workspace",
    natProject,
    (boardId) => [
      makeNode(
        boardId,
        "terminal",
        "终端",
        { x: 120, y: 120 },
        { width: 520, height: 300 },
        { kind: "terminal", cwd: natProject },
      ),
    ],
  );
  run.ok("NAT 后的 core 登记到中继、隧道 ready", natId);

  // 第二台 core：浏览器节点要它自己的 headless Chromium。
  const chromePath =
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  direct = await timed("1-server", () =>
    startPlainCore({
      scratch: stack.scratch,
      tag: "srv",
      extraEnv: existsSync(chromePath)
        ? { ARMADRA_BROWSER_PATH: chromePath }
        : {},
    }),
  );
  secret("第二台 core 本机会话", direct.session.headers.authorization.slice(7));
  const server = ownerClient(direct.session);
  const serverRegistered = await timed("1-register-server", () =>
    registerSource({
      relay,
      core: server,
      label: "server-host",
      onSecret: secret,
    }),
  );
  const serverId = serverRegistered.sourceId;

  // 浏览器节点打开的页面：本机回环上一张整块蓝色的页。
  pageServer = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      '<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;background:#1d4ed8;color:#fff;font:40px sans-serif" onclick="document.body.style.background=\'#dc2626\'">relay</body>',
    );
  });
  await new Promise((done) => pageServer.listen(0, "127.0.0.1", done));
  const pageUrl = `http://127.0.0.1:${pageServer.address().port}/`;

  const serverProject = join(stack.scratch, "server-project");
  mkdirSync(serverProject, { recursive: true });
  copyFileSync(
    join(root, "tools/probes/fixtures/clip-h264.mp4"),
    join(serverProject, "clip.mp4"),
  );
  writeFileSync(join(serverProject, "notes.md"), "# relay\n\nTODO keep\n");
  const serverSeed = await seedWorkspace(
    server.owner,
    "server-workspace",
    serverProject,
    (boardId) => [
      makeNode(
        boardId,
        "terminal",
        "终端",
        { x: 120, y: 120 },
        { width: 520, height: 300 },
        { kind: "terminal", cwd: serverProject },
      ),
      makeNode(
        boardId,
        "editor",
        "clip.mp4",
        { x: 700, y: 120 },
        { width: 480, height: 320 },
        { kind: "editor", path: "clip.mp4" },
      ),
      makeNode(
        boardId,
        "browser",
        "浏览器",
        { x: 120, y: 520 },
        { width: 560, height: 360 },
        { kind: "browser", url: pageUrl },
      ),
    ],
  );
  const [serverTerminal, serverEditor, serverBrowser] = serverSeed.nodes;
  // 语言服务器：markdown 用 mock（一行 TODO 一条诊断）。开会话只认探测过的结果。
  await server.owner("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({
      language: {
        servers: {
          marksman: {
            path: process.execPath,
            args: [join(root, "tools/probes/mock-lsp.mjs")],
          },
        },
      },
    }),
  });
  await server.owner(
    `/api/workspaces/${serverSeed.workspace.id}/language-service`,
  );
  run.ok("第二台 core 登记到中继、隧道 ready，有自己的工作空间", serverId);

  electron = await timed("1-electron", () =>
    launchElectron({ scratch: stack.scratch, tag: "multi" }),
  );
  const win = electron.page;
  const local = ownerClient(electron.session);
  const localProject = join(stack.scratch, "local-project");
  const localSeed = await seedWorkspace(
    local.owner,
    "local-workspace",
    localProject,
    (boardId) => [
      makeNode(
        boardId,
        "terminal",
        "终端",
        { x: 120, y: 120 },
        { width: 520, height: 300 },
        { kind: "terminal", cwd: localProject },
      ),
    ],
  );

  const remote = await local.rpc("sources.remoteAdd", {
    kind: "personal",
    issuer: relay.issuer,
    account: relay.account,
    password,
    fingerprint: relay.fingerprint,
  });
  for (const [sourceId, label] of [
    [natId, "nat-host"],
    [serverId, "server-host"],
  ]) {
    const mounted = await local.rpc("sources.mount", {
      serviceId: remote.remote.serviceId,
      sourceId,
      label,
    });
    run.check(
      mounted.kind === "relayed",
      `桌面 core 经中继挂载 ${label}（relayed）`,
      { kind: mounted.kind },
    );
  }
  await reloadAfterMount(win);
  await win.capture(join(output, "01-desktop-loaded.png"));

  /* ----------------------------- 页面小工具 ----------------------------- */
  const group = (id) => `[data-source-group="${id}"]`;
  const groupState = (id) =>
    win.evaluate(
      `const g = document.querySelector('${group(id)}');
       return g ? { state: g.getAttribute("data-state"), dimmed: Number(getComputedStyle(g).opacity) < 1 } : null;`,
    );
  const groupsNow = () =>
    win.evaluate(
      `return [...document.querySelectorAll("[data-source-group]")].map((g) => g.getAttribute("data-source-group"));`,
    );
  const seenGroups = new Set();
  const noteGroups = async () => {
    for (const id of await groupsNow()) seenGroups.add(id);
  };
  const waitGroupReady = (id, workspaceId, what, timeout = 90_000) =>
    win.until(
      `return !!document.querySelector('${group(id)}[data-state="ready"] [data-source-workspace="${workspaceId}"]')`,
      what,
      { timeout },
    );
  const openFromGroup = async (id, workspaceId, what) => {
    await waitGroupReady(id, workspaceId, `${what}：组就绪并列出工作空间`);
    await noteGroups();
    await win.clickOn(
      `return document.querySelector('${group(id)} [data-source-workspace="${workspaceId}"]')`,
      what,
    );
  };

  /* ---------------------- 2. 侧栏：本机在树里，两个经中继的源各一组 ---------------------- */
  await waitGroupReady(natId, natSeed.workspace.id, "NAT 组就绪");
  await waitGroupReady(serverId, serverSeed.workspace.id, "服务器组就绪").catch(
    async (error) => {
      throw new Error(
        `服务器组没有就绪：${JSON.stringify(await groupState(serverId))}（${error.message}）`,
      );
    },
  );
  const present = (await groupsNow()).sort();
  run.check(
    JSON.stringify(present) === JSON.stringify([natId, serverId].sort()),
    "当前源是本机：侧栏里两个经中继的源各一组，各列出自己的工作空间",
    present,
  );
  await win.capture(join(output, "02-sidebar-groups.png"));
  await noteGroups();

  /* -------------------- 3. 每个源各开一个终端并回显 -------------------- */
  await openFromGroup(serverId, serverSeed.workspace.id, "服务器组的工作空间");
  await terminalInPage(win, serverTerminal.id, "server");
  run.ok("经中继的第二台 core：开终端并回显（42server）");
  await win.capture(join(output, "03-server-terminal.png"));

  /* --------------- 4. 媒体经中继：<video src> 是中继票、Range 回 206 --------------- */
  const video = await timed("4-media", () =>
    win.until(
      `const video = document.querySelector('${nodeAt(serverEditor.id)} video');
       if (!video) return null;
       return video.readyState >= 1 && video.duration > 0
         ? { src: video.getAttribute("src"), duration: video.duration, readyState: video.readyState }
         : null;`,
      "服务器组里的视频经中继取到元数据",
      { timeout: 60_000 },
    ),
  ).catch(async (error) => {
    report.videoFailure = await win
      .evaluate(
        `const node = document.querySelector('${nodeAt(serverEditor.id)}');
         const video = node?.querySelector("video");
         return {
           text: node?.innerText?.slice(0, 300) ?? null,
           src: video?.getAttribute("src") ?? null,
           readyState: video?.readyState ?? null,
           error: video?.error ? { code: video.error.code, message: video.error.message } : null,
           resources: performance.getEntriesByType("resource")
             .filter((entry) => entry.name.includes("/_relay/") || entry.name.includes("/api/media/") || entry.name.includes("mediaTicket"))
             .map((entry) => ({ name: entry.name.replace(/[A-Za-z0-9_-]{43}/, "<票>"), status: entry.responseStatus })),
         };`,
      )
      .catch((cause) => String(cause));
    report.videoFailure.error = error.message;
    return null;
  });
  const relayMedia = new RegExp(`/s/${serverId}/_relay/m/[A-Za-z0-9_-]{43}$`);
  await win.capture(join(output, "04-relayed-video.png"));
  const route = await relayedRoute({
    relay,
    cloudToken: serverRegistered.cloudToken,
    sourceId: serverId,
    device: { platform: "desktop", name: "multi-source-probe" },
    onSecret: secret,
  });
  const coreTicket = await route.api("POST", "/api/rpc/files/mediaTicket", {
    json: { workspaceId: serverSeed.workspace.id, path: "clip.mp4" },
  });
  const relayTicket = await relay.must(
    "POST",
    `${route.base}/_relay/media-tickets`,
    {
      body: { path: coreTicket.json.url },
      headers: { "armadra-relay-token": route.relayToken },
    },
  );
  const ranged = await route.raw("GET", `${route.base}${relayTicket.path}`, {
    range: "bytes=0-1023",
  });
  run.check(
    ranged.status === 206 &&
      ranged.headers["content-range"] ===
        `bytes 0-1023/${coreTicket.json.size}` &&
      ranged.headers["content-type"] === "video/mp4" &&
      ranged.headers["accept-ranges"] === "bytes",
    "不带任何头按中继票取 Range：经中继回 206、Content-Range 与真实类型",
    {
      status: ranged.status,
      range: ranged.headers["content-range"],
      type: ranged.headers["content-type"],
    },
  );
  const bogus = await route.raw(
    "GET",
    `${route.base}/_relay/m/${"A".repeat(43)}`,
  );
  run.check(bogus.status === 404, "不认识的中继票 404", bogus.status);
  // 页面那一侧放在协议这一侧之后断言：失败时先知道票经中继兑不兑得出来。
  run.check(
    video !== null &&
      relayMedia.test(video.src ?? "") &&
      !(video.src ?? "").includes("clip") &&
      video.duration > 0,
    "编辑器的 <video src> 是中继的媒体票地址（不含文件路径），按 Range 取到元数据",
    video === null
      ? report.videoFailure
      : { duration: video.duration, readyState: video.readyState },
  );

  /* -------------------- 5. 语言会话经中继：诊断往返、断开后重开 -------------------- */
  const languageRound = async (tag) => {
    const opened = await route.api(
      "POST",
      `/api/workspaces/${serverSeed.workspace.id}/language/sessions`,
      {
        languageId: "markdown",
        clientId: `multi-${tag}-${randomBytes(3).toString("hex")}`,
      },
    );
    if (opened.state === "unsupported")
      throw new Error(`语言会话不可用：${opened.reason}`);
    const socket = route.socket(
      `/api/workspaces/${serverSeed.workspace.id}/language/sessions/${opened.sessionId}/stream`,
      await route.protocols(),
    );
    sockets.push(socket);
    await socketOpened(socket);
    const diagnostics = new Promise((done) => {
      socket.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        if (message.method === "textDocument/publishDiagnostics")
          done(message.params);
      });
    });
    const send = (message) =>
      socket.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
    send({
      id: 1,
      method: "initialize",
      params: { processId: null, rootUri: "armadra:///", capabilities: {} },
    });
    send({ method: "initialized", params: {} });
    send({
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: "armadra:///notes.md",
          languageId: "markdown",
          version: 1,
          text: `# relay ${tag}\n\nTODO keep\n`,
        },
      },
    });
    const published = await Promise.race([
      diagnostics,
      sleep(30_000).then(() => {
        throw new Error(`语言会话 ${tag}：30 秒没有诊断`);
      }),
    ]);
    socket.close();
    return { sessionId: opened.sessionId, published };
  };
  const firstLanguage = await timed("5-language", () => languageRound("a"));
  run.check(
    firstLanguage.published.uri === "armadra:///notes.md" &&
      firstLanguage.published.diagnostics?.length === 1 &&
      firstLanguage.published.diagnostics[0].source === "mock-lsp",
    "语言会话经中继：initialize + didOpen 之后诊断回来（uri 仍是 armadra:///）",
    { diagnostics: firstLanguage.published.diagnostics?.length },
  );
  const secondLanguage = await languageRound("b");
  run.check(
    secondLanguage.sessionId !== firstLanguage.sessionId &&
      secondLanguage.published.diagnostics?.length === 1,
    "流断开之后新开一条会话照样往返（页面断线后重开的那一步）",
    {
      first: firstLanguage.sessionId.slice(0, 8),
      second: secondLanguage.sessionId.slice(0, 8),
    },
  );

  /* -------------------- 6. 浏览器画面经中继：点击过去、新帧回来 -------------------- */
  const browserSocket = route.socket(
    `/api/workspaces/${serverSeed.workspace.id}/browser/${serverBrowser.id}/stream`,
    await route.protocols(),
  );
  sockets.push(browserSocket);
  await socketOpened(browserSocket);
  const frames = [];
  let streamError = null;
  let header = null;
  browserSocket.on("message", (data, isBinary) => {
    if (!isBinary) {
      try {
        const message = JSON.parse(String(data));
        if (message.type === "frame") header = message;
        else if (message.type === "error") streamError = message.code;
      } catch {
        /* 认不出的帧不算 */
      }
      return;
    }
    if (header) frames.push({ ...header, received: data.length });
    header = null;
  });
  browserSocket.send(
    JSON.stringify({ type: "viewport", width: 640, height: 400 }),
  );
  const firstFrame = await timed("6-browser", () =>
    until(
      () => {
        if (streamError) throw new Error(`画面流报错：${streamError}`);
        return frames.find((frame) => frame.received > 0) ?? null;
      },
      "经中继收到浏览器节点的第一帧",
      { timeout: 60_000, every: 200 },
    ),
  );
  // 输入经隧道过去：点一下页面（整块变红），新的一帧经隧道回来。
  for (const action of ["down", "up"])
    browserSocket.send(
      JSON.stringify({ type: "mouse", action, x: 100, y: 100, button: "left" }),
    );
  const repainted = await until(
    () => frames.find((frame) => frame.seq > firstFrame.seq) ?? null,
    "点击之后经中继收到新的一帧",
    { timeout: 30_000, every: 200 },
  ).catch((error) => {
    report.browserFrames = frames.slice(-10);
    throw error;
  });
  run.check(
    firstFrame.received > 0 && repainted.received > 0,
    "浏览器画面经中继往返：帧经隧道到达，点击经隧道回去、页面重画后的新帧再到达",
    {
      first: `${firstFrame.width}×${firstFrame.height}#${firstFrame.seq}`,
      next: `#${repainted.seq}`,
      frames: frames.length,
    },
  );
  browserSocket.close();

  await openFromGroup(natId, natSeed.workspace.id, "NAT 组的工作空间");
  await terminalInPage(win, natSeed.nodes[0].id, "relayed");
  run.ok("经中继的 NAT 源：开终端并回显（42relayed）");
  await win.capture(join(output, "03-relayed-terminal.png"));

  // 当前源在经中继那边：本机成了一组。
  // 本机那一组的 id 是页面里本机源的描述符（不一定等于主机 id）：不是另两个的那一组。
  const localGroupId = await win.until(
    `const ids = [...document.querySelectorAll("[data-source-group]")].map((g) => g.getAttribute("data-source-group"));
     return ids.find((id) => id !== ${JSON.stringify(natId)} && id !== ${JSON.stringify(serverId)}) ?? null;`,
    "当前源换走后本机成为一组",
    { timeout: 30_000 },
  );
  await openFromGroup(
    localGroupId,
    localSeed.workspace.id,
    "本机成为一组后点它的工作空间",
  );
  await terminalInPage(win, localSeed.nodes[0].id, "local");
  run.ok("本机源：开终端并回显（42local）");
  await win.capture(join(output, "03-local-terminal.png"));
  run.check(
    [localGroupId, natId, serverId].every((id) => seenGroups.has(id)),
    "三个源都在侧栏里当过一组",
    [...seenGroups],
  );

  /* ------------- 7. NAT 的源下线：灰显、本机终端仍可输入 ------------- */
  const offlineAt = Date.now();
  await stack.killCore();
  const gone = await win.until(
    `const g = document.querySelector('${group(natId)}');
     if (!g) return null;
     const state = g.getAttribute("data-state");
     const dimmed = Number(getComputedStyle(g).opacity) < 1;
     return state !== "ready" && state !== "connecting" && dimmed ? { state } : null;`,
    "NAT 组灰显、状态不再就绪",
    { timeout: 60_000 },
  );
  report.timings["7-offline-detect"] = Date.now() - offlineAt;
  run.ok("NAT 的源下线：那一组灰显", gone);
  await win.capture(join(output, "07-relayed-offline.png"));
  const serverDuring = await groupState(serverId);
  run.check(
    serverDuring?.state === "ready" && !serverDuring.dimmed,
    "服务器组不受影响，仍是就绪",
    serverDuring,
  );
  await terminalInPage(win, localSeed.nodes[0].id, "local2");
  run.ok("本机终端仍可输入并回显（42local2）");

  /* ------------------------------ 8. 重连后恢复 ------------------------------ */
  const backAt = Date.now();
  await stack.startCore();
  await win.until(
    `const g = document.querySelector('${group(natId)}[data-state="ready"]');
     return g && Number(getComputedStyle(g).opacity) === 1 ? true : null;`,
    "NAT 组恢复就绪、不再灰显",
    { timeout: 90_000 },
  );
  report.timings["8-reconnect"] = Date.now() - backAt;
  run.ok("重连后恢复：NAT 组就绪、不再灰显");
  await waitGroupReady(natId, natSeed.workspace.id, "恢复后仍列出工作空间");
  await openFromGroup(natId, natSeed.workspace.id, "恢复后点 NAT 组的工作空间");
  await terminalInPage(win, natSeed.nodes[0].id, "relayed2");
  run.ok("恢复后经中继的终端又能收发（42relayed2）");
  await win.capture(join(output, "08-relayed-recovered.png"));
  run.check(
    win.problems.length === 0,
    "桌面页面无异常",
    win.problems.slice(0, 5),
  );

  const leaks = ledger.scan({
    relay: relay.logs(),
    nat: stack.coreLog(),
    second: direct.log(),
    electron: electron.log(),
    probe: ledger.printed(),
  });
  run.check(
    leaks.length === 0,
    "中继、两台 core、Electron 与探针的日志里没有口令与令牌",
    { secrets: ledger.secrets.size, leaks },
  );
  const ticketInLogs = [
    relay.logs(),
    stack.coreLog(),
    direct.log(),
    electron.log(),
  ].some(
    (text) =>
      text.includes(relayTicket.ticket) ||
      text.includes(coreTicket.json.url.slice(11)),
  );
  run.check(!ticketInLogs, "媒体票（中继的与 core 的）不进任何日志");
  run.entry.status = "ok";
  report.status = "ok";
} catch (error) {
  report.error =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`  FAIL  ${report.error}`);
  if (electron?.page) {
    await electron.page
      .capture(join(output, "zz-failure-desktop.png"))
      .catch(() => undefined);
    report.electronLog = electron.log().slice(-3000);
    report.pageProblems = (electron.page.problems ?? []).slice(0, 10);
    report.bodyText = await electron.page
      .evaluate("return document.body.innerText.slice(0, 1500)")
      .catch(() => undefined);
  }
  try {
    report.localWorkspaces = (
      await ownerClient(electron.session).owner("/api/workspaces")
    ).map((one) => one.name);
  } catch {
    /* core 已经不在：没有可补的。 */
  }
  if (relay) report.relayLog = relay.logs().slice(-3000);
  if (direct) report.directLog = direct.log().slice(-2000);
  if (stack) report.natLog = stack.coreLog().slice(-3000);
} finally {
  report.timings.totalMs = Date.now() - started;
  for (const socket of sockets) socket.terminate?.();
  pageServer?.close();
  await electron?.stop().catch(() => {});
  await direct?.stop().catch(() => {});
  await relay?.stop().catch(() => {});
  await stack?.stop();
  writeResult(output, report);
  console.log(`  报告  ${join(output, "result.json")}`);
  process.exit(report.status === "ok" ? 0 : 1);
}
