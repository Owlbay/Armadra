/**
 * hibp：Pwned Passwords range API（k-匿名）的固定响应替身。
 *
 * `GET /range/<五位十六进制前缀>` 答 `后缀:次数` 的行，与真服务同形：后缀 35 位
 * 大写十六进制，CRLF 分行，`Add-Padding: true` 时补到至少 800 行、补出来的行次数为 0。
 * 只给 dev-stack 与测试用，不访问外网。
 *
 * 「已泄露」的口令是下面这张表，SHA-1 在启动时算出来，表里不放哈希；其余前缀
 * 答一组按前缀确定性生成的填充行，让「没命中」也是一份正常的非空响应。
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

/** 测试夹具：这些口令一定「已泄露」。全是公开的弱口令或本仓库自造的标记串。 */
export const PWNED_FIXTURES = [
  { password: "password", count: 52256179 },
  { password: "123456", count: 37359195 },
  { password: "qwerty", count: 10187359 },
  { password: "armadra-pwned-fixture", count: 1 },
];

const MIN_PADDED_LINES = 800;

export function sha1Hex(text) {
  return createHash("sha1").update(text, "utf8").digest("hex").toUpperCase();
}

function fixtureIndex(fixtures) {
  const byPrefix = new Map();
  for (const { password, count } of fixtures) {
    const hash = sha1Hex(password);
    const prefix = hash.slice(0, 5);
    const list = byPrefix.get(prefix) ?? [];
    list.push({ suffix: hash.slice(5), count });
    byPrefix.set(prefix, list);
  }
  return byPrefix;
}

/** Deterministic filler suffixes for a prefix; none collides with a fixture. */
function fillerLines(prefix, howMany, taken, count) {
  const lines = [];
  for (let i = 0; lines.length < howMany; i += 1) {
    const suffix = createHash("sha1")
      .update(`${prefix}:${i}`)
      .digest("hex")
      .toUpperCase()
      .slice(0, 35);
    if (taken.has(suffix)) continue;
    taken.add(suffix);
    lines.push({ suffix, count: count(i) });
  }
  return lines;
}

/** The response body for one prefix; `null` when the prefix is malformed. */
export function rangeResponse(
  prefix,
  { padding = false, fixtures = PWNED_FIXTURES } = {},
) {
  if (!/^[0-9A-Fa-f]{5}$/.test(prefix)) return null;
  const upper = prefix.toUpperCase();
  const hits = fixtureIndex(fixtures).get(upper) ?? [];
  const taken = new Set(hits.map((line) => line.suffix));
  const lines = [...hits, ...fillerLines(upper, 12, taken, (i) => (i % 7) + 1)];
  if (padding && lines.length < MIN_PADDED_LINES)
    lines.push(
      ...fillerLines(
        `${upper}/pad`,
        MIN_PADDED_LINES - lines.length,
        taken,
        () => 0,
      ),
    );
  lines.sort((a, b) => (a.suffix < b.suffix ? -1 : 1));
  return lines.map(({ suffix, count }) => `${suffix}:${count}`).join("\r\n");
}

export function createHibpHandler({ fixtures = PWNED_FIXTURES } = {}) {
  return (request, response) => {
    const url = new URL(request.url, "http://hibp");
    if (request.method === "GET" && url.pathname === "/health") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, service: "hibp" }));
      return;
    }
    const range = /^\/range\/([^/]*)$/.exec(url.pathname);
    if (request.method === "GET" && range) {
      if (
        url.searchParams.has("mode") &&
        url.searchParams.get("mode") !== "sha1"
      ) {
        response
          .writeHead(400)
          .end("Only SHA-1 mode is supported by this fixture");
        return;
      }
      const body = rangeResponse(range[1], {
        padding:
          String(request.headers["add-padding"]).toLowerCase() === "true",
        fixtures,
      });
      if (body === null) {
        response
          .writeHead(400, { "content-type": "text/plain" })
          .end("The hash prefix was not in a valid format");
        return;
      }
      response
        .writeHead(200, {
          "content-type": "text/plain",
          "cache-control": "public, max-age=2678400",
        })
        .end(body);
      return;
    }
    response.writeHead(404).end("not found");
  };
}

export async function startHibpFixture({ host = "127.0.0.1", port = 0 } = {}) {
  const server = createServer(createHibpHandler());
  await new Promise((resolve) => server.listen(port, host, resolve));
  const bound = server.address().port;
  return {
    base: `http://127.0.0.1:${bound}`,
    port: bound,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fixture = await startHibpFixture({
    host: process.env.HIBP_HOST || "127.0.0.1",
    port: Number(process.env.HIBP_PORT || 8092),
  });
  console.log(`hibp fixture listening on ${fixture.base}`);
  const stop = () => fixture.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
