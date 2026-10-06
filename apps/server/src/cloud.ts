/**
 * `armadra-server cloud …` 与 `armadra-server invite --cloud-link`：对**运行中**的
 * 服务器壳操作个人中转（契约 §31、§33，规格 A4-4）。
 *
 * CLI 是另一个进程，登记、隧道与会话都在 serve 进程的 core 里，所以这里只做两件事：
 *
 *   1. **取本机会话**：读 `endpoints.json` 找 core 的回环地址，向数据目录下 0600 的
 *      私有通道（`core-control.sock`）要一张一次性票，在回环上 `POST
 *      /api/identity/pair` 换一份 Bearer。文件权限就是鉴权——和桌面壳、探针同一条路。
 *      Windows 上私有通道不开，这些命令不可用。
 *   2. **直接问个人中转**（只有 `cloud login` 与 `invite --cloud-link` 需要）：用
 *      core 持有的远程服务会话（`sources.remoteSession`）向中继要注册令牌、建链接。
 *      经 core 的 `networkTransport`，按指纹钉扎。
 *
 * 凭据只在内存里过一遍：口令、注册令牌、访问令牌不进输出、不进日志、不进错误信息；
 * 唯一打印的秘密是分享链接本身（它就是这条命令的产物）。
 */

import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { read as readEndpoints } from "../../desktop/src/core/endpoints";
import { CONTROL_SOCKET } from "../../desktop/src/core/identity/control";
import { endpointsFile } from "../../desktop/src/core/paths";
import {
  type Transport,
  networkTransport,
  normalizeFingerprint,
  normalizeOrigin,
} from "../../desktop/src/core/sources/http-client";
import { single, switched } from "./cli";

type Values = ReadonlyMap<string, readonly string[]>;

/** 登记令牌的环境变量；容器入口用它，CLI 的 `--token` 缺省也读它。 */
export const TOKEN_ENV = "ARMADRA_CLOUD_REGISTRATION_TOKEN";
/** `cloud login` 的口令环境变量（没有终端、也不想走标准输入时）。 */
export const PASSWORD_ENV = "ARMADRA_CLOUD_PASSWORD";

const REQUEST_TIMEOUT_MS = 15_000;
const DEVICE_NAME = "armadra-server cli";

/** 命令的失败：`code` 稳定，`message` 给人看；从不带请求体。 */
export class CloudCliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** 用法错误（退出码 2）而不是运行失败（1）。 */
    readonly usage = false,
  ) {
    super(message);
  }
}

/** 本机 core 上的一个已登录会话。 */
export interface LocalCore {
  call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<unknown>;
}

export interface CloudDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly stdin?: (() => Promise<string>) | undefined;
  /** 终端里不回显地读一行（`cloud login` 的口令）；没有终端是 `undefined`。 */
  readonly prompt?: ((label: string) => Promise<string>) | undefined;
  readonly connect: (dataDir: string) => Promise<LocalCore>;
  readonly transport: Transport;
  readonly now: () => number;
}

export function defaultDeps(
  io: Pick<CloudDeps, "env" | "stdin" | "prompt">,
  overrides: Partial<CloudDeps> = {},
): CloudDeps {
  return {
    env: io.env,
    stdin: io.stdin,
    prompt: io.prompt,
    connect: connectLocalCore,
    transport: networkTransport,
    now: Date.now,
    ...overrides,
  };
}

/* ------------------------------- 本机会话 -------------------------------- */

function controlTicket(dataDir: string, origin: string): Promise<string> {
  const body = Buffer.from(
    JSON.stringify({ origin, deviceName: DEVICE_NAME }),
    "utf8",
  );
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        socketPath: join(dataDir, CONTROL_SOCKET),
        path: "/control/identity/ticket",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.byteLength),
        },
        timeout: 5_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new CloudCliError("control_refused", "私有通道拒绝签票"));
            return;
          }
          try {
            const parsed = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            ) as { ticket?: unknown };
            if (typeof parsed.ticket !== "string") throw new Error("shape");
            resolve(parsed.ticket);
          } catch {
            reject(new CloudCliError("control_refused", "私有通道的答案不对"));
          }
        });
        response.on("error", reject);
      },
    );
    outgoing.on("timeout", () => outgoing.destroy(new Error("timeout")));
    outgoing.on("error", () =>
      reject(
        new CloudCliError(
          "host_unavailable",
          "连不上运行中的服务器壳：先启动 armadra-server serve（同一个 --data-dir）",
        ),
      ),
    );
    outgoing.end(body);
  });
}

