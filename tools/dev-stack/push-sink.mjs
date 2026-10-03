/**
 * push-sink：假 APNs / FCM / Web Push 端点，兼作推送中继的替身。
 *
 * 只给 dev-stack 与测试用。它不投递任何东西，只做三件事：
 *
 *   * **记录**每个请求（方法、路径、头里与推送有关的那几个、正文长度与正文），
 *     测试用 `GET /_sink/requests` 取回、`DELETE /_sink/requests` 清空。
 *     `authorization` 不原样记——只记解出来的 JWT 头与声明和校验结论。
 *   * **校验** JWT：APNs 的 provider token（ES256，`kid` / `iss` / `iat`）、
 *     Web Push 的 VAPID（ES256，用请求里 `k=` 给的公钥验签，`aud` / `exp` / `sub`）、
 *     FCM 令牌端点收到的服务账号断言（RS256 只查形状）。APNs 的签名只有在
 *     `PUSH_SINK_APNS_KEY_DIR` 里放了 `<kid>.pem`（公钥或 .p8 私钥）时才验，
 *     否则记 `signature: "unchecked"`。
 *   * **按约定的令牌答错**：设备令牌以 `bad` 开头答「令牌无效」、以 `gone`
 *     开头答「已注销」，让调用方的清理路径有东西可测。
 *
 * APNs 只说 HTTP/2，FCM 与 Web Push 说 HTTP/1.1；同一个端口两种都接——先看连接
 * 的头几个字节是不是 HTTP/2 前导（h2c prior knowledge），再交给对应的服务器。
 */
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createH2Server } from "node:http2";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const H2_PREFACE = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";
const MAX_RECORDS = 1000;
const APNS_MAX_PAYLOAD = 4096;
const WEBPUSH_MAX_PAYLOAD = 4096;

function base64url(text) {
  return Buffer.from(text, "base64url");
}

/** Split a compact JWS; null when it is not one. */
export function decodeJwt(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3 || parts.some((part) => part === "")) return null;
  try {
    return {
      header: JSON.parse(base64url(parts[0]).toString("utf8")),
      claims: JSON.parse(base64url(parts[1]).toString("utf8")),
      signingInput: Buffer.from(`${parts[0]}.${parts[1]}`),
      signature: base64url(parts[2]),
    };
  } catch {
    return null;
  }
}

/** ES256 over the JWS signing input; JWS carries r||s, not DER. */
export function verifyEs256(jwt, key) {
  if (jwt.signature.length !== 64) return false;
  try {
    return verify(
      "sha256",
      jwt.signingInput,
      { key, dsaEncoding: "ieee-p1363" },
      jwt.signature,
    );
  } catch {
    return false;
  }
}

/** A P-256 public key from the uncompressed point VAPID puts in `k=`. */
export function vapidPublicKey(k) {
  const point = base64url(k);
  if (point.length !== 65 || point[0] !== 0x04) return null;
  return createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
}

function loadApnsKey(directory, kid) {
  if (!directory || !/^[A-Za-z0-9]+$/.test(String(kid ?? ""))) return null;
  for (const name of [`${kid}.pem`, `AuthKey_${kid}.p8`, `${kid}.p8`]) {
    try {
      // createPublicKey 对私钥 PEM 也行：它取出公钥部分。
      return createPublicKey(readFileSync(join(directory, name), "utf8"));
    } catch {
      continue;
    }
  }
  return null;
}

/** APNs provider token: ES256, kid, iss, and an iat younger than an hour. */
export function checkApnsToken(authorization, { keyDir, now = Date.now() }) {
  const match = /^bearer (.+)$/i.exec(String(authorization ?? ""));
  if (!match) return { ok: false, reason: "MissingProviderToken" };
  const jwt = decodeJwt(match[1]);
  if (!jwt) return { ok: false, reason: "InvalidProviderToken" };
  const { header, claims } = jwt;
  if (header.alg !== "ES256" || !header.kid || !claims.iss)
    return { ok: false, reason: "InvalidProviderToken", header, claims };
  const age = now / 1000 - Number(claims.iat);
  if (!Number.isFinite(age) || age > 3600 || age < -300)
    return { ok: false, reason: "ExpiredProviderToken", header, claims };
  const key = loadApnsKey(keyDir, header.kid);
  if (!key) return { ok: true, signature: "unchecked", header, claims };
  if (!verifyEs256(jwt, key))
    return { ok: false, reason: "InvalidProviderToken", header, claims };
  return { ok: true, signature: "verified", header, claims };
}

