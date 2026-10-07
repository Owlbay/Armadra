/**
 * 测试专用：OAuth 用例的 core 替身。一个 `node:http` 服务，`/api/identity/oauth/`
 * 交给 {@link OAuthHttp}，其余 `/api/identity/` 交给 `IdentityHttp`——和 core 里
 * 原样路由按最长前缀分发是同一个结果。库是临时目录里真迁移出来的那份。
 *
 * 只有 `*.test.ts` import 它。
 */

import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../../db/open";
import type { CoreRequest } from "../../http/router";
import { plainFileBackend } from "../../secrets";
import type { OAuthProvider } from "../../settings/schema";
import { tempDir } from "../../testing/temp-dir";
import { AccountsService } from "../accounts";
import { createIdentitySecurity } from "../accounts-http";
import { installAuditSink, resetAuditSink } from "../audit";
import { IdentityHttp } from "../http";
import { allScopes } from "../scopes";
import { IdentityService } from "../service";
import { IdentityStore } from "../store";
import { createOAuthHttp } from ".";
import { OAUTH_PREFIX } from "./http";
import type { GithubEndpoints } from "./providers";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../../db/migrations");
export const INSTANCE = "0123456789abcdef0123456789abcdef";

export interface Credentials {
  readonly accessToken: string;
  readonly csrfToken: string;
  readonly principalId: string;
}

export interface OAuthHarness {
  readonly base: string;
  readonly origin: string;
  readonly service: IdentityService;
  readonly store: IdentityStore;
  readonly providers: OAuthProvider[];
  readonly security: ReturnType<typeof createIdentitySecurity>;
  publicOrigins: string[];
  /** `identity.mfa.requireFor`，缺省 `none`；测试可改。 */
  mfaRequireFor: "none" | "members" | "all";
  readonly secrets: Map<string, string>;
  close(): Promise<void>;
}

export function provider(
  fields: Partial<OAuthProvider> & Pick<OAuthProvider, "id" | "kind">,
): OAuthProvider {
  return {
    clientId: "armadra-test",
    scopes: [],
    allowSignup: false,
    allowedDomains: [],
    enabled: true,
    ...fields,
  };
}

export async function oauthHarness(options: {
  readonly origin: string;
  readonly providers: OAuthProvider[];
  readonly github?: GithubEndpoints;
}): Promise<OAuthHarness> {
  const directory = tempDir("armadra-oauth-");
  const opened = openDatabase({
    file: join(directory, "canvas.db"),
    migrationsDir,
  });
  const store = new IdentityStore(opened.database);
  const service = new IdentityService(store, INSTANCE);
  const backend = plainFileBackend(join(directory, "secrets"));
  const state = {
    publicOrigins: [options.origin],
    mfaRequireFor: "none" as OAuthHarness["mfaRequireFor"],
  };
  const security = createIdentitySecurity({
    store,
    secrets: () => backend,
    settings: () => ({
      passwordMinLength: 12,
      rpId: "",
      publicOrigins: [],
      mfaRequireFor: state.mfaRequireFor,
    }),
  });
  const identity = new IdentityHttp({
    service,
    instanceId: INSTANCE,
    accounts: new AccountsService({ store }),
    security,
  });
  const secrets = new Map<string, string>();
  const oauth = createOAuthHttp(undefined, {
    store,
    service,
    accounts: new AccountsService({ store }),
    security,
    ...(options.github === undefined ? {} : { github: options.github }),
    providers: () => options.providers,
    publicOrigins: () => state.publicOrigins,
    secrets: {
      read: async (id) => secrets.get(id),
      write: async (id, value) => {
        secrets.set(id, value);
      },
      clear: async (id) => {
        secrets.delete(id);
      },
    },
  });
  installAuditSink((event) => {
    store.transaction((tx) =>
      tx.accounts.appendAudit({
        atMs: Date.now(),
        principalId: event.principalId ?? "",
        deviceId: event.deviceId ?? "",
        action: event.action,
        target: event.target ?? "",
        workspaceId: "",
        detailJson:
          event.detail === undefined ? "" : JSON.stringify(event.detail),
      }),
    );
  });
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://core");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const core: CoreRequest = {
        method: (request.method ?? "GET").toUpperCase(),
        path: url.pathname,
        query: url.searchParams,
        headers: request.headers,
        body,
        raw: request,
        json: <T>() => JSON.parse(body.toString("utf8") || "null") as T,
      };
      void (url.pathname.startsWith(OAUTH_PREFIX)
        ? oauth.handle(core, response, {})
        : identity.handle(core, response, {}));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    origin: options.origin,
    service,
    store,
    providers: options.providers,
    security,
    get publicOrigins() {
      return state.publicOrigins;
    },
    set publicOrigins(value: string[]) {
      state.publicOrigins = value;
    },
    get mfaRequireFor() {
      return state.mfaRequireFor;
    },
    set mfaRequireFor(value) {
      state.mfaRequireFor = value;
    },
    secrets,
    close: async () => {
      resetAuditSink();
      await new Promise<void>((done) => server.close(() => done()));
      opened.close();
    },
  };
}

