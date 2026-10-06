import type { CoreContext } from "../main";
import { confirmWorkspace } from "../collab/control/close";
import { VERSION, instanceId } from "../instance";
import { registerProcedures } from "../http/rpc";
import { coreCapabilities } from "../schedule/capabilities";
import { secretsFor } from "../secrets";
import { completionSettings, settingsDomain } from "../settings";
import { AccountsService } from "./accounts";
import { createIdentitySecurity } from "./accounts-http";
import { installAuditSink } from "./audit";
import { Authorizer } from "./authorize";
import { startControlChannel, startTicketIpc } from "./control";
import {
  currentSubject,
  installAccessGate,
  installRouteGuard,
  requestIdentity,
} from "./gate";
import { API_PREFIX, IdentityHttp, loopbackAnonymousOwner } from "./http";
import { createLoopbackAdmission } from "./loopback";
import { HEARTBEAT_MS } from "./protocol";
import { installCloud } from "./cloud";
import { installOAuth } from "./oauth";
import { resolveBreachMode } from "./policy";
import { createRouteGuard } from "./route-access";
import { IdentityService } from "./service";
import { IdentityStore } from "./store";
import { WsTickets } from "./transport";

export { IdentityService } from "./service";
export { IdentityStore } from "./store";
export { IdentityError } from "./errors";
export { AccountsService } from "./accounts";
export { Authorizer, compileGrants, permitsSubject } from "./authorize";
export type { AuthorizationSubject } from "./authorize";
export { audit, installAuditSink, resetAuditSink } from "./audit";
export type { AuditEvent } from "./audit";
export {
  OWNER_GATE,
  accessChanged,
  accessGate,
  allows,
  currentSubject,
  installAccessGate,
  installRouteGuard,
  onAccessChanged,
  requestIdentity,
  resetAccessGate,
  resetRouteGuard,
  routeGuard,
  runAs,
} from "./gate";
export type { AccessGate, RequestIdentity, RouteVerdict } from "./gate";
export { createRouteGuard } from "./route-access";
export { SHARE_ROLES, rolePermissions, roleScopes } from "./roles";
export type { ShareRole } from "./roles";
export {
  API_PREFIX,
  BROWSER_SESSION_CAPABILITY,
  NATIVE_SESSION_CAPABILITY,
} from "./http";
export {
  CONTROL_SOCKET,
  TICKET_MESSAGE,
  TICKET_PATH,
  controlSocketPath,
} from "./control";

/**
 * 这一轮 core 的实例标识，按身份域的拼法：32 位十六进制。
 *
 * `instanceId()` 是带连字符的 UUID，`/health` 与 `endpoints.json` 用的就是它，
 * 壳按那一行对账，所以它不能改。身份域这边继承的是合并前实现的形状——票据、
 * 会话、以及前端校验 `hostInstanceId` 的那条正则，全都要
 * 32 位十六进制。去掉连字符正好是同一串字节的另一种写法，两边说的是同一次运行。
 */
export function identityInstanceId(): string {
  return instanceId().replace(/-/g, "");
}

/**
 * 身份域的装配。
 *
 * 两样东西挂上去：`/api/identity/*`，以及数据目录下那个 0600 的私有通道
 * （签票的唯一入口）。
 *
 * **只在统一库迁移已经应用时装**。没过单向门的库里没有身份表，这时候装上去，
 * 第一个请求会撞上一条「没有这张表」的 SQL 错误；不装，路由继续按路由表回
 * 501，页面据此退化——这正是 501 存在的理由。
 */
