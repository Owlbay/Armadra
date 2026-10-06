// Git 托管面板与「Git 托管」设置页（契约 §29，G5-15）的真机截图探针。
//
// 起的东西：临时数据目录里的 core（`apps/desktop/out/core/main.js`）、一个回放
// GitLab 夹具（`apps/desktop/src/core/forge/fixtures/gitlab/*.json`）的本机假
// GitLab、Vite 开发服务器与新 profile 的无头 Chrome。`ARMADRA_DEV_STACK=1` 时
// 再对 dev-stack 的真 Gitea（`pnpm dev-stack up gitea`）现建一个令牌与私有仓库
// （一个分支、一个 PR、一条 commit status、一个 issue），跑完删掉。
//
// 配置走 core 的 `/api/forge/configs`（令牌是这次现建的测试令牌，只进临时数据
// 目录的 0600 文件后端）。页面里的 GitHub 会话直接置成「就绪」：这里要看的是
// 托管平台那一面对着真 core 的渲染，会话握手由别的探针管。
//
// 一切都是临时的、回环的：随机端口（不用 1420 / 1421 / 43120 / 43121）、
// mktemp 出来的数据目录、HOME 与浏览器 profile。不读写操作员自己的数据目录、
// 凭据或任何外部服务。
//
// 用法（仓库根目录）：
//   pnpm --filter @armadra/desktop build
//   [ARMADRA_DEV_STACK=1] node tools/probes/forge-panel.mjs [输出目录]
//
// 产物（默认 target/forge-panel/）：settings.png、gitlab-list.png、
// gitlab-detail.png（CI 汇总徽标、合并方式、流水线通过后合并、检出）、
// gitlab-auto-merge.png（确认框）、gitlab-merged.png（合并后清理）、
// gitlab-subgroup.png（多级子组）、gitlab-issues.png、unknown.png，有 Gitea
// 时再加 gitea-list.png、gitea-detail.png；以及 result.json。
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnv, probeHome } from "./probe-home.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(process.argv[2] ?? join(root, "target/forge-panel"));
mkdirSync(output, { recursive: true });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const cleanups = [];
const report = { status: "failed", steps: [], shots: {}, output };
const probeHtml = join(root, "apps/web/forge-panel-probe.html");
const probeEntry = join(root, "apps/web/src/forge-panel-probe.tsx");

function step(name, detail = "") {
  report.steps.push({ name, detail });
  console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return [1420, 1421, 43120, 43121].includes(port) ? freePort() : port;
}

/* ------------------------------ 假 GitLab --------------------------------- */

/** 回放夹具：按方法与路径匹配，查询键全对上的优先；起了名字的拒绝录像不答。 */
async function startFakeGitlab() {
  const directory = join(root, "apps/desktop/src/core/forge/fixtures/gitlab");
  const interactions = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .flatMap(
      (name) =>
        JSON.parse(readFileSync(join(directory, name), "utf8")).interactions,
    )
    .filter((entry) => entry.name === undefined);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fake");
    const raw = (request.url ?? "/").split("?")[0];
    const path = raw.startsWith("/api/v4") ? raw.slice("/api/v4".length) : raw;
    const query = Object.fromEntries(url.searchParams.entries());
    const candidates = interactions.filter(
      (entry) =>
        entry.request.method === request.method && entry.request.path === path,
    );
    const exact = candidates.filter((entry) =>
      Object.entries(entry.request.query ?? {}).every(
        ([key, value]) => query[key] === value,
      ),
    );
    const chosen =
      exact.sort(
        (a, b) =>
          Object.keys(b.request.query ?? {}).length -
          Object.keys(a.request.query ?? {}).length,
      )[0] ?? candidates[0];
    request.resume();
    if (!chosen || request.headers["private-token"] === undefined) {
      response.writeHead(chosen ? 401 : 404, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ message: chosen ? "401" : "404" }));
      return;
    }
    const headers = { ...chosen.response.headers };
    delete headers.link;
    response.writeHead(chosen.response.status, headers);
    response.end(JSON.stringify(chosen.response.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => server.close());
  return server.address().port;
}