/** VAPID (RFC 8292): `vapid t=<jwt>, k=<key>`, verified with that key. */
export function checkVapid(authorization, { audience, now = Date.now() }) {
  const value = String(authorization ?? "");
  const t = /(?:^vapid\s+|,\s*)t=([^,\s]+)/i.exec(value)?.[1];
  const k = /(?:^vapid\s+|,\s*)k=([^,\s]+)/i.exec(value)?.[1];
  if (!/^vapid\s/i.test(value) || !t || !k)
    return { ok: false, reason: "missingVapid" };
  const jwt = decodeJwt(t);
  if (!jwt) return { ok: false, reason: "malformedJwt" };
  const { header, claims } = jwt;
  let key;
  try {
    key = vapidPublicKey(k);
  } catch {
    key = null;
  }
  if (!key) return { ok: false, reason: "badPublicKey", header, claims };
  if (header.alg !== "ES256" || !verifyEs256(jwt, key))
    return { ok: false, reason: "badSignature", header, claims };
  if (claims.aud !== audience)
    return { ok: false, reason: "wrongAudience", header, claims };
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || exp * 1000 < now)
    return { ok: false, reason: "expired", header, claims };
  if (exp * 1000 > now + 24 * 3600 * 1000)
    return { ok: false, reason: "expiryTooFar", header, claims };
  if (!/^(mailto:|https:)/.test(String(claims.sub ?? "")))
    return { ok: false, reason: "badSubject", header, claims };
  return { ok: true, signature: "verified", header, claims };
}

function reply(status, body) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
const failure = reply;
const success = reply;

/**
 * The routing, independent of the transport so HTTP/1.1 and HTTP/2 share it.
 * `request` is `{ method, path, headers, body: Buffer }`.
 */
export function createPushSink({
  keyDir,
  origin,
  now = () => Date.now(),
} = {}) {
  const records = [];

  function record(request, outcome, extra = {}) {
    const headers = {};
    for (const name of [
      "apns-topic",
      "apns-push-type",
      "apns-priority",
      "apns-expiration",
      "apns-collapse-id",
      "content-encoding",
      "content-type",
      "ttl",
      "urgency",
      "topic",
    ]) {
      if (request.headers[name] !== undefined)
        headers[name] = request.headers[name];
    }
    records.push({
      id: randomUUID(),
      at: new Date(now()).toISOString(),
      method: request.method,
      path: request.path,
      httpVersion: request.httpVersion,
      headers,
      bodyLength: request.body.length,
      body: request.body.toString("base64"),
      status: outcome.status,
      ...extra,
    });
    if (records.length > MAX_RECORDS) records.shift();
  }

  function handle(request) {
    const url = new URL(request.path, "http://push-sink");
    const path = url.pathname;
    const method = request.method;

    if (path === "/health" && method === "GET")
      return success(200, { ok: true, service: "push-sink" });
    if (path === "/_sink/requests") {
      if (method === "GET") return success(200, { requests: records });
      if (method === "DELETE") {
        records.length = 0;
        return success(200, { cleared: true });
      }
    }

    // APNs: POST /3/device/<token>
    const apns = /^\/3\/device\/([^/]+)$/.exec(path);
    if (apns && method === "POST") {
      const token = decodeURIComponent(apns[1]);
      const apnsId = String(request.headers["apns-id"] ?? randomUUID());
      const check = checkApnsToken(request.headers.authorization, {
        keyDir,
        now: now(),
      });
      let outcome;
      if (!check.ok) outcome = failure(403, { reason: check.reason });
      else if (!request.headers["apns-topic"])
        outcome = failure(400, { reason: "MissingTopic" });
      else if (request.body.length > APNS_MAX_PAYLOAD)
        outcome = failure(413, { reason: "PayloadTooLarge" });
      else if (token.startsWith("bad"))
        outcome = failure(400, { reason: "BadDeviceToken" });
      else if (token.startsWith("gone"))
        outcome = failure(410, {
          reason: "Unregistered",
          timestamp: now(),
        });
      else
        outcome = {
          status: 200,
          headers: { "apns-id": apnsId },
          body: "",
        };
      outcome.headers = { ...outcome.headers, "apns-id": apnsId };
      record(request, outcome, {
        kind: "apns",
        deviceToken: token,
        jwt: { ...pick(check), signature: check.signature ?? null },
      });
      return outcome;
    }

    // FCM OAuth token endpoint stand-in (service-account JWT bearer grant).
    if (path === "/token" && method === "POST") {
      const form = new URLSearchParams(request.body.toString("utf8"));
      const assertion = decodeJwt(form.get("assertion"));
      let outcome;
      if (
        form.get("grant_type") !==
          "urn:ietf:params:oauth:grant-type:jwt-bearer" ||
        !assertion ||
        assertion.header.alg !== "RS256" ||
        !assertion.claims.iss
      )
        outcome = failure(400, { error: "invalid_grant" });
      else
        outcome = success(200, {
          access_token: `dev-stack-fcm-${randomUUID()}`,
          expires_in: 3600,
          token_type: "Bearer",
        });
      record(request, outcome, {
        kind: "fcm-token",
        jwt: assertion
          ? { header: assertion.header, claims: assertion.claims }
          : null,
      });
      return outcome;
    }

    // FCM HTTP v1: POST /v1/projects/<project>/messages:send
    const fcm = /^\/v1\/projects\/([^/]+)\/messages:send$/.exec(path);
    if (fcm && method === "POST") {
      const bearer = /^bearer (.+)$/i.exec(
        String(request.headers.authorization ?? ""),
      );
      let message = null;
      try {
        message = JSON.parse(request.body.toString("utf8")).message ?? null;
      } catch {
        message = null;
      }
      const token = String(message?.token ?? "");
      let outcome;
      if (!bearer)
        outcome = failure(401, {
          error: { code: 401, status: "UNAUTHENTICATED" },
        });
      else if (!message || !token)
        outcome = failure(400, {
          error: { code: 400, status: "INVALID_ARGUMENT" },
        });
      else if (token.startsWith("bad"))
        outcome = failure(400, {
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            details: [{ errorCode: "INVALID_ARGUMENT" }],
          },
        });
      else if (token.startsWith("gone"))
        outcome = failure(404, {
          error: {
            code: 404,
            status: "NOT_FOUND",
            details: [{ errorCode: "UNREGISTERED" }],
          },
        });
      else
        outcome = success(200, {
          name: `projects/${fcm[1]}/messages/${randomUUID()}`,
        });
      record(request, outcome, { kind: "fcm", deviceToken: token || null });
      return outcome;
    }

    // Web Push (RFC 8030 + 8291 + 8292): POST /wp/<subscription>
    const webpush = /^\/wp\/([^/]+)$/.exec(path);
    if (webpush && method === "POST") {
      const subscription = decodeURIComponent(webpush[1]);
      const check = checkVapid(request.headers.authorization, {
        audience: origin ?? request.origin,
        now: now(),
      });
      let outcome;
      if (!check.ok) outcome = failure(401, { reason: check.reason });
      else if (request.headers.ttl === undefined)
        outcome = failure(400, { reason: "missingTtl" });
      else if (
        request.body.length > 0 &&
        request.headers["content-encoding"] !== "aes128gcm"
      )
        outcome = failure(415, { reason: "unsupportedEncoding" });
      else if (request.body.length > WEBPUSH_MAX_PAYLOAD)
        outcome = failure(413, { reason: "payloadTooLarge" });
      else if (subscription.startsWith("gone"))
        outcome = failure(410, { reason: "gone" });
      else
        outcome = {
          status: 201,
          headers: {
            location: `/wp/${encodeURIComponent(subscription)}/m/${randomUUID()}`,
          },
          body: "",
        };
      record(request, outcome, {
        kind: "webpush",
        subscription,
        jwt: { ...pick(check), signature: check.signature ?? null },
      });
      return outcome;
    }

    // Push relay stand-in: anything under /relay/ is accepted and recorded.
    if (path.startsWith("/relay/") && method === "POST") {
      const outcome = success(202, { accepted: true, id: randomUUID() });
      record(request, outcome, { kind: "relay" });
      return outcome;
    }

    return failure(404, { reason: "notFound" });
  }

  return { handle, records };
}

