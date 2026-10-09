// 手机壳冒烟（补全计划 G3-1，B 档）：模拟器里的原生 App 走「连接 → 配对 → 画布」。
//
// 真进程：`apps/desktop/out/core/main.js` 以桌面模式起在临时数据目录上，经回环的
// `PUT /api/gateway` 打开 Gateway（本地 CA，只在回环上监听），铸一张配对票，把原生
// 深链 `armadra://pair?host=127.0.0.1%3A<端口>&ticket=…&fp=…` 交给模拟器里的 UI 用例：
//
//   * iOS：`xcodebuild test` 跑 `AppUITests`（XCUITest），模拟器与宿主共用回环；
//     链接经 `TEST_RUNNER_ARMADRA_PAIR_LINK` 交进去。
//   * Android：`adb reverse` 把模拟器的回环端口接到宿主，`connectedDebugAndroidTest`
//     跑 `ConnectFlowTest`（插桩），链接经插桩参数 `armadraPairLink` 交进去。
//
// UI 用例在连接页填链接、点「连接」：原生先取 `/ca.crt` 按指纹钉住信任锚（App 不装
// CA），再用票配对拿 Bearer 会话，页面进画布（底部导航出现）——之后页面的 fetch 与
// WebSocket 都经钉扎过的 TLS 走 Gateway。
//
// 配对之后再两条（G5-22）：
//
//   * 原生 OAuth 的深链 `armadra://oauth?state=…&code=…`（R-56）：App 把它写进 `#link=`
//     重载，入口在挂载前向 core 收尾，结果写成 `#oauth=` 打开「账号与安全」页。Android 用例
//     先在页面里记一条假的挂起流程，再以深链冷启动 App，断言收尾请求发了（记录取走）、
//     「账号与安全」页打开；iOS 用例经深链打开、断言 App 仍在已连接的界面上。
//   * 图片带 Bearer（R-55，只 Android）：探针经回环上传一张 PNG 资产，用例在页面里断言
//     直接 `<img>` 取不到（401）、带上 Keystore 里这台 Gateway 的访问密钥再 `fetch` 取得到
//     （`useAssetUrl` 经本机源的 fetch 走的那条；页面不再改写全局 fetch）。
//
// 前置（仓库根目录）：
//   pnpm libs:build && pnpm --filter @armadra/desktop build && pnpm --filter @armadra/web build
//   pnpm --filter @armadra/mobile sync
//   iOS：Xcode 与一台可用的 iOS 模拟器；Android：已起的模拟器（adb 看得到）与 JDK 21
//
// 用法：
//   node tools/probes/mobile-shell-e2e.mjs --platform ios [--device "iPhone 16"|auto] [输出目录]
//   node tools/probes/mobile-shell-e2e.mjs --platform android [输出目录]
//
// 产物：<输出目录>/result.json，默认 target/mobile-shell-e2e/。一切都是临时的、回环的；
// core 用临时 HOME（`probe-home.mjs`），不读操作员的 CLI 登录状态。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnv, probeHome } from "./probe-home.mjs";
import { harness } from "./shell-e2e-lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const value = args[at + 1];
  args.splice(at, 2);
  return value;
};
const platform = option("--platform", "ios");
const device = option("--device", "auto");
if (platform !== "ios" && platform !== "android") {
  console.error(`--platform 只认 ios / android，收到 ${platform}`);
  process.exit(2);
}
const output = resolve(
  args[0] ?? join(root, `target/mobile-shell-e2e/${platform}`),
);
mkdirSync(output, { recursive: true });
const h = harness(output);
// 临时 HOME 只给 core：xcodebuild / Gradle 是工具链，照常用自己的缓存。
const home = probeHome("armadra-mobile-e2e-home-");
h.cleanups.push(home.remove);
const { report, step, temp } = h;
report.platform = platform;
report.failures = [];

function check(ok, name, detail = "") {
  if (ok) step(name, detail);
  else {
    report.failures.push({ name, detail });
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
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
                "content-length": Buffer.byteLength(payload),
              },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          done({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    client.on("error", failed);
    if (payload !== undefined) client.write(payload);
    client.end();
  });
}

const webDist = join(root, "apps/web/dist");

