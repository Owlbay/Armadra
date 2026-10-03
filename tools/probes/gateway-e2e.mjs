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
//   4. 关掉 Gateway，连接被拒。
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
import { harness } from "./shell-e2e-lib.mjs";

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
        ARMADRA_GATEWAY_WEB_ROOT: temp("armadra-gateway-web-"),
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
