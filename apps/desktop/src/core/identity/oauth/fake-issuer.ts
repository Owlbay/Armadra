import {
  type KeyObject,
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { type Server, createServer } from "node:http";
import type { GithubEndpoints } from "./providers";

/**
 * 测试专用：进程内的假 issuer（契约 §18.5 的单测替身）。同一个 `node:http` 服务
 * 同时扮演一个 OIDC 提供方（发现文档、JWKS、authorize / token / userinfo /
 * end_session）与 GitHub（`/login/oauth/*`、`/api/user`、`/api/user/emails`）。
 *
 * authorize 不出登录页：直接按当前的 {@link FakeUser} 签一张授权码、302 回
 * `redirect_uri`。token 端点照真提供方核对授权码一次性、`redirect_uri`、PKCE
 * S256 与 client secret。`faults` 让下一张 `id_token` 出错（签名、nonce、aud、
 * 过期、算法），用来验 core 的拒绝分支。
 *
 * 不进生产路径：只有 `*.test.ts` import 它。
 */

export interface FakeUser {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
}

export interface FakeFaults {
  badSignature?: boolean;
  wrongNonce?: boolean;
  wrongAudience?: boolean;
  expired?: boolean;
  algNone?: boolean;
  /** 发现文档里写另一个 issuer。 */
  wrongIssuer?: boolean;
}

interface Grant {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly nonce: string;
  readonly user: FakeUser;
  readonly github: boolean;
}

export interface FakeIssuer {
  readonly issuer: string;
  readonly github: GithubEndpoints;
  /** 下一次 authorize 给谁签码。 */
  user: FakeUser;
  /** 只对下一张 id_token 生效，用完清空。 */
  faults: FakeFaults;
  /** 机密客户端的 secret；`undefined` = 公开客户端。 */
  clientSecret: string | undefined;
  /** 收到的 token 请求次数，验「重放没有再换一次」。 */
  readonly tokenCalls: () => number;
  close(): Promise<void>;
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export async function startFakeIssuer(
  options: { alg?: "RS256" | "ES256"; clientId?: string } = {},
): Promise<FakeIssuer> {
  const alg = options.alg ?? "RS256";
  const clientId = options.clientId ?? "armadra-test";
  const pair =
    alg === "RS256"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : generateKeyPairSync("ec", { namedCurve: "P-256" });
  const other =
    alg === "RS256"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : generateKeyPairSync("ec", { namedCurve: "P-256" });
  const kid = randomBytes(6).toString("hex");
  const grants = new Map<string, Grant>();
  const tokens = new Map<string, FakeUser>();
  let calls = 0;

  const signJwt = (claims: Record<string, unknown>, key: KeyObject) => {
    const header = b64({ alg, typ: "JWT", kid });
    const payload = b64(claims);
    const signature = sign(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key,
    ).toString("base64url");
    return `${header}.${payload}.${signature}`;
  };

  let base = "";
  const fake: FakeIssuer = {
    get issuer() {
      return `${base}/oidc`;
    },
    get github() {
      return {
        authorizeUrl: `${base}/github/login/oauth/authorize`,
        tokenUrl: `${base}/github/login/oauth/access_token`,
        apiBase: `${base}/github/api`,
      };
    },
    user: { sub: "user-1", email: "dev@armadra.test", emailVerified: true },
    faults: {},
    clientSecret: undefined,
    tokenCalls: () => calls,
    close: () => new Promise((done) => server.close(() => done())),
  };

  const send = (
    response: import("node:http").ServerResponse,
    status: number,
    body: unknown,
  ) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", base);
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const path = url.pathname;
      if (path === "/oidc/.well-known/openid-configuration") {
        send(response, 200, {
          issuer: fake.faults.wrongIssuer ? `${base}/elsewhere` : fake.issuer,
          authorization_endpoint: `${base}/oidc/authorize`,
          token_endpoint: `${base}/oidc/token`,
          jwks_uri: `${base}/oidc/jwks`,
          userinfo_endpoint: `${base}/oidc/userinfo`,
          end_session_endpoint: `${base}/oidc/logout`,
          code_challenge_methods_supported: ["S256"],
          id_token_signing_alg_values_supported: [alg],
        });
        return;
      }
      if (path === "/oidc/jwks") {
        const jwk = pair.publicKey.export({ format: "jwk" });
        send(response, 200, { keys: [{ ...jwk, kid, use: "sig", alg }] });
        return;
      }
      if (
        path === "/oidc/authorize" ||
        path === "/github/login/oauth/authorize"
      ) {
        const query = url.searchParams;
        if (
          query.get("client_id") !== clientId ||
          query.get("code_challenge_method") !== "S256"
        ) {
          send(response, 400, { error: "invalid_request" });
          return;
        }
        const code = randomBytes(16).toString("hex");
        grants.set(code, {
          clientId,
          redirectUri: query.get("redirect_uri") ?? "",
          challenge: query.get("code_challenge") ?? "",
          nonce: query.get("nonce") ?? "",
          user: { ...fake.user },
          github: path.startsWith("/github/"),
        });
        const target = new URL(query.get("redirect_uri") ?? "");
        target.searchParams.set("code", code);
        target.searchParams.set("state", query.get("state") ?? "");
        response.writeHead(302, { location: target.toString() });
        response.end();
        return;
      }
      if (
        path === "/oidc/token" ||
        path === "/github/login/oauth/access_token"
      ) {
        calls += 1;
        const code = form.get("code") ?? "";
        const grant = grants.get(code);
        grants.delete(code);
        const verifier = form.get("code_verifier") ?? "";
        const basic = request.headers.authorization ?? "";
        const expectedBasic =
          fake.clientSecret === undefined
            ? ""
            : `Basic ${Buffer.from(`${clientId}:${fake.clientSecret}`).toString("base64")}`;
        if (
          grant === undefined ||
          grant.redirectUri !== form.get("redirect_uri") ||
          createHash("sha256").update(verifier).digest("base64url") !==
            grant.challenge ||
          basic !== expectedBasic
        ) {
          // GitHub 出错也答 200；OIDC 答 400。
          send(response, grant?.github ? 200 : 400, { error: "invalid_grant" });
          return;
        }
        const accessToken = randomBytes(16).toString("hex");
        tokens.set(accessToken, grant.user);
        if (grant.github) {
          send(response, 200, {
            access_token: accessToken,
            token_type: "bearer",
            scope: "read:user,user:email",
          });
          return;
        }
        const faults = fake.faults;
        fake.faults = {};
        const now = Math.floor(Date.now() / 1000);
        const claims: Record<string, unknown> = {
          iss: fake.issuer,
          sub: grant.user.sub,
          aud: faults.wrongAudience ? "someone-else" : clientId,
          iat: now,
          exp: faults.expired ? now - 3600 : now + 300,
          nonce: faults.wrongNonce ? "not-the-nonce" : grant.nonce,
          ...(grant.user.email === undefined
            ? {}
            : { email: grant.user.email }),
          ...(grant.user.emailVerified === undefined
            ? {}
            : { email_verified: grant.user.emailVerified }),
          ...(grant.user.name === undefined ? {} : { name: grant.user.name }),
        };
        let idToken = signJwt(
          claims,
          faults.badSignature ? other.privateKey : pair.privateKey,
        );
        if (faults.algNone) {
          idToken = `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`;
        }
        send(response, 200, {
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 300,
          id_token: idToken,
        });
        return;
      }
      const bearer = (request.headers.authorization ?? "").replace(
        /^Bearer /i,
        "",
      );
      const user = tokens.get(bearer);
      if (path === "/oidc/userinfo") {
        if (user === undefined) return send(response, 401, {});
        send(response, 200, {
          sub: user.sub,
          ...(user.email === undefined ? {} : { email: user.email }),
          ...(user.emailVerified === undefined
            ? {}
            : { email_verified: user.emailVerified }),
        });
        return;
      }
      if (path === "/github/api/user") {
        if (user === undefined) return send(response, 401, {});
        send(response, 200, {
          id: Number(user.sub),
          login: user.name ?? "octocat",
          name: user.name ?? null,
        });
        return;
      }
      if (path === "/github/api/user/emails") {
        if (user === undefined) return send(response, 401, {});
        send(
          response,
          200,
          user.email === undefined
            ? []
            : [
                { email: "other@example.com", primary: false, verified: true },
                {
                  email: user.email,
                  primary: true,
                  verified: user.emailVerified === true,
                },
              ],
        );
        return;
      }
      send(response, 404, { error: "not_found" });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return fake;
}