/** 调身份域；`session` 给了就带 Bearer 与 CSRF。 */
export function call(
  h: OAuthHarness,
  method: string,
  path: string,
  body?: unknown,
  session?: Credentials,
  extra: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${h.base}/api/identity/${path}`, {
    method,
    redirect: "manual",
    headers: {
      origin: h.origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(session === undefined
        ? {}
        : {
            authorization: `Bearer ${session.accessToken}`,
            "x-armadra-csrf": session.csrfToken,
          }),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** 本机 owner：配对票换一个会话。 */
export async function owner(h: OAuthHarness): Promise<Credentials> {
  const ticket = h.service.issueBootstrap({
    hostId: h.service.hostId(),
    instanceId: INSTANCE,
    origin: h.origin,
    deviceName: "本机桌面",
    scopes: allScopes(),
  });
  const response = await call(h, "POST", "pair", { ticket: ticket.ticket });
  const body = (await response.json()) as {
    native?: { accessToken: string };
    csrfToken: string;
    device: { principalId: string };
  };
  return {
    accessToken: body.native?.accessToken ?? "",
    csrfToken: body.csrfToken,
    principalId: body.device.principalId,
  };
}

/** `name=value` 形式的 Set-Cookie 前半，按名字前缀找。 */
export function cookieFrom(response: Response, suffix: string): string {
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";")[0] ?? "";
    const name = pair.slice(0, pair.indexOf("="));
    if (name.endsWith(suffix)) return pair;
  }
  return "";
}

/** 起一次流程：返回授权地址与浏览器绑定 Cookie。 */
export async function start(
  h: OAuthHarness,
  providerId: string,
  body: Record<string, unknown> = {},
  session?: Credentials,
): Promise<{ response: Response; authorizeUrl: string; binding: string }> {
  const response = await call(
    h,
    "POST",
    `oauth/${providerId}/start`,
    body,
    session,
  );
  const binding = cookieFrom(response, "_oauth");
  const json =
    response.status === 200
      ? ((await response.clone().json()) as { authorizeUrl: string })
      : { authorizeUrl: "" };
  return { response, authorizeUrl: json.authorizeUrl, binding };
}

/**
 * 回调：提供方 302 到的那个地址（主机是公网来源），换成 harness 的实际地址打
 * 过去；像浏览器的顶层导航一样不带 Origin。
 */
export function callback(
  h: OAuthHarness,
  location: string,
  binding: string,
): Promise<Response> {
  const url = new URL(location);
  return fetch(`${h.base}${url.pathname}${url.search}`, {
    redirect: "manual",
    headers: {
      ...(binding === "" ? {} : { cookie: binding }),
      "sec-fetch-site": "cross-site",
    },
  });
}

/** 回调跳回去的片段，`#oauth=…&code=…`。 */
export function outcome(response: Response): Record<string, string> {
  const location = response.headers.get("location") ?? "";
  const hash = location.slice(location.indexOf("#") + 1);
  return Object.fromEntries(new URLSearchParams(hash));
}

/** 回调发下的访问 Cookie 当作 Bearer 用（回环来源是原生传输）。 */
export function sessionFrom(response: Response): string {
  const pair = cookieFrom(response, "_access");
  return pair.slice(pair.indexOf("=") + 1);
}