export function installIdentity(context: CoreContext): void {
  if (!context.db.unified) {
    context.log.info("身份域未装配：统一库迁移尚未应用");
    return;
  }
  const runInstance = identityInstanceId();
  const store = new IdentityStore(context.db.database);
  const service = new IdentityService(store, runInstance);
  // Hello 报的能力名里多出的那些来自各域自己的注册表（`core/schedule/capabilities`）。
  // 身份域不该知道有哪些域存在，所以这里只转发；自动化面板认的
  // `automation.plans.v1` 就是这样传到页面的。
  const accounts = new AccountsService({ store });
  // 加固（契约 §18.1–§18.4）：TOTP 密钥进这一轮的 SecretStore，设置每次现读。
  const security = createIdentitySecurity({
    store,
    secrets: () => secretsFor(context).backend,
    settings: () => {
      const current = completionSettings(
        settingsDomain()?.settings.snapshot() ?? {},
      );
      const publicOrigin = current.gateway.publicOrigin;
      return {
        passwordMinLength: current.identity.passwordMinLength,
        rpId: current.identity.rpId,
        publicOrigins: publicOrigin === "" ? [] : [publicOrigin],
        mfaRequireFor: current.identity.mfa.requireFor,
        // `auto`：服务器壳与开了 Gateway 的桌面按 `warn`（架构 §8.3）。
        breachCheck: resolveBreachMode(
          current.identity.breachCheck,
          context.platform.shell === "server" || current.gateway.enabled,
        ),
        breachBase: process.env.ARMADRA_HIBP_BASE?.trim() ?? "",
      };
    },
  });
  // 回环监听上的门（契约 §3.2，安全审查 L9）：回环匿名按主人关着（两种壳都
  // 是）时，`/api/` 与每条流都要一个会话；只有探针与开发命令起的裸 core 显式
  // 打开它，那里不装。
  const wsTickets = loopbackAnonymousOwner() ? undefined : new WsTickets();
  const http = new IdentityHttp({
    service,
    accounts,
    instanceId: runInstance,
    capabilities: coreCapabilities,
    security,
    ...(wsTickets === undefined ? {} : { wsTickets }),
  });
  // 契约 §34.2–§34.3：`system.hello` 说的与 `GET /api/identity/hello` 是同一台
  // core，多出 procedure 表、心跳与这次会话的到期时刻。
  registerProcedures(context.server, "system", {
    hello: (_input, call) => {
      const hello = http.helloJson();
      return {
        protocol: { ...hello.protocol },
        procedures: [...call.procedures],
        capabilities: [...hello.capabilities],
        heartbeatMs: HEARTBEAT_MS,
        maxFrameBytes: hello.maxFrameBytes,
        sessionExpiresAtMs: call.identity?.accessExpiresAtMs ?? null,
        instanceId: hello.hostInstanceId,
        sourceId: hello.hostId,
        version: VERSION,
      };
    },
    ping: ({ ts }) => ({ ts, serverTs: Date.now() }),
  });
  context.server.admission(
    wsTickets === undefined
      ? undefined
      : createLoopbackAdmission({ service, tickets: wsTickets }),
  );

  // 判定入口与审计写入点（设计 §4）。装上之后它们仍然对 owner 恒真、对每条
  // 动作各写一条——真正变了的只有「问的是库，而不是那个恒真的兜底实现」。
  const authorizer = new Authorizer(store);
  installAccessGate({
    // 主体是这次请求的身份：服务器壳认证完请求后用 `runAs` 放进来；桌面壳里
    // 没有，问到的就是本机 owner，授权是配对时签给壳的那一份。
    subject: currentSubject,
    permits: (subject, required) => authorizer.permits(subject, required),
  });
  // 路由门：路由表声明的 scope 在这里按请求主体落地。没有请求身份时它放行，
  // 所以桌面壳的行为一个字节都没变。
  installRouteGuard(
    createRouteGuard({
      database: context.db.database,
      permits: (subject, required) => authorizer.permits(subject, required),
      effectiveScopes: (subject) => authorizer.effectiveScopes(subject),
      // 关闭确认只在内存里等人答，库里查不到它属于哪块画布。
      lookups: { confirmWorkspace },
    }),
  );
  installAuditSink((event) => {
    // 调用方没写是谁时记这次请求的人：审批答复、画布接管这些写入点在域里，
    // 它们不该为了审计去认识请求身份，而服务器壳上「谁答的」正是这条记录的意义。
    const identity = requestIdentity();
    store.transaction((tx) => {
      tx.accounts.appendAudit({
        atMs: Date.now(),
        principalId: event.principalId ?? identity?.subject.principalId ?? "",
        deviceId: event.deviceId ?? identity?.device?.deviceId ?? "",
        action: event.action,
        target: (event.target ?? "").slice(0, 256),
        workspaceId: (event.workspaceId ?? "").slice(0, 256),
        detailJson:
          event.detail === undefined
            ? ""
            : JSON.stringify(event.detail).slice(0, 8192),
      });
    });
  });

  // OAuth / OIDC 的挂点（契约 §18.5）。它自己登记更长的原样前缀，所以放在
  // 哪一行都先于下面这条整段接管；放在这里是为了让它拿到同一份服务。
  installOAuth(context, { store, service, accounts, security });

  // 云登录与登记（契约 §31）：同一份会话、账号与加固；`/api/identity/cloud` 也是
  // 更长的原样前缀，先于下面的整段接管。
  installCloud(context, {
    store,
    service,
    accounts,
    authorizer,
    security,
    capabilities: () => http.capabilities(),
    coreVersion: VERSION,
    // 设置 `cloud.orgDefaultRole`（A3-2）：每次现读，缺省 `null` = 不授予。
    orgDefaultRole: () =>
      completionSettings(settingsDomain()?.settings.snapshot() ?? {}).cloud
        .orgDefaultRole,
  });

  context.server.raw(API_PREFIX, (request, response, cors) =>
    http.handle(request, response, cors),
  );

  // Windows 上私有通道还不开（`control.ts` 的 TODO），票经 fork 的 IPC 通道
  // 签：回环不再放行匿名请求（契约 §3.2），壳的页面没有票就什么都打不了。
  if (process.platform === "win32") {
    startTicketIpc(
      { service, instanceId: runInstance },
      process as unknown as Parameters<typeof startTicketIpc>[1],
    );
  }

  // 私有通道是异步绑的，但装配是同步的：起不来不该拖住 core，壳会在取票时拿到
  // 一个明确的失败，而不是一个永远起不来的进程。
  void startControlChannel({
    service,
    instanceId: runInstance,
    dataDir: context.dataDir,
    log: context.log,
  })
    .then((channel) => {
      if (channel !== undefined) {
        context.log.info("身份私有通道已就绪", { spec: channel.spec });
      }
    })
    .catch((error: unknown) => {
      context.log.warn("身份私有通道未能绑定；本次无法取票", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