/* -------------------------------- 真 Gitea -------------------------------- */

async function seedGitea() {
  if (process.env.ARMADRA_DEV_STACK !== "1") return null;
  const base = (process.env.ARMADRA_GITEA_URL ?? "http://127.0.0.1:3000")
    .trim()
    .replace(/\/+$/, "");
  const envFile = join(root, "tools/dev-stack/.data/dev.env");
  const password =
    process.env.GITEA_ADMIN_PASSWORD?.trim() ||
    (existsSync(envFile)
      ? (readFileSync(envFile, "utf8")
          .split("\n")
          .find((line) => line.startsWith("GITEA_ADMIN_PASSWORD="))
          ?.slice("GITEA_ADMIN_PASSWORD=".length)
          .trim() ?? "")
      : "");
  if (!password)
    throw new Error("没有 GITEA_ADMIN_PASSWORD：先 pnpm dev-stack up gitea");
  const admin = "armadra-dev";
  const basic = `Basic ${Buffer.from(`${admin}:${password}`).toString("base64")}`;
  const call = async (method, path, body, auth = basic) => {
    const answer = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        authorization: auth,
        "content-type": "application/json",
        accept: "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await answer.text();
    if (!answer.ok) throw new Error(`${method} ${path}: ${answer.status}`);
    return text === "" ? undefined : JSON.parse(text);
  };
  const suffix = randomBytes(4).toString("hex");
  const repo = `forge-panel-${suffix}`;
  const tokenName = `armadra-forge-panel-${suffix}`;
  const token = (
    await call("POST", `/users/${admin}/tokens`, {
      name: tokenName,
      scopes: ["write:repository", "write:issue", "read:user"],
    })
  ).sha1;
  cleanups.push(async () => {
    await call("DELETE", `/repos/${admin}/${repo}`).catch(() => undefined);
    await call("DELETE", `/users/${admin}/tokens/${tokenName}`).catch(
      () => undefined,
    );
  });
  const auth = `token ${token}`;
  await call("POST", "/user/repos", {
    name: repo,
    auto_init: true,
    default_branch: "main",
    private: true,
  });
  await call(
    "POST",
    `/repos/${admin}/${repo}/branches`,
    { new_branch_name: "feature/login", old_branch_name: "main" },
    auth,
  );
  const written = await call(
    "POST",
    `/repos/${admin}/${repo}/contents/src/login.ts`,
    {
      branch: "feature/login",
      message: "feat: two-step login",
      content: Buffer.from(
        "export const step = 2;\nexport const total = 2;\n",
      ).toString("base64"),
    },
    auth,
  );
  await call(
    "POST",
    `/repos/${admin}/${repo}/statuses/${written.commit.sha}`,
    { state: "success", context: "ci/build", target_url: `${base}/ci/1` },
    auth,
  );
  await call(
    "POST",
    `/repos/${admin}/${repo}/issues`,
    { title: "Login button misaligned", body: "Steps attached." },
    auth,
  );
  await call(
    "POST",
    `/repos/${admin}/${repo}/pulls`,
    {
      title: "Two-step login",
      body: "Split the login page.",
      head: "feature/login",
      base: "main",
    },
    auth,
  );
  return { base, admin, repo, token };
}

/* ---------------------------------- 主流程 -------------------------------- */