function failureOf(status: number, text: string): CloudCliError {
  let code = "internal";
  let message = `请求失败（${status}）`;
  try {
    const parsed = JSON.parse(text) as { code?: unknown; message?: unknown };
    if (typeof parsed.code === "string") code = parsed.code;
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // 不是 JSON：只报状态码，原文不外泄。
  }
  return new CloudCliError(code, message);
}

export async function connectLocalCore(dataDir: string): Promise<LocalCore> {
  if (process.platform === "win32") {
    throw new CloudCliError(
      "unsupported_platform",
      "Windows 上服务器壳没有私有通道，这条命令不可用",
    );
  }
  const base = readEndpoints(endpointsFile(dataDir)).runtime?.http;
  if (base === undefined) {
    throw new CloudCliError(
      "host_unavailable",
      "找不到运行中的服务器壳：先启动 armadra-server serve（同一个 --data-dir）",
    );
  }
  const root = base.replace(/\/+$/, "");
  const origin = new URL(root).origin;
  const ticket = await controlTicket(dataDir, origin);
  let paired: Response;
  try {
    paired = await fetch(`${root}/api/identity/pair`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
  } catch {
    throw new CloudCliError("host_unavailable", "连不上运行中的服务器壳");
  }
  const text = await paired.text();
  if (!paired.ok) throw failureOf(paired.status, text);
  const accessToken = (
    JSON.parse(text) as { native?: { accessToken?: unknown } }
  ).native?.accessToken;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new CloudCliError("control_refused", "配对没有给出会话");
  }
  return {
    async call(method, path, body) {
      let response: Response;
      try {
        response = await fetch(`${root}${path}`, {
          method,
          headers: {
            origin,
            authorization: `Bearer ${accessToken}`,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        throw new CloudCliError("host_unavailable", "连不上运行中的服务器壳");
      }
      const answer = await response.text();
      if (!response.ok) throw failureOf(response.status, answer);
      return answer === "" ? {} : JSON.parse(answer);
    },
  };
}

/* -------------------------------- 取值 ---------------------------------- */

function usage(message: string): never {
  throw new CloudCliError("usage", message, true);
}

function issuerOf(values: Values): string {
  const given = single(values, "--issuer");
  if (given === undefined) usage("需要 --issuer（个人中转的地址）");
  try {
    return normalizeOrigin(given);
  } catch {
    return usage(`--issuer 不是一个合法地址：${given}`);
  }
}

function fingerprintOf(values: Values): string {
  try {
    return normalizeFingerprint(single(values, "--fingerprint"));
  } catch {
    return usage("--fingerprint 应为 64 位十六进制");
  }
}

async function firstLine(
  deps: CloudDeps,
  what: string,
): Promise<string | undefined> {
  if (deps.stdin === undefined) return undefined;
  const value = (await deps.stdin()).replace(/\r?\n$/, "");
  if (value === "" || /[\r\n]/.test(value)) {
    usage(`标准输入要是一行非空的${what}`);
  }
  return value;
}

async function registrationToken(
  values: Values,
  deps: CloudDeps,
): Promise<string> {
  if (switched(values, "--token-stdin")) {
    const value = await firstLine(deps, "令牌");
    if (value === undefined) usage("--token-stdin 需要标准输入");
    return value;
  }
  const value = single(values, "--token") ?? deps.env[TOKEN_ENV];
  if (value === undefined || value.trim() === "") {
    return usage(`需要注册令牌：--token、--token-stdin 或 ${TOKEN_ENV}`);
  }
  return value.trim();
}

async function accountPassword(
  values: Values,
  deps: CloudDeps,
): Promise<string> {
  if (switched(values, "--password-stdin")) {
    const value = await firstLine(deps, "口令");
    if (value === undefined) usage("--password-stdin 需要标准输入");
    return value;
  }
  const fromEnv = deps.env[PASSWORD_ENV];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (deps.prompt !== undefined) {
    const typed = await deps.prompt("口令：");
    if (typed !== "") return typed;
  }
  return usage(
    `需要口令：--password-stdin、${PASSWORD_ENV}，或在终端里运行以便提示输入`,
  );
}

/** `7d` / `12h` / `30m` → 毫秒；core 再夹到 30 天。 */
export function parseExpires(value: string): number | undefined {
  const match = /^(\d{1,6})([mhd])$/.exec(value);
  if (match === null) return undefined;
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as "m" | "h" | "d"
  ];
  const ms = Number(match[1]) * unit;
  return ms > 0 ? ms : undefined;
}

/* ------------------------------ 个人中转 -------------------------------- */

interface TunnelView {
  state: string;
  node: string | null;
}

function tunnelText(tunnel: TunnelView | undefined): string {
  if (tunnel === undefined) return "未知";
  return tunnel.node === null
    ? tunnel.state
    : `${tunnel.state}（${tunnel.node}）`;
}

async function relayCall(
  deps: CloudDeps,
  input: {
    issuer: string;
    fingerprint: string;
    method: "GET" | "POST";
    path: string;
    accessToken: string;
    body?: unknown;
  },
): Promise<Record<string, unknown>> {
  let answer: Awaited<ReturnType<Transport>>;
  try {
    answer = await deps.transport({
      method: input.method,
      url: `${input.issuer}${input.path}`,
      headers: { authorization: `Bearer ${input.accessToken}` },
      ...(input.body === undefined ? {} : { body: input.body }),
      fingerprint: input.fingerprint,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new CloudCliError(
      typeof code === "string" ? code : "source_unreachable",
      error instanceof Error ? error.message : "连不上个人中转",
    );
  }
  const body =
    typeof answer.body === "object" && answer.body !== null
      ? (answer.body as Record<string, unknown>)
      : {};
  if (answer.status < 200 || answer.status >= 300) {
    throw new CloudCliError(
      typeof body.code === "string" ? body.code : "source_unreachable",
      typeof body.message === "string"
        ? body.message
        : `个人中转没有完成请求（${answer.status}）`,
    );
  }
  return body;
}

interface RemoteRow {
  serviceId: string;
  issuer: string;
  fingerprint: string;
  registered: boolean;
}

async function remoteFor(core: LocalCore, issuer: string): Promise<RemoteRow> {
  const listed = (await core.call("GET", "/api/sources")) as {
    remotes?: RemoteRow[];
  };
  const found = (listed.remotes ?? []).find((row) => row.issuer === issuer);
  if (found === undefined) {
    throw new CloudCliError(
      "not_found",
      "没有登录这个个人中转：先 armadra-server cloud login",
    );
  }
  return found;
}

async function remoteAccess(
  core: LocalCore,
  serviceId: string,
): Promise<string> {
  const session = (await core.call(
    "POST",
    `/api/sources/remotes/${serviceId}/session`,
    {},
  )) as { accessToken?: unknown };
  if (typeof session.accessToken !== "string" || session.accessToken === "") {
    throw new CloudCliError("source_unauthorized", "个人中转的登录已失效");
  }
  return session.accessToken;
}

type Emit = (document: unknown, text: () => string) => void;

async function register(
  core: LocalCore,
  body: {
    issuer: string;
    registrationToken: string;
    label?: string | undefined;
    fingerprint?: string | undefined;
  },
): Promise<{ registered: boolean; tunnel?: TunnelView }> {
  try {
    const answer = (await core.call("POST", "/api/identity/cloud/register", {
      issuer: body.issuer,
      registrationToken: body.registrationToken,
      ...(body.label === undefined ? {} : { label: body.label }),
      ...(body.fingerprint === undefined || body.fingerprint === ""
        ? {}
        : { fingerprint: body.fingerprint }),
    })) as { tunnel?: TunnelView };
    return {
      registered: true,
      ...(answer.tunnel === undefined ? {} : { tunnel: answer.tunnel }),
    };
  } catch (error) {
    // 幂等：已经登记过就当完成（容器每次启动都会跑一遍）。
    if (
      error instanceof CloudCliError &&
      error.code === "cloud_already_registered"
    ) {
      return { registered: false };
    }
    throw error;
  }
}

/** 登记后隧道要几秒才连上；等到 ready 或超时，返回最后看到的状态。 */
async function settle(
  core: LocalCore,
  issuer: string,
  deps: CloudDeps,
  wait: (ms: number) => Promise<void>,
): Promise<TunnelView | undefined> {
  const deadline = deps.now() + 10_000;
  let last: TunnelView | undefined;
  for (;;) {
    const status = (await core.call("GET", "/api/identity/cloud")) as {
      registrations?: { issuer: string; tunnel?: TunnelView }[];
    };
    last = status.registrations?.find((row) => row.issuer === issuer)?.tunnel;
    if (last?.state === "ready" || deps.now() >= deadline) return last;
    await wait(500);
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

export async function runCloud(
  positionals: readonly string[],
  values: Values,
  dataDir: string,
  deps: CloudDeps,
  emit: Emit,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  const action = positionals[0];
  if (
    action !== "register" &&
    action !== "revoke" &&
    action !== "status" &&
    action !== "login"
  ) {
    usage("用法: armadra-server cloud register | revoke | status | login");
  }
  // 参数与凭据先于任何连接取齐：用法错误不该先去敲运行中的服务。
  if (action === "register") {
    const issuer = issuerOf(values);
    const token = await registrationToken(values, deps);
    const fingerprint = fingerprintOf(values);
    const label = single(values, "--label");
    const core = await deps.connect(dataDir);
    const done = await register(core, {
      issuer,
      registrationToken: token,
      label,
      fingerprint,
    });
    const tunnel = done.registered
      ? await settle(core, issuer, deps, wait)
      : undefined;
    emit({ command: "cloud register", issuer, ...done, tunnel }, () =>
      done.registered
        ? `已登记 ${issuer}，隧道 ${tunnelText(tunnel)}`
        : `已经登记到 ${issuer}，跳过`,
    );
    return;
  }
  if (action === "revoke") {
    const issuer = issuerOf(values);
    const core = await deps.connect(dataDir);
    await core.call(
      "DELETE",
      `/api/identity/cloud/register?issuer=${encodeURIComponent(issuer)}`,
    );
    // 中继侧的源记录要远程服务 owner 的会话才删得掉（契约 §31.4）；服务器壳多半
    // 没有那份会话，没删掉就如实说「中继侧待清理」和码。
    const pending = (await core.call(
      "GET",
      "/api/identity/cloud/relay-pending",
    )) as { pending?: { issuer?: string; code?: string }[] };
    const relayPending =
      pending.pending?.find((one) => one.issuer === issuer)?.code ?? null;
    emit(
      { command: "cloud revoke", issuer, revoked: true, relayPending },
      () =>
        relayPending === null
          ? `已撤销 ${issuer} 的登记`
          : `已撤销 ${issuer} 的登记；中继侧待清理（${relayPending}）`,
    );
    return;
  }
  if (action === "status") {
    const core = await deps.connect(dataDir);
    const status = (await core.call("GET", "/api/identity/cloud")) as {
      sourceId?: string;
      registrations?: {
        issuer: string;
        mode: string;
        label?: string;
        tunnel?: TunnelView;
        relayOrigins?: string[];
      }[];
    };
    const rows = status.registrations ?? [];
    emit(
      {
        command: "cloud status",
        sourceId: status.sourceId,
        registrations: rows,
      },
      () =>
        rows.length === 0
          ? "没有登记到任何个人中转"
          : rows
              .map(
                (row) =>
                  `${row.issuer}（${row.mode}）隧道 ${tunnelText(row.tunnel)}`,
              )
              .join("\n"),
    );
    return;
  }
  // login
  const issuer = issuerOf(values);
  const account = single(values, "--account");
  if (account === undefined || account === "") usage("需要 --account");
  const fingerprint = fingerprintOf(values);
  const label = single(values, "--label");
  const password = await accountPassword(values, deps);
  const core = await deps.connect(dataDir);
  const added = (await core.call("POST", "/api/sources/remotes", {
    kind: "personal",
    issuer,
    account,
    password,
    ...(label === undefined ? {} : { label }),
    ...(fingerprint === "" ? {} : { fingerprint }),
  })) as { remote?: RemoteRow };
  const remote = added.remote;
  if (remote === undefined) {
    throw new CloudCliError("internal", "登录的答案不完整");
  }
  const access = await remoteAccess(core, remote.serviceId);
  const issued = await relayCall(deps, {
    issuer,
    fingerprint: remote.fingerprint,
    method: "POST",
    path: "/v1/sources/registration-tokens",
    accessToken: access,
    body: {},
  });
  if (typeof issued.registrationToken !== "string") {
    throw new CloudCliError("source_unreachable", "个人中转没有给出注册令牌");
  }
  const done = await register(core, {
    issuer,
    registrationToken: issued.registrationToken,
    label,
  });
  const tunnel = done.registered
    ? await settle(core, issuer, deps, wait)
    : undefined;
  emit({ command: "cloud login", issuer, account, ...done, tunnel }, () =>
    done.registered
      ? `已登录 ${issuer} 并登记，隧道 ${tunnelText(tunnel)}`
      : `已登录 ${issuer}；本机早已登记，跳过`,
  );
}

/* ------------------------------- 分享链接 ------------------------------- */

export async function runInvite(
  values: Values,
  dataDir: string,
  deps: CloudDeps,
  emit: Emit,
): Promise<void> {
  if (!switched(values, "--cloud-link")) {
    usage("invite 目前只支持 --cloud-link（经个人中转生成分享链接）");
  }
  const issuer = issuerOf(values);
  const workspace = single(values, "--workspace");
  const group = single(values, "--group");
  if ((workspace === undefined) === (group === undefined)) {
    usage("--workspace 与 --group 二选一");
  }
  const role = single(values, "--role") ?? "viewer";
  const maxText = single(values, "--max-uses");
  let maxUses: number | undefined;
  if (maxText !== undefined) {
    maxUses = /^\d{1,4}$/.test(maxText) ? Number(maxText) : 0;
    if (maxUses < 1 || maxUses > 1000)
      usage("--max-uses 应为 1 到 1000 的整数");
  }
  const expiresText = single(values, "--expires");
  let ttlMs: number | undefined;
  if (expiresText !== undefined) {
    ttlMs = parseExpires(expiresText);
    if (ttlMs === undefined) usage("--expires 形如 30m、12h、7d");
  }
  const label = (single(values, "--label") ?? "Armadra").slice(0, 128);
  const core = await deps.connect(dataDir);
  const remote = await remoteFor(core, issuer);
  const status = (await core.call("GET", "/api/identity/cloud")) as {
    sourceId?: string;
    registrations?: { issuer: string }[];
  };
  if (
    status.sourceId === undefined ||
    !(status.registrations ?? []).some((row) => row.issuer === issuer)
  ) {
    throw new CloudCliError(
      "cloud_not_registered",
      "本机还没有登记到这个个人中转：先 armadra-server cloud register 或 cloud login",
    );
  }
  const access = await remoteAccess(core, remote.serviceId);
  const invitation = (await core.call("POST", "/api/identity/invitations", {
    role,
    ...(workspace === undefined
      ? { targetGroupId: group }
      : { targetWorkspaceId: workspace }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ...(maxUses === undefined ? {} : { maxUses }),
  })) as { invitationId: string; token: string; expiresAtMs: number };
  try {
    const link = await relayCall(deps, {
      issuer,
      fingerprint: remote.fingerprint,
      method: "POST",
      path: "/v1/links",
      accessToken: access,
      body: {
        kind: "source_invite",
        sourceId: status.sourceId,
        invitationId: invitation.invitationId,
        label,
        role,
        expiresAtMs: invitation.expiresAtMs,
        ...(maxUses === undefined ? {} : { maxUses }),
      },
    });
    if (typeof link.url !== "string" || typeof link.secret !== "string") {
      throw new CloudCliError("source_unreachable", "个人中转没有给出分享链接");
    }
    const url = `${link.url}#${link.secret}.${invitation.token}`;
    emit(
      {
        command: "invite",
        cloudLink: true,
        invitationId: invitation.invitationId,
        linkId: link.linkId,
        url,
        expiresAtMs: link.expiresAtMs ?? invitation.expiresAtMs,
        maxUses: maxUses ?? 1,
        role,
      },
      () => url,
    );
  } catch (error) {
    // 链接没建成：邀请不留着，免得一张没人知道的门票挂在库里。
    await core
      .call("DELETE", `/api/identity/invitations/${invitation.invitationId}`)
      .catch(() => undefined);
    throw error;
  }
}
