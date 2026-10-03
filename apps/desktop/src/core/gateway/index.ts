/**
 * Gateway 域：对外 HTTPS 监听、准入（Cookie / Bearer）、本地 CA 与叶证书、
 * 配对票与二维码（补全架构 §7，契约 §17）。
 *
 * 边界：
 *   * 服务器壳的 `serve` 只是「解析参数 → `openGateway`」，再把打开的那个交给
 *     这里（{@link GatewayDomain.adopt}）——之后 `/api/gateway` 报的就是它，
 *     配置来自命令行，设置改不动（409 `gateway_managed_by_shell`）。
 *   * 桌面壳：配置在设置 `gateway.*`（本机路径，不随账号走），`install` 时按
 *     设置开启；`PUT /api/gateway` 写设置并对账；关掉即刻停止监听并断开流。
 *   * `/api/gateway*` 只有 owner（全局 `settings:*`，成员只有工作空间授权，
 *     所以一律 403）。
 *   * 装配在所有域之后：开始对外监听时，每条路由都必须已经登记。
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CoreServer } from "../http/server";
import type { ErrorResponse } from "../http/errors";
import { coreError } from "../http/errors";
import type { CoreContext } from "../main";
import { completionSettings, settingsDomain } from "../settings";
import type { JsonObject } from "../settings/local";
import {
  AcmeError,
  AcmeManager,
  type AcmeManagerOptions,
  acmeConfigFrom,
} from "./acme";
import { type Gateway, GatewayError, openGateway } from "./listener";
import {
  type ListenMode,
  bindHost,
  gatewayHosts,
  interfaceAddresses,
  privateAddresses,
} from "./network";
import { pairingJson } from "./pairing";
import {
  GATEWAY_MANAGED,
  GATEWAY_NOT_RUNNING,
  getGateway,
  postPairing,
  putGateway,
} from "./routes";
import {
  type GatewayConfigView,
  type GatewayFailure,
  statusJson,
} from "./status";
import { type WebRoot, openWebRoot } from "./web-root";

export { openGateway, type Gateway } from "./listener";

/** 私网地址多久复查一次；变了就换来源白名单并重签叶证书。 */
export const ADDRESS_POLL_MS = 30_000;

/** 配对出来的设备的缺省名字。 */
const DEVICE_NAME = "Gateway 配对";

export interface GatewayDomainOptions {
  /** 页面产物在哪；不给按 {@link defaultGatewayWebRoot} 找，找不到只服务 API。 */
  readonly webRoot?: () => Promise<WebRoot | undefined>;
  /** 测试用：地址来源。 */
  readonly addresses?: () => { privates: string[]; all: string[] };
  readonly pollMs?: number;
  /** 测试用：ACME 的签发器、时钟与计时器（`log` 由域自己给）。 */
  readonly acme?: Omit<AcmeManagerOptions, "log">;
}

/**
 * 按邮箱与对外来源开一个 ACME 管理器并拿到第一张证书（`./acme.ts`）。服务器壳
 * 的 `--acme` 与桌面设置 `gateway.tls.source = "acme"` 走的都是它；之后
 * `openGateway` 用 `tls.generated = "acme"` 读它写下的文件，续期后
 * `gateway.refresh()` 热换。错误统一成 {@link GatewayError}。
 */
export async function startAcme(
  context: CoreContext,
  input: {
    readonly email: string;
    readonly publicOrigins: readonly string[];
    readonly env?: NodeJS.ProcessEnv;
  },
  options: Omit<AcmeManagerOptions, "log"> = {},
): Promise<AcmeManager> {
  try {
    const config = acmeConfigFrom({
      email: input.email,
      publicOrigins: input.publicOrigins,
      env: input.env ?? process.env,
    });
    const manager = new AcmeManager(context.dataDir, config, {
      log: context.log,
      onAlert: (status) =>
        context.log.error("ACME 续期已连续失败，仍在用旧证书", {
          failures: status.failures,
          notAfter: status.notAfter,
          error: status.lastError?.message,
        }),
      ...options,
    });
    await manager.start();
    return manager;
  } catch (error) {
    if (error instanceof AcmeError) {
      throw new GatewayError(error.code, error.message);
    }
    throw error;
  }
}

export class GatewayDomain {
  private current: Gateway | undefined;
  private acme: AcmeManager | undefined;
  private managed = false;
  private failure: GatewayFailure | undefined;
  private queue: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  /** 这一次打开时用的配置，变了才重开。 */
  private openedWith = "";

