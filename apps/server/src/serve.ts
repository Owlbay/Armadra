import { DOMAINS, type RunningCore, run } from "../../desktop/src/core/main";
import { gatewayDomainOf, startAcme } from "../../desktop/src/core/gateway";
import type { AcmeManager } from "../../desktop/src/core/gateway/acme";
import {
  type Gateway,
  openGateway,
} from "../../desktop/src/core/gateway/listener";
import {
  type ListenAddress,
  loopbackHost,
  originsFor as gatewayOrigins,
  certificateHosts as gatewayCertificateHosts,
} from "../../desktop/src/core/gateway/network";
import type { TlsMaterial } from "../../desktop/src/core/gateway/tls";
import {
  type WebRoot,
  openWebRoot,
} from "../../desktop/src/core/gateway/web-root";
import { AccountsService } from "../../desktop/src/core/identity/accounts";
import { IdentityStore } from "../../desktop/src/core/identity/store";
import { allScopes } from "../../desktop/src/core/identity/scopes";
import {
  type ServerDiagnostics,
  installServerDiagnostics,
} from "./diagnostics";
import { serverPlatform } from "./platform-node";
import { serverSecrets } from "./secrets";

/**
 * `serve`：在**同一个进程**里装配 core，然后「解析参数 → `openGateway`」。
 *
 * TLS、准入、CSP、页面根目录都在 core 的 Gateway 域里（`core/gateway/`，桌面壳
 * 的对外服务用的是同一份）；这里只剩服务器壳自己的那几件事：拒绝不声明来源
 * 就挂到非回环地址上、没有管理员时提示配对、命令行上签邀请。
 *
 * 打包选型：`esbuild`（`scripts/build.mjs`）。理由是 core 与桌面壳共用的
 * electron-vite 也是 esbuild 系，同一个 bundler 的外部化规则不会在两种壳之间
 * 分叉；`node-pty` 等原生模块一律 `--external`，因为它们要按自己的相对路径找
 * `build/Release/*.node`。
 */

export interface ServeOptions {
  readonly listen: ListenAddress;
  readonly publicOrigins: readonly string[];
  readonly dataDir?: string | undefined;
  readonly webRoot: string;
  readonly certFile?: string | undefined;
  readonly keyFile?: string | undefined;
  /**
   * ACME 的联系邮箱（`--acme` / `ARMADRA_ACME_EMAIL`）：给了就由 core 的 ACME
   * 管理器签证书并续期（`core/gateway/acme.ts`），其余 `ARMADRA_ACME_*` 从
   * `env` 读。与 `certFile` / `keyFile` 互斥。
   */
  readonly acmeEmail?: string | undefined;
  readonly deviceName: string;
  /** 启动时铸一张配对票并打印。`--no-pairing` 时为假。 */
  readonly pairing: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: (line: string) => void;
  readonly moduleDir?: string;
}

export interface RunningServer {
  readonly core: RunningCore;
  readonly address: ListenAddress;
  readonly origin: string;
  readonly origins: readonly string[];
  readonly tls: TlsMaterial;
  readonly webRoot: WebRoot;
  readonly hostId: string;
  /** 这次启动铸的配对票，`--no-pairing` 时是 `undefined`。 */
  readonly pairingTicket: string | undefined;
  /** 再铸一张，用于 SIGUSR2 与测试。 */
  pair(): { ticket: string; url: string; expiresAtMs: number };
  /** 这台服务器有没有管理员（owner）了。没有时第一张配对票兑换出来的就是它。 */
  hasAdmin(): boolean;
  /**
   * 以管理员的名义签一张邀请，给运维在命令行上发链接用；页面上签的是同一种。
   * 链接落在页面根上的片段里（{@link invitationUrl}）。
   */
  invite(input: {
    role: string;
    targetGroupId?: string;
    targetWorkspaceId?: string;
  }): { invitationId: string; url: string; expiresAtMs: number };
  stop(): Promise<void>;
}

/**
 * 这次运行接受的来源集合：显式给的 `--public-origin`，加上监听地址自己那个。
 * 后者是为了「直接用 IP 访问」这条路能走通；它不会放宽任何东西——那个地址本来
 * 就是这台服务器自己。
 */
export function originsFor(
  address: ListenAddress,
  publicOrigins: readonly string[],
): string[] {
  return gatewayOrigins([address.host], address.port, publicOrigins);
}

/**
 * 邀请兑换页的入口：页面根上的 `#invite=<令牌>`。
 *
 * 和配对票同一条理由放在片段里：片段不上请求行，于是令牌不进任何访问日志，
 * 也不进 `Referer`。页面读到它就打开兑换对话框（起名、设口令），兑换走的是
 * `POST /api/identity/register`——身份域自己的匿名面，门在 Gateway 的准入里放行。
 */
export function invitationUrl(origin: string, token: string): string {
  return `${origin}/#invite=${token}`;
}

/** 自签名证书要覆盖的名字。 */
export function certificateHosts(
  address: ListenAddress,
  publicOrigins: readonly string[],
): string[] {
  return gatewayCertificateHosts([address.host], publicOrigins);
}