function pick(check) {
  return {
    ok: check.ok,
    reason: check.reason ?? null,
    header: check.header ?? null,
    claims: check.claims ?? null,
  };
}

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** Start the sink; one port speaks both HTTP/1.1 and h2c. */
export async function startPushSink({
  host = "127.0.0.1",
  port = 0,
  keyDir = process.env.PUSH_SINK_APNS_KEY_DIR,
  origin,
} = {}) {
  let base = "";
  const sink = createPushSink({ keyDir });

  async function serve(method, path, headers, stream, httpVersion) {
    const body = await readBody(stream);
    return sink.handle({
      method,
      path,
      headers,
      body,
      httpVersion,
      origin: origin ?? base,
    });
  }

  const http1 = createHttpServer(async (request, response) => {
    const outcome = await serve(
      request.method,
      request.url,
      request.headers,
      request,
      "1.1",
    );
    response.writeHead(outcome.status, outcome.headers).end(outcome.body);
  });

  const h2 = createH2Server();
  h2.on("stream", async (stream, headers) => {
    const outcome = await serve(
      headers[":method"],
      headers[":path"],
      headers,
      stream,
      "2",
    );
    stream.respond({ ":status": outcome.status, ...outcome.headers });
    stream.end(outcome.body);
  });

  const sockets = new Set();
  const front = createNetServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.once("readable", () => {
      const head = socket.read(H2_PREFACE.length) ?? socket.read();
      if (head) socket.unshift(head);
      if (head && head.toString("latin1") === H2_PREFACE)
        h2.emit("connection", socket);
      else http1.emit("connection", socket);
    });
  });
  await new Promise((resolve) => front.listen(port, host, resolve));
  const bound = front.address().port;
  base = `http://127.0.0.1:${bound}`;
  return {
    base,
    port: bound,
    records: sink.records,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => front.close(resolve));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const env = process.env;
  const sink = await startPushSink({
    host: env.PUSH_SINK_HOST || "127.0.0.1",
    port: Number(env.PUSH_SINK_PORT || 8091),
    // 容器里监听 0.0.0.0，但调用方看到的 audience 是宿主机回环上的地址。
    origin: env.PUSH_SINK_PUBLIC_ORIGIN || undefined,
  });
  console.log(`push-sink listening on ${sink.base}`);
  const stop = () => sink.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