  constructor(
    private readonly context: CoreContext,
    private readonly options: GatewayDomainOptions = {},
  ) {}

  config(): GatewayConfigView {
    const document = settingsDomain()?.settings.snapshot() ?? {};
    return completionSettings(document).gateway as GatewayConfigView;
  }

  gateway(): Gateway | undefined {
    return this.current;
  }

  /** 服务器壳把它打开的那个交给这里；之后设置不再驱动 Gateway。 */
  adopt(gateway: Gateway, acme?: AcmeManager): void {
    this.managed = true;
    this.current = gateway;
    this.acme = acme;
    this.failure = undefined;
  }

  status(): Record<string, unknown> {
    const config = this.config();
    return statusJson({
      config: this.managed
        ? { ...config, enabled: true, port: this.current?.address.port ?? 0 }
        : config,
      managedBy: this.managed ? "shell" : "settings",
      gateway: this.current,
      acme: this.acme?.status(),
      error: this.failure,
    });
  }

  /** 按当前设置开、关或重开。串行：两次 PUT 不会交错地开两个监听。 */
  reconcile(): Promise<void> {
    const next = this.queue.then(() => this.reconcileNow());
    this.queue = next.catch(() => undefined);
    return next;
  }

  async configure(patch: JsonObject): Promise<ErrorResponse | undefined> {
    if (this.managed) return GATEWAY_MANAGED;
    const settings = settingsDomain()?.settings;
    if (settings === undefined) {
      return coreError(503, "settings_unavailable", "设置域没有装配");
    }
    settings.patch({ gateway: patch });
    await this.reconcile();
    return undefined;
  }

  pair(input: {
    origin?: string;
    deviceName?: string;
  }): Record<string, unknown> | ErrorResponse {
    const gateway = this.current;
    if (gateway === undefined) return GATEWAY_NOT_RUNNING;
    try {
      return pairingJson(gateway.pair(input));
    } catch (error) {
      if (error instanceof GatewayError) {
        return coreError(400, error.code, error.message);
      }
      throw error;
    }
  }

  /** core 停下时调：关掉监听与地址轮询。幂等。 */
  async close(): Promise<void> {
    this.stopped = true;
    this.stopPolling();
    await this.queue;
    const gateway = this.current;
    const acme = this.acme;
    this.current = undefined;
    this.acme = undefined;
    await gateway?.close();
    await acme?.close();
  }

  private async reconcileNow(): Promise<void> {
    if (this.managed || this.stopped) return;
    const config = this.config();
    const fingerprint = JSON.stringify({ ...config, enabled: undefined });
    if (!config.enabled) {
      await this.shut();
      this.failure = undefined;
      return;
    }
    if (this.current !== undefined && fingerprint === this.openedWith) return;
    await this.shut();
    try {
      this.current = await this.open(config);
      this.openedWith = JSON.stringify({
        ...this.config(),
        enabled: undefined,
      });
      this.failure = undefined;
      this.startPolling(config.listen);
      this.context.log.info("Gateway 已开启", {
        origin: this.current.origin(),
        tls: this.current.tls().source,
      });
    } catch (error) {
      this.failure =
        error instanceof GatewayError
          ? { code: error.code, message: error.message }
          : {
              code: listenErrorCode(error),
              message: error instanceof Error ? error.message : String(error),
            };
      this.context.log.warn("Gateway 没能开启", { ...this.failure });
    }
  }

  private async open(config: GatewayConfigView): Promise<Gateway> {
    const source = config.tls.source;
    if (
      source === "file" &&
      (config.tls.certFile === "" || config.tls.keyFile === "")
    ) {
      throw new GatewayError(
        "tls_files_missing",
        "指定文件的证书来源要同时给证书与私钥路径",
      );
    }
    const mode = config.listen;
    const addresses = () =>
      this.options.addresses?.() ?? {
        privates: privateAddresses(),
        all: interfaceAddresses(),
      };
    const webRoot = await (this.options.webRoot ?? defaultGatewayWebRoot)();
    const publicOrigins =
      config.publicOrigin === "" ? [] : [config.publicOrigin];
    // ACME 先签（或读出手里那张）再监听：签不出来就不开，原因进状态。
    const acme =
      source === "acme"
        ? await startAcme(
            this.context,
            { email: config.tls.acmeEmail, publicOrigins },
            this.options.acme,
          )
        : undefined;
    let gateway: Gateway;
    try {
      gateway = await this.listen(config, mode, addresses, webRoot, acme);
    } catch (error) {
      await acme?.close();
      throw error;
    }
    if (acme !== undefined) {
      acme.onRenewed(() => gateway.refresh());
      this.acme = acme;
    }
    // 端口 0 = 首次由内核分配，写回设置固定下来：手机记住的地址下次还在。
    if (config.port === 0) {
      settingsDomain()?.settings.patch({
        gateway: { port: gateway.address.port },
      });
    }
    return gateway;
  }