async function startCore(dataDir) {
  const entry = join(root, "apps/desktop/out/core/main.js");
  const child = spawn(
    process.execPath,
    [entry, "--listen", "tcp:127.0.0.1:0", "--data-dir", dataDir],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: isolatedEnv(home, {
        ARMADRA_CORE: "ts",
        ARMADRA_NO_GLOBAL_WRITES: "1",
        ARMADRA_SECRET_BACKEND: "file",
        ARMADRA_GATEWAY_WEB_ROOT: webDist,
      }),
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

/** 跑一个命令，输出落进 <输出目录>/<name>.log，返回退出码。 */
function run(name, command, commandArgs, options = {}) {
  return new Promise((done) => {
    const log = join(output, `${name}.log`);
    const chunks = [];
    const child = spawn(command, commandArgs, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", (error) => {
      chunks.push(Buffer.from(String(error)));
      writeFileSync(log, Buffer.concat(chunks));
      done(-1);
    });
    child.on("exit", (code) => {
      writeFileSync(log, Buffer.concat(chunks));
      done(code ?? -1);
    });
  });
}

/** `auto`：最新 iOS 运行时里第一台可用的 iPhone 模拟器。 */
function simulator(name) {
  if (name !== "auto") return name;
  const listed = spawnSync(
    "xcrun",
    ["simctl", "list", "devices", "available", "--json"],
    { encoding: "utf8", timeout: 120_000 },
  );
  if (listed.status !== 0)
    throw new Error(
      `xcrun simctl 不可用（${listed.error?.message ?? listed.stderr}）：Xcode 的模拟器组件没装好`,
    );
  const runtimes = Object.entries(JSON.parse(listed.stdout).devices ?? {})
    .filter(([runtime]) => runtime.includes("iOS"))
    .sort(([a], [b]) => b.localeCompare(a, "en", { numeric: true }));
  for (const [, devices] of runtimes) {
    const phone = devices.find((entry) => entry.name.startsWith("iPhone"));
    if (phone) return phone.name;
  }
  throw new Error("没有可用的 iPhone 模拟器");
}

const UI_TEST = "AppUITests/ConnectFlowUITests";

/** 配对票只有两分钟：先把要编译的都编完、跑完「没有 Gateway」那条，再现铸一张。 */
async function ios(mint) {
  const target = simulator(device);
  step("iOS 模拟器", target);
  // 先自己起好：xcodebuild 跑完不关它，之后才读得到 App 的设备日志。
  await run("simulator-boot", "xcrun", ["simctl", "boot", target]);
  const common = [
    "-project",
    join(root, "apps/mobile/ios/App/App.xcodeproj"),
    "-scheme",
    "App",
    "-configuration",
    "Debug",
    "-destination",
    `platform=iOS Simulator,name=${target}`,
    "-derivedDataPath",
    join(output, "DerivedData"),
  ];
  const built = await run("xcodebuild-build", "xcodebuild", [
    "build-for-testing",
    ...common,
  ]);
  check(built === 0, "模拟器构建（本地签名）", `xcodebuild exit ${built}`);
  if (built !== 0) return;
  const first = await run("xcodebuild-test-1", "xcodebuild", [
    "test-without-building",
    ...common,
    "-resultBundlePath",
    join(output, "AppUITests-1.xcresult"),
    `-only-testing:${UI_TEST}/test1WithoutAGatewayTheAppOpensOnTheConnectScreen`,
  ]);
  check(first === 0, "XCUITest：没有 Gateway 时是连接页", `exit ${first}`);
  const link = await mint();
  const second = await run(
    "xcodebuild-test-2",
    "xcodebuild",
    [
      "test-without-building",
      ...common,
      "-resultBundlePath",
      join(output, "AppUITests-2.xcresult"),
      `-only-testing:${UI_TEST}/test2PairsThroughThePinnedGatewayAndOpensTheCanvas`,
    ],
    { env: { ...process.env, TEST_RUNNER_ARMADRA_PAIR_LINK: link } },
  );
  // App 的设备日志（插件只记钉扎结果、不记密钥），失败时看卡在哪。
  await run("simulator-log", "xcrun", [
    "simctl",
    "spawn",
    target,
    "log",
    "show",
    "--last",
    "15m",
    "--style",
    "compact",
    "--predicate",
    'subsystem == "dev.armadra.mobile"',
  ]);
  check(
    second === 0,
    "XCUITest：深链 → 钉扎 → 配对 → 画布 → 重开仍在画布 → 原生 OAuth 深链",
    `exit ${second}`,
  );
}

async function android(mint, port, assetUrl) {
  const reversed = await run("adb-reverse", "adb", [
    "reverse",
    `tcp:${port}`,
    `tcp:${port}`,
  ]);
  check(reversed === 0, "adb reverse 把模拟器回环接到宿主", `tcp:${port}`);
  const gradlew = join(root, "apps/mobile/android/gradlew");
  const cwd = join(root, "apps/mobile/android");
  const built = await run(
    "gradle-build",
    gradlew,
    [":app:assembleDebug", ":app:assembleDebugAndroidTest", "--stacktrace"],
    { cwd },
  );
  check(built === 0, "debug APK 与插桩 APK", `gradle exit ${built}`);
  if (built !== 0) return;
  const link = await mint();
  const code = await run(
    "gradle-connected",
    gradlew,
    [
      ":app:connectedDebugAndroidTest",
      `-Pandroid.testInstrumentationRunnerArguments.armadraPairLink=${link}`,
      `-Pandroid.testInstrumentationRunnerArguments.armadraAssetUrl=${assetUrl}`,
      "--stacktrace",
    ],
    { cwd },
  );
  // 失败时最有用的是 WebView 控制台与插件自己的几行（不含任何密钥）。
  await run("logcat", "adb", [
    "logcat",
    "-d",
    "-s",
    "ArmadraNative:*",
    "chromium:*",
    // 进程崩了时插桩只说「Process crashed」：栈在 AndroidRuntime 里。
    "AndroidRuntime:E",
    // 页面里的 console（只有错误与提示，不含密钥）。
    "Capacitor/Console:*",
  ]);
  check(
    code === 0,
    "插桩用例：连接页 → 钉扎 → 配对 → 画布 → 重开仍在画布；图片带 Bearer；原生 OAuth 深链收尾",
    `gradle exit ${code}`,
  );
}

await h.run(async () => {
  for (const required of [
    join(root, "apps/desktop/out/core/main.js"),
    join(webDist, "index.html"),
    join(
      root,
      platform === "ios"
        ? "apps/mobile/ios/App/App/public/index.html"
        : "apps/mobile/android/app/src/main/assets/public/index.html",
    ),
  ]) {
    if (!existsSync(required))
      throw new Error(`缺 ${required}：先按文件头的前置步骤构建`);
  }

  const base = await startCore(temp("armadra-mobile-e2e-"));
  step("core 起在回环上", base);

  const opened = JSON.parse(
    (
      await local(base, "PUT", "/api/gateway", {
        enabled: true,
        listen: "loopback",
      })
    ).body,
  );
  check(
    opened.running && opened.tls?.source === "localCa",
    "Gateway 开在回环上（本地 CA）",
    opened.origin,
  );
  const origin = new URL(opened.origin);

  const mint = async () => {
    const pairing = JSON.parse(
      (
        await local(base, "POST", "/api/gateway/pairing", {
          deviceName: `mobile-shell-e2e ${platform}`,
        })
      ).body,
    );
    check(
      typeof pairing.deepLink === "string" &&
        pairing.deepLink.startsWith("armadra://pair?") &&
        pairing.deepLink.includes(`fp=${pairing.fingerprint}`),
      "配对载荷带原生深链与信任锚指纹（现铸，两分钟内用）",
      pairing.fingerprint,
    );
    return pairing.deepLink;
  };

  // 一张 1×1 的 PNG：页面经 Gateway 取它时要带 Bearer（R-55）。
  const created = JSON.parse(
    (
      await local(base, "POST", "/api/workspaces", {
        name: "mobile-shell-e2e",
        rootPath: temp("armadra-mobile-e2e-workspace-"),
      })
    ).body,
  );
  const uploaded = JSON.parse(
    (
      await local(base, "POST", `/api/workspaces/${created.id}/assets`, {
        dataUrl:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
      })
    ).body,
  );
  check(
    typeof created.id === "string" && typeof uploaded.id === "string",
    "工作空间与一张 PNG 资产（回环上传）",
    uploaded.id,
  );
  const assetUrl = `${opened.origin}/api/workspaces/${created.id}/assets/${encodeURIComponent(uploaded.id ?? "")}`;

  if (platform === "ios") await ios(mint);
  else await android(mint, origin.port, assetUrl);
});