export async function serve(options: ServeOptions): Promise<RunningServer> {
  if (
    !loopbackHost(options.listen.host) &&
    options.publicOrigins.length === 0
  ) {
    throw new Error(
      `拒绝在 ${options.listen.host} 上监听而不声明对外来源：加 --public-origin https://主机名`,
    );
  }
  const acmeEmail = options.acmeEmail?.trim() || undefined;
  if (
    acmeEmail !== undefined &&
    (options.certFile !== undefined || options.keyFile !== undefined)
  ) {
    throw new Error("--acme 与 --tls-cert / --tls-key 只能二选一");
  }
  if (acmeEmail !== undefined && options.publicOrigins.length === 0) {
    throw new Error(
      "--acme 需要 --public-origin https://域名：证书签给对外来源的主机名",
    );
  }
  const webRoot = await openWebRoot(options.webRoot);
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    // 服务器壳只在统一库上跑：身份表是它的认证前提，没过单向门的库里没有它们。
    ARMADRA_CORE: "ts",
  };
  const stdout =
    options.stdout ?? ((line: string) => process.stdout.write(line));
  let diagnostics: ServerDiagnostics | undefined;
  const core = await run({
    // core 自己的监听留在回环：对外这一侧由 Gateway 的 TLS 服务负责。
    argv: [
      "--listen",
      "tcp:127.0.0.1:0",
      ...(options.dataDir === undefined ? [] : ["--data-dir", options.dataDir]),
    ],
    env,
    domains: DOMAINS,
    stdout,
    ...(options.moduleDir === undefined
      ? {}
      : { moduleDir: options.moduleDir }),
    platform: (base) => {
      // 可选崩溃上报（外部服务 §11.2）：没配 DSN 时只写本地日志。
      diagnostics = installServerDiagnostics({
        dataDir: base.dataDir,
        env,
        release: base.appVersion,
        log: base.log,
      });
      return {
        ...serverPlatform(base),
        secrets: serverSecrets(base.dataDir, env),
        reportError: diagnostics.reportError,
        // 页面错误上报（契约 §30）：DSN 可能来自环境变量，只有壳知道在不在发。
        crashReportingActive: () => (diagnostics?.active() ?? null) !== null,
      };
    },
  });
  const log = core.platform.log;
  if (!core.db.unified) {
    await core.stop();
    await diagnostics?.stop();
    throw new Error(
      "这个数据目录还没过统一库迁移，服务器壳没有身份表可用；先用桌面壳跑一次 ARMADRA_CORE=ts",
    );
  }

  const store = new IdentityStore(core.db.database);
  const accounts = new AccountsService({ store });
  const hasAdmin = () => store.transaction((tx) => tx.owner() !== undefined);

  let gateway: Gateway;
  let acme: AcmeManager | undefined;
  try {
    // ACME 先签（或读出数据目录里还能用的那张）再监听。
    acme =
      acmeEmail === undefined
        ? undefined
        : await startAcme(core, {
            email: acmeEmail,
            publicOrigins: options.publicOrigins,
            env,
          });
    gateway = await openGateway(core, {
      listen: options.listen,
      publicOrigins: options.publicOrigins,
      hosts: () => [options.listen.host],
      tls:
        acme !== undefined
          ? { generated: "acme" }
          : {
              certFile: options.certFile,
              keyFile: options.keyFile,
              generated: "selfSigned",
            },
      webRoot,
      deviceName: options.deviceName,
    });
  } catch (error) {
    await acme?.close();
    await core.stop();
    await diagnostics?.stop();
    throw error;
  }
  // 续期成功后热换证书，已有连接不断。
  acme?.onRenewed(() => gateway.refresh());
  // `/api/gateway` 报的就是这一个；它的配置来自命令行，设置页改不动它。
  gatewayDomainOf(core.server)?.adopt(gateway, acme);
  const origin = gateway.origin();
  const hostId = gateway.hostId;

  const pair = (): { ticket: string; url: string; expiresAtMs: number } => {
    const issued = gateway.pair();
    return {
      ticket: issued.ticket,
      expiresAtMs: issued.expiresAtMs,
      // 票只进片段，不进路径也不进查询：片段不上请求行，因此不进任何访问日志。
      url: `${origin}/#pair=${issued.ticket}`,
    };
  };

  const invite = (input: {
    role: string;
    targetGroupId?: string;
    targetWorkspaceId?: string;
  }): { invitationId: string; url: string; expiresAtMs: number } => {
    const owner = store.transaction((tx) => tx.owner());
    if (owner === undefined) {
      throw new Error("还没有管理员：先用配对链接成为第一个管理员");
    }
    const issued = accounts.issueInvitation(
      { principalId: owner.principalId, kind: "owner", scopes: allScopes() },
      input,
    );
    return {
      invitationId: issued.invitationId,
      url: invitationUrl(origin, issued.token),
      expiresAtMs: issued.expiresAtMs,
    };
  };

  const tls = gateway.tls();
  log.info("Armadra 服务器壳已就绪", {
    origin,
    tls:
      tls.source === "acme"
        ? `ACME（有效期至 ${tls.notAfter}）`
        : tls.selfSigned
          ? "自签名"
          : tls.certFile,
    webRoot: webRoot.directory,
  });
  let pairingTicket: string | undefined;
  if (!hasAdmin()) {
    // 首个管理员：服务器上还没有 owner 时，第一张被兑换的配对票就铸出它，此后
    // 它在「设置 → 账号与共享」里管理成员、组与共享。
    log.info("这台服务器还没有管理员：打开下面的配对链接成为第一个管理员");
  }
  if (options.pairing) {
    const issued = pair();
    pairingTicket = issued.ticket;
    stdout(`armadra-server pairing ${issued.url}\n`);
  }

  return {
    core,
    address: gateway.address,
    origin,
    origins: gateway.origins(),
    tls,
    webRoot,
    hostId,
    pairingTicket,
    pair,
    hasAdmin,
    invite,
    stop: async () => {
      await gateway.close();
      await acme?.close();
      await core.stop();
      await diagnostics?.stop();
    },
  };
}
