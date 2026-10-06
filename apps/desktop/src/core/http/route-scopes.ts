/**
 * 每条路由要求的权限，以及它是不是绑在某个工作空间上。
 *
 * `docs/design/server-accounts-and-sharing.md` §4.1 要的那处预留：**每条已实现
 * 的路由现在就写下自己要求的 scope**。今天桌面壳只有 owner，判定入口对 owner
 * 恒真（`core/identity/authorize.ts`），所以这张表一条也拦不住任何人；它存在
 * 是因为「哪条路由要什么权限」这件事，等到有第二个 principal 时再补就得把
 * 163 条路由重读一遍。
 *
 * ## 为什么是一张表，而不是 88 处 `handle(...)` 的第四个参数
 *
 * 两种写法都在（{@link ../http/router!Router.handle} 收 `{ scope }`，单条路由
 * 可以就地声明并覆盖这张表）。默认走表，是因为声明写在 16 个域文件的 88 个
 * 登记点上时，没有任何一个地方能一眼看出「谁能读这块画布」——而这恰恰是共享
 * 对话框要回答的问题。表按路径族分组，一族一行，读起来就是一份权限清单。
 *
 * 规则按顺序匹配，第一条命中的说了算，所以特例写在通用规则前面。
 *
 * `hook` 面（`/hook/*`、`/control/*`、`/context-link/*`、`/verify`）不在表里：
 * 它有自己的凭据与监听（R3），不走 principal 的 scope 判定。
 */

export interface RouteScopeRule {
  readonly pattern: RegExp;
  /** GET / HEAD 要求的权限；`null` 表示这条路由不要求任何权限。 */
  readonly read: string | null;
  /** 其余方法要求的权限；省略时同 `read`。 */
  readonly write?: string | null;
}

export interface RouteScopeRequirement {
  readonly permission: string;
  /** 绑在这个工作空间上；空串表示全局授权。 */
  readonly workspaceId: string;
}

const WORKSPACE = String.raw`/api/workspaces/[^/]+`;

/**
 * 不经路由门的路径：它们要么先于任何身份存在（健康检查），要么自己认请求
 * 身份、自己判定（身份域；推送域只碰请求主体自己的设备，「登录即可」）。
 *
 * 这张表里的路径照样可以在 {@link ROUTE_SCOPE_RULES} 里声明权限——那是给
 * 读的人看的清单，门不拿它判。`identity/route-access.ts` 用的就是这一份。
 */
export const SELF_GUARDED: readonly RegExp[] = [
  /^\/(api\/)?health$/,
  /^\/api\/identity\//,
  /^\/api\/push\//,
  // 配对短码换票先于任何身份存在（契约 §24），与 `#pair=` 换票同一档。
  /^\/api\/gateway\/pairing-code\/exchange$/,
  // 邮件：能签发那条链接的人才能发（owner，或组 admin 对本组成员），那是身份
  // 域的判定，路由门的全局 scope 说不出「本组」（契约 §28）。
  /^\/api\/mail\//,
  // 页面错误上报：登录即可，域自己认会话并限流（契约 §30）。
  /^\/api\/diagnostics\/client-error$/,
  // 契约 procedure：一条路径前缀下是许多 procedure，各要各的权限。RPC 门面
  // （`http/rpc.ts`）按每条契约的 `meta.scope` 走同一道路由门（契约 §34.1）。
  /^\/api\/rpc\//,
];

export function selfGuarded(path: string): boolean {
  return SELF_GUARDED.some((pattern) => pattern.test(path));
}