async function main() {
  const binary = join(root, "apps/desktop/out/core/main.js");
  if (!existsSync(binary))
    throw new Error(
      `core 未构建：${binary}。先跑 pnpm --filter @armadra/desktop build`,
    );
  const scratch = mkdtempSync(join(tmpdir(), "armadra-forge-panel-"));
  cleanups.push(() =>
    rmSync(scratch, { recursive: true, force: true, maxRetries: 20 }),
  );
  const project = join(scratch, "project");
  mkdirSync(project, { recursive: true });
  const data = join(scratch, "runtime");
  mkdirSync(data, { recursive: true });

  const gitlabPort = await startFakeGitlab();
  step("假 GitLab 已启动", `http://localhost:${gitlabPort}/api/v4`);
  const gitea = await seedGitea();
  if (gitea) step("dev-stack Gitea 已预置", `${gitea.admin}/${gitea.repo}`);

  const home = probeHome("armadra-forge-panel-home-");
  cleanups.push(home.remove);
  const environment = isolatedEnv(home, {
    ARMADRA_DATA_DIR: data,
    ARMADRA_SECRET_BACKEND: "file",
    ARMADRA_LOOPBACK_OWNER: "1",
    ARMADRA_LOG: process.env.ARMADRA_LOG ?? "warn",
  });
  const runtime = spawn(
    process.execPath,
    [binary, "--listen", "tcp:127.0.0.1:0", "--data-dir", data],
    { cwd: root, stdio: ["ignore", "ignore", "pipe"], env: environment },
  );
  cleanups.push(() => runtime.kill("SIGKILL"));
  let diagnostics = "";
  runtime.stderr.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-4096);
  });
  let origin = "";
  for (let attempt = 0; attempt < 300 && !origin; attempt += 1) {
    if (runtime.exitCode !== null) throw new Error(`core 退出：${diagnostics}`);
    try {
      origin = JSON.parse(readFileSync(join(data, "endpoints.json"), "utf8"))
        .runtime.http;
    } catch {
      await sleep(100);
    }
  }
  const api = async (method, path, body) => {
    const answer = await fetch(new URL(path, origin), {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await answer.text();
    if (!answer.ok)
      throw new Error(`${method} ${path}: ${answer.status} ${text}`);
    return text === "" ? undefined : JSON.parse(text);
  };
  step("core 已启动", origin);
  const workspace = await api("POST", "/api/workspaces", {
    name: "probe",
    rootPath: project,
    permissions: { read: true, write: true, execute: true },
  });
  step("工作空间已建立", workspace.id);

  await api("PUT", "/api/forge/configs/localhost", {
    forge: "gitlab",
    apiBase: `http://localhost:${gitlabPort}`,
    token: "glpat-probe-fixture",
  });
  step("GitLab 已配置", "localhost → 回放夹具");
  if (gitea) {
    await api(
      "PUT",
      `/api/forge/configs/127.0.0.1/${gitea.admin}/${gitea.repo}`,
      {
        forge: "gitea",
        apiBase: gitea.base,
        token: gitea.token,
      },
    );
    step("Gitea 已配置", `127.0.0.1/${gitea.admin}/${gitea.repo}`);
  }
  // 一行没令牌的主机配置，好让设置页两种状态都有。
  await api("PUT", "/api/forge/configs/git.example.test", {
    forge: "gitea",
    apiBase: "https://git.example.test",
  });

  /* ------------------------------ 临时页面入口 --------------------------- */

  writeFileSync(
    probeHtml,
    `<!doctype html><html lang="zh-CN" data-theme="dark"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Forge probe</title></head><body><div id="root"></div><script type="module" src="/src/forge-panel-probe.tsx"></script></body></html>\n`,
  );
  writeFileSync(
    probeEntry,
    `import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles/app.css";
import { runtimeApi } from "./api/client";
import { GithubApi } from "./api/github";
import { TooltipProvider } from "./ui/tooltip";
import { Toaster } from "./ui/sonner";
import { useCanvasStore } from "./store/canvas-store";
import { useGithubSession } from "./host/github-session";
import { GithubDrawer } from "./panels/github/GithubDrawer";
import { GithubPage } from "./panels/settings/pages/GithubPage";

const [summary] = await runtimeApi.listWorkspaces();
const workspace = await runtimeApi.openWorkspace(summary!.id);
const view = (window as unknown as { __forgeView?: string }).__forgeView ?? "panel";
useCanvasStore.setState((state) => ({
  workspace,
  panels: { ...state.panels, github: view === "panel" ? "drawer" : "closed" },
}));
const client = new GithubApi({ workspaceId: workspace.id });
useGithubSession.setState({
  client,
  connect: async () => {},
  state: {
    status: "blocked",
    reason: "noCredential",
    canWrite: true,
  },
});
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    <TooltipProvider delayDuration={0}>
      <div className="h-screen bg-background text-foreground">
        {view === "settings" ? (
          <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
            <GithubPage />
          </div>
        ) : (
          <GithubDrawer />
        )}
      </div>
      <Toaster />
    </TooltipProvider>
  </QueryClientProvider>,
);
`,
  );
  cleanups.push(() => rmSync(probeHtml, { force: true }));
  cleanups.push(() => rmSync(probeEntry, { force: true }));

  /* ---------------------------- Vite 开发服务器 -------------------------- */

  const port = await freePort();
  const vite = spawn(
    "pnpm",
    [
      "--filter",
      "@armadra/web",
      "exec",
      "vite",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...environment, ARMADRA_DATA_DIR: data },
    },
  );
  cleanups.push(() => vite.kill("SIGKILL"));
  let served = false;
  vite.stdout.on("data", (chunk) => {
    if (String(chunk).includes("ready in")) served = true;
  });
  const page = `http://127.0.0.1:${port}/forge-panel-probe.html`;
  for (let attempt = 0; attempt < 600 && !served; attempt += 1) {
    if (vite.exitCode !== null) throw new Error("Vite 退出");
    await sleep(100);
  }
  step("开发服务器已就绪", page);

  /* --------------------------------- Chrome ------------------------------ */

  const executable =
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(executable))
    throw new Error(`找不到 Chrome：${executable}（可用 CHROME_PATH 指定）`);
  const profile = mkdtempSync(join(tmpdir(), "armadra-forge-profile-"));
  cleanups.push(() =>
    rmSync(profile, { recursive: true, force: true, maxRetries: 20 }),
  );
  const browser = spawn(
    executable,
    [
      "--headless=new",
      "--use-mock-keychain",
      "--password-store=basic",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  cleanups.push(() => browser.kill("SIGKILL"));
  let devtools = "";
  for (let attempt = 0; attempt < 200 && !devtools; attempt += 1) {
    try {
      devtools = readFileSync(join(profile, "DevToolsActivePort"), "utf8")
        .split("\n")[0]
        .trim();
    } catch {
      await sleep(100);
    }
  }
  const target = await (
    await fetch(`http://127.0.0.1:${devtools}/json/new?about:blank`, {
      method: "PUT",
    })
  ).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, "open");
  cleanups.push(() => socket.close());
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") {
      errors.push(message.params.exceptionDetails?.text ?? "exception");
    }
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  });
  const call = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = (sequence += 1);
      pending.set(id, (message) =>
        message.error
          ? fail(new Error(message.error.message))
          : done(message.result),
      );
      socket.send(JSON.stringify({ id, method, params }));
    });
  const capture = async (name) => {
    const shot = await call("Page.captureScreenshot", { format: "png" });
    const file = join(output, `${name}.png`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    report.shots[name] = file;
    step(`截图 ${name}`, file);
  };
  const evaluate = async (expression) => {
    const answer = await call("Runtime.evaluate", {
      expression: `(async () => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (answer.exceptionDetails)
      throw new Error(answer.exceptionDetails.text ?? "页面表达式抛错");
    return answer.result.value;
  };
  const clickText = async (selector, text) => {
    const box = await evaluate(`
      const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .filter((element) => (element.textContent ?? "").includes(${JSON.stringify(text)}))
        .at(-1);
      if (!node) return null;
      node.scrollIntoView({ block: "center" });
      const rect = node.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    `);
    if (!box) throw new Error(`点不到「${text}」（${selector}）`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await call("Input.dispatchMouseEvent", {
        type,
        x: box.x,
        y: box.y,
        button: "left",
        clickCount: 1,
      });
    }
    await sleep(1500);
  };
  /** 等一段文字出现；没等到就失败，免得截一张空图。 */
  const waitText = async (text, ms = 10_000) => {
    for (let waited = 0; waited < ms; waited += 250) {
      const seen = await evaluate(
        `return document.body.innerText.includes(${JSON.stringify(text)});`,
      );
      if (seen) return;
      await sleep(250);
    }
    throw new Error(`没等到「${text}」`);
  };
  const resolveRemote = async (url) => {
    await evaluate(`
      const input = document.querySelector("form input");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, ${JSON.stringify(url)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    `);
    await clickText("button", "解析仓库");
  };
  const load = async (view) => {
    await call("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__forgeView = ${JSON.stringify(view)};`,
    });
    await call("Page.navigate", { url: page });
    await sleep(4000);
  };

  await call("Page.enable");
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });

  await load("settings");
  await waitText("其他平台");
  await waitText("localhost");
  await capture("settings");

  await load("panel");
  await resolveRemote(`http://localhost:${gitlabPort}/acme/app.git`);
  await waitText("Merge requests");
  await waitText("Fix header");
  await capture("gitlab-list");
  await clickText("[data-slot=forge-pull] button", "Draft: 登录改版");
  await waitText("src/login.ts");
  await clickText("summary", "src/login.ts");
  await waitText("流水线通过后合并");
  await capture("gitlab-detail");
  await clickText("[data-slot=forge-merge] button", "流水线通过后合并");
  await waitText("流水线通过后合并这个请求？");
  await capture("gitlab-auto-merge");
  await clickText('[role="alertdialog"] button', "取消");
  await clickText('button[aria-label="返回"]', "");
  // 状态过滤是 Radix 的 Select：真点开触发器再点选项。
  // 「已关闭」对 MR 按 state=all 取（含已合并），夹具里有这条录像。
  await clickText("[data-slot=forge-hosted] [role=combobox]", "");
  await clickText('[role="option"]', "已关闭");
  await waitText("Bump deps");
  await clickText("[data-slot=forge-pull] button", "Bump deps");
  await waitText("删除远端分支 · deps");
  await evaluate(`
    document.querySelector("[data-slot=github-cleanup]")?.scrollIntoView({ block: "end" });
    return true;
  `);
  await sleep(500);
  await capture("gitlab-merged");

  await load("panel");
  await resolveRemote(`http://localhost:${gitlabPort}/platform/web/app.git`);
  await waitText("子组里的改动");
  await capture("gitlab-subgroup");

  await load("panel");
  await resolveRemote(`http://localhost:${gitlabPort}/acme/app.git`);
  await waitText("Merge requests");
  await clickText('[role="tab"]', "Issues");
  await waitText("登录页按钮错位");
  await capture("gitlab-issues");

  if (gitea) {
    await load("panel");
    await resolveRemote(`${gitea.base}/${gitea.admin}/${gitea.repo}.git`);
    await waitText("Two-step login");
    await capture("gitea-list");
    await clickText("[data-slot=forge-pull] button", "Two-step login");
    await waitText("ci/build");
    await clickText("summary", "src/login.ts");
    await capture("gitea-detail");
  }

  await load("panel");
  await resolveRemote("https://code.example.test/acme/app.git");
  await waitText("这个远端没有识别出托管平台");
  await capture("unknown");

  if (errors.length > 0) throw new Error(`页面异常：${errors.join("；")}`);
  report.status = "ok";
}

try {
  await main();
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(`  FAIL  ${report.error}`);
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {}
  }
  writeFileSync(
    join(output, "result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`  报告  ${join(output, "result.json")}`);
  process.exit(report.status === "ok" ? 0 : 1);
}
