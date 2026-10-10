// 线上中继的只读探针（Workers 中继，平台计划 V4）：部署后对 https://relay.armadra.com 用。
//
// 只发 GET，只碰两处公开端点：`/health` 与 `/.well-known/*`（平台信息、公钥集）。不登录、
// 不登记、不开隧道、不带任何凭据；默认不在 CI 里跑（没有 e2e.d 条目），部署后手动：
//
//   node tools/probes/relay-live-readonly.mjs [--issuer https://relay.armadra.com] [--json]
//
// 退出码 0 = 全部通过，1 = 有检查失败，2 = 参数错。也可以对本地 workerd 跑（http:// 地址），
// 自检用。证书走系统信任（线上是公共证书），不放宽 TLS 校验。
const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const issuer = (flag("--issuer") ?? "https://relay.armadra.com").replace(
  /\/+$/,
  "",
);
const asJson = args.includes("--json");
try {
  const url = new URL(issuer);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
} catch {
  console.error(`--issuer 不是 http(s) 地址：${issuer}`);
  process.exit(2);
}

const checks = [];
const check = (name, ok, detail) => {
  checks.push({
    name,
    ok: Boolean(ok),
    ...(detail === undefined ? {} : { detail }),
  });
  if (!asJson)
    console.log(
      `  ${ok ? "ok  " : "FAIL"}  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`,
    );
};

async function get(path) {
  const started = Date.now();
  const response = await fetch(`${issuer}${path}`, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* 不是 JSON。 */
  }
  return {
    status: response.status,
    headers: response.headers,
    text,
    body,
    ms: Date.now() - started,
  };
}

if (!asJson) console.log(`线上只读探针：${issuer}`);
try {
  const health = await get("/health");
  check("/health 答 200", health.status === 200, {
    status: health.status,
    ms: health.ms,
  });

  const info = await get("/.well-known/armadra-platform");
  check(
    "/.well-known/armadra-platform 答 200 JSON",
    info.status === 200 && info.body !== null,
    {
      status: info.status,
    },
  );
  const body = info.body ?? {};
  check("平台信息：issuer 与探测的地址一致", body.issuer === issuer, {
    issuer: body.issuer,
  });
  check(
    "平台信息：mode 是 personal 或 saas",
    ["personal", "saas"].includes(body.mode),
    {
      mode: body.mode,
    },
  );
  check(
    "平台信息：带协议版本",
    typeof body.protocol === "string" ||
      typeof body.protocol === "object" ||
      typeof body.version === "string",
    { keys: Object.keys(body).slice(0, 12) },
  );
  if (body.webApp !== undefined && body.webApp !== null)
    check(
      "平台信息：webApp 在同一来源的 /app/ 下",
      body.webApp === `${issuer}/app/`,
      {
        webApp: body.webApp,
      },
    );

  const jwks = await get("/.well-known/jwks.json");
  check(
    "/.well-known/jwks.json 有至少一把公钥，且不含私钥分量",
    jwks.status === 200 &&
      Array.isArray(jwks.body?.keys) &&
      jwks.body.keys.length > 0 &&
      jwks.body.keys.every((key) => key.d === undefined),
    { status: jwks.status, keys: jwks.body?.keys?.length },
  );

  for (const path of ["/health", "/.well-known/armadra-platform"]) {
    const answer = path === "/health" ? health : info;
    check(`${path} 不带 Set-Cookie`, !answer.headers.has("set-cookie"));
  }
} catch (error) {
  check(
    "请求完成",
    false,
    error instanceof Error ? error.message : String(error),
  );
}

const failed = checks.filter((one) => !one.ok);
if (asJson)
  console.log(
    JSON.stringify({ issuer, ok: failed.length === 0, checks }, null, 2),
  );
else
  console.log(
    failed.length === 0
      ? "全部通过"
      : `${failed.length} 项失败：${failed.map((one) => one.name).join("；")}`,
  );
process.exit(failed.length === 0 ? 0 : 1);