/** 路径族 → 权限。顺序即优先级。 */
export const ROUTE_SCOPE_RULES: readonly RouteScopeRule[] = [
  // 健康检查是壳与探针用来确认「core 起来了」的，先于任何身份存在。
  { pattern: /^\/(api\/)?health$/, read: null, write: null },

  // Hello 回答的是「这台 core 是谁、支持什么」，那是一次配对**之前**就要知道的
  // 事，所以它和健康检查同一档：不要求任何权限。
  { pattern: /^\/api\/identity\/hello$/, read: null, write: null },

  // 云登录与登记（契约 §31）。整段自己认证（{@link SELF_GUARDED}），这几行是
  // 清单：用断言换会话先于身份存在；绑定是本人的事；登记、撤销、可信来源只有
  // owner（与设置同一档）。
  { pattern: /^\/api\/identity\/cloud\/login$/, read: null, write: null },
  {
    pattern: /^\/api\/identity\/cloud\/bind$/,
    read: "identity:read",
    write: "identity:read",
  },
  {
    pattern: /^\/api\/identity\/cloud(\/|$)/,
    read: "settings:read",
    write: "settings:write",
  },

  // 身份扩展（契约 §18）。整段 `/api/identity/` 自己认证（{@link SELF_GUARDED}），
  // 这几行是清单而不是门：写的是「管别人的」那一档，本人的 passkey、MFA、
  // 会话与 OAuth 绑定由身份域按请求主体放行。登录本身的几步先于身份存在。
  {
    pattern: /^\/api\/identity\/passkey\/login\//,
    read: null,
    write: null,
  },
  {
    pattern: /^\/api\/identity\/passkey/,
    read: "identity:read",
    write: "identity:manage",
  },
  { pattern: /^\/api\/identity\/mfa\/verify$/, read: null, write: null },
  {
    pattern: /^\/api\/identity\/mfa/,
    read: "identity:read",
    write: "identity:manage",
  },
  {
    pattern: /^\/api\/identity\/oauth\/[^/]+\/(start|callback)$/,
    read: null,
    write: null,
  },
  {
    pattern: /^\/api\/identity\/oauth/,
    read: "identity:read",
    write: "identity:manage",
  },
  {
    pattern: /^\/api\/identity\/sessions/,
    read: "identity:read",
    write: "identity:manage",
  },
  // 审计只读；导出 CSV 也是 GET。
  // 口令重置链接（契约 §25）：打开链接与设新口令先于身份存在，令牌本身就是
  // 凭据；签发是「管别人的」那一档（组 admin 对本组成员由身份域放行）。
  {
    pattern: /^\/api\/identity\/password-reset\//,
    read: null,
    write: null,
  },
  {
    pattern: /^\/api\/identity\/principals\/[^/]+\/password-reset$/,
    read: "identity:read",
    write: "identity:manage",
  },
  {
    pattern: /^\/api\/identity\/audit/,
    read: "identity:read",
    write: "identity:read",
  },

  // 配对短码换票（契约 §24）：手机还没有任何身份，短码本身就是凭据；限流与
  // 档位（公网 `all` 档关掉）在 Gateway 域里判。签发短码随配对票一起，落在下面
  // owner 那一档。
  {
    pattern: /^\/api\/gateway\/pairing-code\/exchange$/,
    read: null,
    write: null,
  },
  // Gateway 与节点凭据只有 owner：要的是全局授权，共享只发工作空间上的授权，
  // 所以成员在这里一律 403（与设置同一档）。契约 §17、§20。
  {
    pattern: /^\/api\/gateway/,
    read: "settings:read",
    write: "settings:write",
  },
  {
    pattern: /^\/api\/credentials/,
    read: "settings:read",
    write: "settings:write",
  },
  // 邮件通道（契约 §28）：自己认身份（{@link SELF_GUARDED}），这一行是清单——
  // 发的是邀请与重置链接，与签发它们同一档。
  {
    pattern: /^\/api\/mail\//,
    read: "identity:read",
    write: "identity:manage",
  },
  // 页面错误上报（契约 §30）：登录即可（{@link SELF_GUARDED}），与推送设备
  // 同样记成看得见画布的那一档。
  {
    pattern: /^\/api\/diagnostics\/client-error$/,
    read: "canvas:read",
    write: "canvas:read",
  },
  // 契约 procedure（契约 §34.1）：门面按每条的 `meta.scope` 判（{@link
  // SELF_GUARDED}）；这一行是清单——最少也要能读身份，与 `system.hello` 同一档。
  { pattern: /^\/api\/rpc\//, read: "identity:read", write: "identity:read" },
  // 控制面 WebSocket（契约 §35.1）：升级要能读身份（登录即可，成员也有），每条
  // 调用与订阅再按自己的 `meta.scope` 判；授权一变，连接按这一档复核（4403）。
  { pattern: /^\/api\/ws$/, read: "identity:read" },
  // 推送设备：登录即可（{@link SELF_GUARDED}），推送域只碰请求主体自己的设备。
  // 声明的这一档只是清单：注册一台设备收的是「看得见的画布」上的通知。契约 §19。
  {
    pattern: /^\/api\/push\//,
    read: "canvas:read",
    write: "canvas:read",
  },
  // ACP 会话（契约 §14）：看会话与看终端同一档，开会话、发提示与开终端同一档。
  // 路径里没有工作空间：服务器壳的路由门按会话行 / 节点查出画布再判，往别人
  // 起的会话里写与切换别人节点的驱动要 `terminal:drive`（契约 §23）。
  {
    pattern: /^\/api\/acp\//,
    read: "terminal:read",
    write: "terminal:create",
  },
  // 工作流（契约 §15）：看草案、模板与运行记录是看画布；确认草案、改模板、
  // 起一次运行会开节点与 Agent，要 operator 那一档（`agent:launch`）。路径里
  // 没有工作空间：服务器壳的路由门按草案 / 运行 / 画板查出画布再判，改模板
  // 只有 owner（`identity/route-access.ts`）。
  //
  // 关卡答复（契约 §23）：放行或拦下一次运行，与起跑同一档，要运行所在画布
  // 上的 operator——不是替 Agent 代答，所以不是 `approval:answer`。
  {
    pattern: /^\/api\/workflows\/runs\/[^/]+\/gates\//,
    read: "canvas:read",
    write: "agent:launch",
  },
  {
    pattern: /^\/api\/workflows/,
    read: "canvas:read",
    write: "agent:launch",
  },

  // R7a 的两张 JSON 面。工作空间跟着查询串走而不是路径，所以这里声明的是全局
  // 那一档；按工作空间收窄的那一次判定在域自己的 HTTP 面上（`github/http.ts`
  // 的 `apiCaller`、`schedule/api.ts` 的 `caller`），它们看得见 `workspaceId`。
  {
    pattern: /^\/api\/github\//,
    read: "github:read",
    write: "github:write",
  },
  // `resolve` 虽是 POST（地址在体里，远端地址可能带着凭据，不放查询串），只是读
  // （契约 §29.2、§41.2）。
  {
    pattern: /^\/api\/forge\/resolve$/,
    read: "github:read",
    write: "github:read",
  },
  // 托管平台（契约 §29）与 GitHub 同一档：forge 是把 GitHub 面推广到别的
  // 平台，读写的是同一类东西（issue、PR、检查）。
  {
    pattern: /^\/api\/forge\//,
    read: "github:read",
    write: "github:write",
  },
  {
    pattern: /^\/api\/automations/,
    read: "automation:read",
    write: "automation:manage",
  },

  { pattern: new RegExp(`^${WORKSPACE}/events$`), read: "events:read" },

  {
    pattern: new RegExp(`^${WORKSPACE}/git/`),
    read: "git:read",
    write: "git:write",
  },
  { pattern: /^\/api\/git\/clone/, read: "git:read", write: "git:write" },

  // 「在访达中显示」会在 core 所在的机器上拉起一个程序，和开终端同一档，
  // 而不是读文件那一档。
  {
    pattern: new RegExp(`^${WORKSPACE}/reveal$`),
    read: "terminal:create",
    write: "terminal:create",
  },
  {
    pattern: new RegExp(`^${WORKSPACE}/(files?|file-|imports)`),
    read: "files:read",
    write: "files:write",
  },
  {
    pattern: new RegExp(`^${WORKSPACE}/language`),
    read: "files:read",
    write: "files:write",
  },

  {
    pattern: new RegExp(`^${WORKSPACE}/assets`),
    read: "assets:read",
    write: "assets:write",
  },
  { pattern: new RegExp(`^${WORKSPACE}/exports/`), read: "assets:read" },

  { pattern: new RegExp(`^${WORKSPACE}/sessions$`), read: "terminal:read" },
  {
    pattern: new RegExp(`^${WORKSPACE}/resources`),
    read: "resources:read",
    write: "resources:read",
  },
  {
    pattern: new RegExp(`^${WORKSPACE}/execution-host$`),
    read: "settings:read",
    write: "settings:write",
  },

  // 实时协同（契约 §16）。`…/sync` 是 WebSocket：升级（GET）要
  // `canvas:read`，更新帧要 `canvas:write`——帧上的那次判定在实时域里，
  // 这里的写方法一档写给非 GET 的同路径。评论读写分开。
  {
    pattern: new RegExp(`^${WORKSPACE}/boards/[^/]+/sync$`),
    read: "canvas:read",
    write: "canvas:write",
  },
  {
    pattern: new RegExp(`^${WORKSPACE}/boards/[^/]+/comments`),
    read: "canvas:read",
    write: "canvas:write",
  },

  // 在线设备的心跳与离开（契约 §9.1）：只读的客户端也要让别人看见自己在看，
  // 所以写方法也只要求读权限。拿租约不在此列，它落进下面画布本体那一档。
  {
    pattern: new RegExp(`^${WORKSPACE}/boards/[^/]+/presence`),
    read: "canvas:read",
    write: "canvas:read",
  },

  // 工作空间这一行本身（改名、换根目录、删除）不是「编辑画布」：改根目录等于
  // 把别人的画布指到服务器上另一个目录，删除更收不回来。它和「把这块画布分享
  // 给谁」同一档，共享角色里没有这一条，所以只有 owner 能做。
  {
    pattern: new RegExp(`^${WORKSPACE}$`),
    read: "canvas:read",
    write: "workspace:share",
  },
  // 「打开」只是记一下最近打开的时间，看得见这块画布的人都会做。
  {
    pattern: new RegExp(`^${WORKSPACE}/open$`),
    read: "canvas:read",
    write: "canvas:read",
  },
  // 画布本体：看板、文档、连线、节点，以及工作空间自己。
  {
    pattern: new RegExp(
      `^${WORKSPACE}/(boards|context-links|nodes|deliveries|handoffs|dependencies|open)`,
    ),
    read: "canvas:read",
    write: "canvas:write",
  },
  {
    pattern: /^\/api\/workspaces/,
    read: "canvas:read",
    write: "canvas:write",
  },

  // 终端。开一个是 `terminal:create`，往已有会话里写是 `terminal:write`——
  // 向**别人**开的会话里写还要 `terminal:drive`，那一条在终端输入路径上判
  // （`core/terminal/input.ts`），不在路由上：路由看不见会话的创建者。
  {
    pattern: /^\/api\/terminals$/,
    read: "terminal:read",
    write: "terminal:create",
  },
  { pattern: /^\/api\/terminals\/backend$/, read: "terminal:read" },
  {
    pattern: /^\/api\/terminals\/[^/]+\/node-token/,
    read: "credential:use",
    write: "credential:use",
  },
  {
    pattern: /^\/api\/terminals\/[^/]+\/(ws|capture|scroll)$/,
    read: "terminal:read",
    write: "terminal:write",
  },
  {
    pattern: /^\/api\/terminals/,
    read: "terminal:read",
    write: "terminal:write",
  },

  // 审批答复会替 Agent 回答权限提示，和 `terminal:drive` 同一档（设计 S5）。
  {
    pattern: /^\/api\/approvals\/[^/]+\/answer$/,
    read: null,
    write: "approval:answer",
  },
  {
    pattern: /^\/api\/control\/confirm\//,
    read: null,
    write: "approval:answer",
  },

  {
    pattern: /^\/api\/agent-status\/[^/]+\/suggest-title$/,
    read: "canvas:read",
    write: "canvas:write",
  },
  { pattern: /^\/api\/agent-status\//, read: "canvas:read" },
  {
    pattern: /^\/api\/agents/,
    read: "settings:read",
    write: "settings:write",
  },

  {
    pattern: /^\/api\/usage\/copilot\/(login|logout|poll)$/,
    read: "credential:use",
    write: "credential:use",
  },
  { pattern: /^\/api\/usage/, read: "settings:read", write: "settings:read" },
  {
    pattern: /^\/api\/(models|conversations)/,
    read: "settings:read",
    write: "settings:read",
  },

  {
    pattern: /^\/api\/ssh\/(askpass\/)?(prompts|hosts\/[^/]+\/prompts)/,
    read: "credential:use",
    write: "credential:use",
  },
  // 客户端源表与远程服务（契约 §33）：只有 owner 有 `settings:*`。
  {
    pattern: /^\/api\/sources(\/|$)/,
    read: "settings:read",
    write: "settings:write",
  },
  {
    pattern: /^\/api\/(ssh|execution-hosts|settings|data)/,
    read: "settings:read",
    write: "settings:write",
  },

  {
    pattern: /^\/api\/power/,
    read: "resources:read",
    write: "browser:control",
  },
  { pattern: /^\/browser\//, read: "browser:read", write: "browser:control" },

  // 「谁读过这个节点」与画布本体同一档：它答的是画布上的一个节点的历史。
  // 节点属于哪块画布由服务器壳的路由门去查（`identity/route-access.ts`）；
  // 这里声明的只是权限名。`/api/ownership` 曾在这张表里，2026-09-20 连同
  // 路由一起删掉了，表外的路由对成员本来就是 403。
  { pattern: /^\/api\/nodes\/[^/]+\/context-reads$/, read: "canvas:read" },
];

/**
 * 这条路由要求什么。
 *
 * `path` 可以是路由表里的模式（`/api/workspaces/{workspaceId}/…`）也可以是一条
 * 真实路径：模式里的 `{param}` 按一个段匹配，而工作空间标识只有在真实路径上
 * 才取得到——模式上取到的是 `{workspaceId}` 这个字面量，那不是一个工作空间，
 * 所以那种情况下返回空串（全局），由调用方补上自己知道的标识。
 */
export function routeScope(
  method: string,
  path: string,
): RouteScopeRequirement | undefined {
  const concrete = path.replace(/\{[^}]+\}/g, "*");
  const verb = method.toUpperCase();
  for (const rule of ROUTE_SCOPE_RULES) {
    if (!rule.pattern.test(concrete)) continue;
    const permission =
      verb === "GET" || verb === "HEAD"
        ? rule.read
        : rule.write === undefined
          ? rule.read
          : rule.write;
    if (permission === null) return undefined;
    return { permission, workspaceId: workspaceOf(path) };
  }
  return undefined;
}

/** `/api/workspaces/<id>/…` 里的那个标识；模式里的 `{…}` 不算。 */
export function workspaceOf(path: string): string {
  const found = /^\/api\/workspaces\/([^/]+)/.exec(path);
  const value = found?.[1] ?? "";
  return value.startsWith("{") ? "" : decodeURIComponent(value);
}
