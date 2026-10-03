import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startPushSink } from "./push-sink.mjs";

const b64 = (value) => Buffer.from(value).toString("base64url");

function es256Jwt(header, claims, privateKey) {
  const input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}`;
  const signature = sign("sha256", Buffer.from(input), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${signature.toString("base64url")}`;
}

const apnsKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const otherKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const vapidKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const vapidPublic = (() => {
  const jwk = vapidKey.publicKey.export({ format: "jwk" });
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]).toString("base64url");
})();

let sink;
let keyDir;
const now = () => Math.floor(Date.now() / 1000);

before(async () => {
  keyDir = mkdtempSync(join(tmpdir(), "push-sink-"));
  writeFileSync(
    join(keyDir, "KEY123.pem"),
    apnsKey.publicKey.export({ type: "spki", format: "pem" }),
  );
  sink = await startPushSink({ keyDir });
});

after(async () => {
  await sink.close();
  rmSync(keyDir, { recursive: true, force: true });
});

function h2Post(path, headers, body = "") {
  return new Promise((resolve, reject) => {
    const client = connect(sink.base);
    client.on("error", reject);
    const stream = client.request({
      ":method": "POST",
      ":path": path,
      ...headers,
    });
    let status = 0;
    let responseHeaders = {};
    const chunks = [];
    stream.on("response", (h) => {
      status = h[":status"];
      responseHeaders = h;
    });
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => {
      client.close();
      resolve({
        status,
        headers: responseHeaders,
        body: Buffer.concat(chunks).toString(),
      });
    });
    stream.end(body);
  });
}

test("APNs：h2c 上的有效令牌被验签并记录", async () => {
  await fetch(`${sink.base}/_sink/requests`, { method: "DELETE" });
  const token = es256Jwt(
    { alg: "ES256", kid: "KEY123" },
    { iss: "TEAM123456", iat: now() },
    apnsKey.privateKey,
  );
  const response = await h2Post(
    "/3/device/abc123",
    {
      authorization: `bearer ${token}`,
      "apns-topic": "dev.armadra.app",
      "apns-push-type": "alert",
    },
    JSON.stringify({ aps: { alert: "hi" } }),
  );
  assert.equal(response.status, 200);
  assert.ok(response.headers["apns-id"]);
  const { requests } = await (
    await fetch(`${sink.base}/_sink/requests`)
  ).json();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].kind, "apns");
  assert.equal(requests[0].httpVersion, "2");
  assert.equal(requests[0].deviceToken, "abc123");
  assert.equal(requests[0].jwt.signature, "verified");
  assert.equal(requests[0].jwt.claims.iss, "TEAM123456");
  assert.equal(requests[0].headers["apns-topic"], "dev.armadra.app");
  assert.equal(
    JSON.stringify(requests[0]).includes(token),
    false,
    "raw token is not recorded",
  );
});

test("APNs：签名不对、过期、缺 topic、坏令牌、已注销", async () => {
  const forged = es256Jwt(
    { alg: "ES256", kid: "KEY123" },
    { iss: "T", iat: now() },
    otherKey.privateKey,
  );
  const stale = es256Jwt(
    { alg: "ES256", kid: "KEY123" },
    { iss: "T", iat: now() - 7200 },
    apnsKey.privateKey,
  );
  const good = es256Jwt(
    { alg: "ES256", kid: "KEY123" },
    { iss: "T", iat: now() },
    apnsKey.privateKey,
  );
  const unknownKid = es256Jwt(
    { alg: "ES256", kid: "OTHER" },
    { iss: "T", iat: now() },
    otherKey.privateKey,
  );
  const topic = { "apns-topic": "dev.armadra.app" };
  const cases = [
    [
      { authorization: `bearer ${forged}`, ...topic },
      "abc",
      403,
      "InvalidProviderToken",
    ],
    [
      { authorization: `bearer ${stale}`, ...topic },
      "abc",
      403,
      "ExpiredProviderToken",
    ],
    [{ ...topic }, "abc", 403, "MissingProviderToken"],
    [{ authorization: `bearer ${good}` }, "abc", 400, "MissingTopic"],
    [
      { authorization: `bearer ${good}`, ...topic },
      "bad-token",
      400,
      "BadDeviceToken",
    ],
    [
      { authorization: `bearer ${good}`, ...topic },
      "gone-token",
      410,
      "Unregistered",
    ],
  ];
  for (const [headers, device, status, reason] of cases) {
    const response = await h2Post(`/3/device/${device}`, headers, "{}");
    assert.equal(response.status, status, reason);
    assert.equal(JSON.parse(response.body).reason, reason);
  }
  // 没有对应公钥的 kid：形状对就收，记为 unchecked。
  const unchecked = await h2Post(
    `/3/device/abc`,
    { authorization: `bearer ${unknownKid}`, ...topic },
    "{}",
  );
  assert.equal(unchecked.status, 200);
});

test("FCM：令牌端点与 v1 发送", async () => {
  const assertion = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(JSON.stringify({ iss: "sa@dev.iam.gserviceaccount.com" }))}.c2ln`;
  const token = await fetch(`${sink.base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  assert.equal(token.status, 200);
  const { access_token: accessToken } = await token.json();
  const send = (body, auth = `Bearer ${accessToken}`) =>
    fetch(`${sink.base}/v1/projects/armadra-dev/messages:send`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const ok = await send({ message: { token: "device-1", data: { k: "v" } } });
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).name, /^projects\/armadra-dev\/messages\//);
  assert.equal((await send({ message: { token: "gone-1" } })).status, 404);
  assert.equal((await send({ message: { token: "x" } }, "")).status, 401);
  assert.equal((await send({})).status, 400);
});

test("Web Push：VAPID 用 k= 验签，audience 必须是 sink 自己", async () => {
  const vapid = (aud, exp = now() + 3600) =>
    `vapid t=${es256Jwt({ typ: "JWT", alg: "ES256" }, { aud, exp, sub: "mailto:dev@armadra.test" }, vapidKey.privateKey)}, k=${vapidPublic}`;
  const push = (authorization, headers = {}) =>
    fetch(`${sink.base}/wp/sub-1`, {
      method: "POST",
      headers: {
        authorization,
        ttl: "60",
        "content-encoding": "aes128gcm",
        ...headers,
      },
      body: Buffer.from("ciphertext"),
    });
  assert.equal((await push(vapid(sink.base))).status, 201);
  const wrong = await push(vapid("https://push.example"));
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).reason, "wrongAudience");
  assert.equal((await push(vapid(sink.base, now() + 48 * 3600))).status, 401);
  assert.equal((await push(`vapid t=a.b.c, k=${vapidPublic}`)).status, 401);
  assert.equal(
    (await push(vapid(sink.base), { "content-encoding": "aesgcm" })).status,
    415,
  );
});

test("中继替身：/relay/ 下的 POST 一律 202 并记录", async () => {
  await fetch(`${sink.base}/_sink/requests`, { method: "DELETE" });
  const response = await fetch(`${sink.base}/relay/v1/push`, {
    method: "POST",
    body: JSON.stringify({ relayToken: "r1", ciphertext: "AAAA" }),
  });
  assert.equal(response.status, 202);
  const { requests } = await (
    await fetch(`${sink.base}/_sink/requests`)
  ).json();
  assert.equal(requests[0].kind, "relay");
  assert.equal(requests[0].httpVersion, "1.1");
  assert.equal(
    Buffer.from(requests[0].body, "base64").toString(),
    JSON.stringify({ relayToken: "r1", ciphertext: "AAAA" }),
  );
});