  private listen(
    config: GatewayConfigView,
    mode: ListenMode,
    addresses: () => { privates: string[]; all: string[] },
    webRoot: WebRoot | undefined,
    acme: AcmeManager | undefined,
  ): Promise<Gateway> {
    const source = config.tls.source;
    return openGateway(this.context, {
      listen: { host: bindHost(mode), port: config.port },
      mode,
      publicOrigins: config.publicOrigin === "" ? [] : [config.publicOrigin],
      hosts: () => gatewayHosts(mode, addresses()),
      privateAddresses: () => addresses().privates,
      tls:
        acme !== undefined
          ? { generated: "acme" }
          : source === "file"
            ? {
                certFile: config.tls.certFile,
                keyFile: config.tls.keyFile,
                generated: "localCa",
              }
            : { generated: "localCa" },
      webRoot,
      deviceName: DEVICE_NAME,
    });
  }

  private async shut(): Promise<void> {
    this.stopPolling();
    const gateway = this.current;
    const acme = this.acme;
    this.current = undefined;
    this.acme = undefined;
    this.openedWith = "";
    await gateway?.close();
    await acme?.close();
  }

  private startPolling(mode: ListenMode): void {
    this.stopPolling();
    if (mode === "loopback") return;
    this.timer = setInterval(() => {
      try {
        this.current?.refresh();
      } catch (error) {
        this.context.log.warn("Gateway 地址复查失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, this.options.pollMs ?? ADDRESS_POLL_MS);
    this.timer.unref();
  }

  private stopPolling(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

function listenErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === "EADDRINUSE") return "port_in_use";
  if (code === "EACCES") return "port_forbidden";
  return "gateway_failed";
}

/**
 * 桌面壳的页面产物：`ARMADRA_GATEWAY_WEB_ROOT`，或打包后 core 旁边的
 * `../renderer`（`out/core/main.js` 与 `out/renderer/` 同级），或开发检出里的
 * `apps/web/dist`。都没有就只服务 API——原生 App 的页面在包里，不需要它。
 */
export async function defaultGatewayWebRoot(): Promise<WebRoot | undefined> {
  const candidates = [
    process.env.ARMADRA_GATEWAY_WEB_ROOT,
    process.argv[1] === undefined
      ? undefined
      : resolve(dirname(process.argv[1]), "../renderer"),
    checkoutWebRoot(process.cwd()),
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || !existsSync(join(candidate, "index.html"))) {
      continue;
    }
    try {
      return await openWebRoot(candidate);
    } catch {
      /* 下一个。 */
    }
  }
  return undefined;
}

function checkoutWebRoot(from: string): string | undefined {
  let directory = resolve(from);
  for (;;) {
    const candidate = join(directory, "apps/web/dist");
    if (existsSync(join(candidate, "index.html"))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * 按 core 的 `CoreServer` 找这次装配的 Gateway 域。不用模块级单例：同一个进程
 * 里起两个 core（用例）时，后起的那个不该让先起的停错 Gateway。
 */
const domains = new WeakMap<CoreServer, GatewayDomain>();

export function gatewayDomainOf(server: CoreServer): GatewayDomain | undefined {
  return domains.get(server);
}

export function install(
  context: CoreContext,
  options: GatewayDomainOptions = {},
): GatewayDomain {
  const domain = new GatewayDomain(context, options);
  domains.set(context.server, domain);
  const router = context.server.router;
  const deps = {
    status: () => domain.status(),
    configure: (patch: JsonObject) => domain.configure(patch),
    pair: (input: { origin?: string; deviceName?: string }) =>
      domain.pair(input),
  };
  router.handle("GET", "/api/gateway", () => getGateway(deps));
  router.handle("PUT", "/api/gateway", (_match, request) =>
    putGateway(deps, request),
  );
  router.handle("POST", "/api/gateway/pairing", (_match, request) =>
    postPairing(deps, request),
  );
  // 装配是同步的，监听是异步的：起不来不该拖住 core，状态里报原因。服务器壳
  // 不走设置——它在 `run()` 之后自己 `adopt`，所以这里只在设置开着时开。
  if (domain.config().enabled && context.platform.shell !== "server") {
    void domain.reconcile();
  }
  return domain;
}
