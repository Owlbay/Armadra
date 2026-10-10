import type { MessageModule } from "./index";

/**
 * core 的错误码 → 界面上那句话。
 *
 * core 的 `{ code, message }` 里 `message` 是中文（它的注释与日志通篇如此），
 * 页面原样透出去，英文界面上就会冒出一句中文。所以**一律按 `code` 取文案**，
 * `message` 只在这张表认不出这个码时兜底。映射表在 `api/request.ts`。
 *
 * 代价是具体度：`bad_request` 的原话常常说得出是哪个字段，而这里只说「请求
 * 无效」。原话没有丢——`RuntimeRequestError.coreMessage` 还留着它，需要细节的
 * 调用点（执行主机改绑的 409 就是一例）自己读 `body`。一句看不懂的中文对一个
 * 英文用户的价值是零，而这张表至少说得出该怎么办。
 */
export const errors: MessageModule = {
  "zh-CN": {
    "error.notFound": "找不到这个对象",
    "error.forbidden": "没有权限执行这个操作",
    "error.badRequest": "请求无效",
    "error.methodNotAllowed": "这个接口不接受该操作",
    "error.conflict": "对象已被改动，请重新加载后重试",
    "error.payloadTooLarge": "内容太大，超出了单次请求的上限",
    "error.unavailable": "这项服务暂时不可用，请稍后重试",
    "error.notImplemented": "当前版本还没有这个功能",
    "error.internal": "核心处理这个请求时失败",
    "error.unsupported": "这台机器不支持这个操作",
    "error.unsupportedOnRemote":
      "这个操作只能在 Armadra 所在的机器上执行，当前工作区在另一台。",
    "error.unauthenticated": "登录已失效，请重新连接账户",
    "error.rateLimited": "请求过于频繁，请稍后重试",
    "error.unknownOutcome": "结果未知：请重新加载后确认是否已生效",
    "error.credentialsInvalid": "账号或口令不正确",
    "error.accountLocked": "尝试次数过多，账号已暂时锁定",
    "error.fingerprintMismatch": "证书指纹不一致，已拒绝连接",
    "error.challengeRequired": "需要先完成人机验证",
    "error.challengeInvalid": "人机验证没有通过，请重试",
    "error.addressInvalid": "地址格式不对",
    "error.addressHttpsOnly": "地址需要以 https:// 开头",
    "error.addressPlaintextLoopbackOnly": "需要 https://，http:// 只能用于本机",
    "error.addressHasCredentials": "地址里不能带账号和口令",
    "error.fingerprintInvalid": "证书指纹应为 64 位十六进制",
    "error.sourceUnreachable": "连不上，检查地址、服务是否已开启和防火墙",
    "error.sourceUnauthorized": "这台机器的登录已失效，请重新登录",
    "error.sourceOffline": "这台机器当前不在线",
    "error.cloudAccountUnlinked": "这个账号还没有关联到这台机器",
    "error.cloudNotRegistered": "这台机器没有登记到这个远程服务",
    "error.cloudAssertionInvalid": "登录凭证无效或已过期，请重新打开",
    "error.cloudAlreadyRegistered": "已经登记到这个远程服务",
    "error.cloudIssuerMismatch": "远程服务的地址与它自报的不一致",
    "error.invitationInvalid": "邀请无效或已用完",
    "error.registrationTokenInvalid": "登记令牌无效或已过期",
    "error.protocolUnsupported": "远程服务的协议版本不兼容",
    "error.remoteSessionExpired": "远程服务的登录已失效，请重新登录",
    "error.sourceAccessDenied": "这个账号没有这台机器的权限",
    "error.sourceRevoked": "这台机器已从远程服务移除",
    "error.limitReached": "已达到远程服务的上限",
    "error.linkInvalid": "链接已停用或不存在",
    "error.linkExpired": "链接已过期",
    "error.linkExhausted": "链接的使用次数已用完",
    "error.linkSecretInvalid": "链接不完整，请复制完整的链接",
    "error.adapterNotInstallable": "这个 Agent 没有可安装的适配器", // i18n-exempt
    "error.adapterAlreadyInstalled": "适配器已安装",
    "error.npmNotFound": "找不到 npm，请先安装 Node.js", // i18n-exempt
    "error.adapterInstallBusy": "正在装另一项",
    "error.adapterRollbackUnavailable": "没有可恢复的上一版本",

    /* 投递的拒绝码（`agent-delivery.md` §3.5）。机器码本身不翻译，这里给的是
       「发生了什么」，因为看着画布的人不该去读 core 的中文句子。 */
    "error.delivery.LOOP_DETECTED": "这两个节点在互相投递，已经停下",
    "error.delivery.RATE_LIMITED": "这条边上的投递太密集，已经退避",
    "error.delivery.TARGET_AWAITING_APPROVAL":
      "目标停在一个权限提示上，没有替它回答",
    "error.delivery.LEASE_HELD_BY_HUMAN": "有人正在这个终端里打字",
    "error.delivery.LEASE_REVOKED": "有人接管了这个终端",
    "error.delivery.LEASE_HELD_BY_AGENT": "另一个 Agent 正在驱动它",
    "error.delivery.TARGET_BUSY": "目标正在一轮里",
    "error.delivery.TARGET_STARTING": "目标刚起来，还没报过状态",
    "error.delivery.TARGET_INPUT_PENDING": "目标的输入行上有没提交的半行",
    "error.delivery.TARGET_NOT_AT_PROMPT":
      "目标停在 CLI 的对话框上，没有替它回答",
    "error.delivery.QUEUE_FULL": "这个目标的队伍满了",
    "error.delivery.TARGET_GONE": "目标没有在运行的会话",
  },
  en: {
    "error.notFound": "Not found",
    "error.forbidden": "You do not have permission to do this",
    "error.badRequest": "The request was not valid",
    "error.methodNotAllowed": "This endpoint does not accept that operation",
    "error.conflict": "It changed since you loaded it — reload and try again",
    "error.payloadTooLarge": "Too large for a single request",
    "error.unavailable": "Temporarily unavailable — try again shortly",
    "error.notImplemented": "This build does not have that yet",
    "error.internal": "The core failed while handling this request",
    "error.unsupported": "This machine does not support that",
    "error.unsupportedOnRemote":
      "This runs only on the machine Armadra is on; this workspace is on another.",
    "error.unauthenticated": "Your sign-in expired — reconnect the account",
    "error.rateLimited": "Too many requests — try again shortly",
    "error.unknownOutcome":
      "Outcome unknown — reload to see whether it applied",
    "error.credentialsInvalid": "Wrong account or password",
    "error.accountLocked": "Too many attempts — the account is locked for now",
    "error.fingerprintMismatch":
      "The certificate fingerprint does not match — connection refused",
    "error.challengeRequired": "Complete the human check first",
    "error.challengeInvalid": "The human check didn't pass. Try again",
    "error.addressInvalid": "That address isn't valid",
    "error.addressHttpsOnly": "The address must start with https://",
    "error.addressPlaintextLoopbackOnly":
      "Use https:// — http:// only works on this machine",
    "error.addressHasCredentials": "The address can't contain a login",
    "error.fingerprintInvalid":
      "The certificate fingerprint must be 64 hex characters",
    "error.sourceUnreachable":
      "Cannot connect — check the address, that the service is running, and the firewall",
    "error.sourceUnauthorized":
      "Your sign-in to that machine expired — sign in again",
    "error.sourceOffline": "That machine is offline",
    "error.cloudAccountUnlinked":
      "This account is not linked to that machine yet",
    "error.cloudNotRegistered":
      "This machine is not registered with that remote service",
    "error.cloudAssertionInvalid":
      "The sign-in credential is invalid or expired — open it again",
    "error.cloudAlreadyRegistered":
      "Already registered with that remote service",
    "error.cloudIssuerMismatch":
      "The remote service's address does not match what it reports",
    "error.invitationInvalid": "The invitation is invalid or used up",
    "error.registrationTokenInvalid":
      "The registration token is invalid or expired",
    "error.protocolUnsupported":
      "The remote service speaks an incompatible protocol version",
    "error.remoteSessionExpired":
      "Your sign-in to the remote service expired. Sign in again.",
    "error.sourceAccessDenied": "This account has no access to that machine",
    "error.sourceRevoked": "That machine was removed from the remote service",
    "error.limitReached": "The remote service limit is reached",
    "error.linkInvalid": "This link is disabled or doesn't exist",
    "error.linkExpired": "This link has expired",
    "error.linkExhausted": "This link has no uses left",
    "error.linkSecretInvalid": "This link is incomplete. Copy the whole link.",
    "error.adapterNotInstallable": "This agent has no adapter to install",
    "error.adapterAlreadyInstalled": "The adapter is already installed",
    "error.npmNotFound": "npm not found. Install Node.js first.",
    "error.adapterInstallBusy": "Another install is running",
    "error.adapterRollbackUnavailable": "No previous version to restore",

    "error.delivery.LOOP_DETECTED":
      "These two nodes are feeding each other — stopped",
    "error.delivery.RATE_LIMITED":
      "Too many deliveries on this link — backing off",
    "error.delivery.TARGET_AWAITING_APPROVAL":
      "The target is on a permission prompt; nobody answered it for them",
    "error.delivery.LEASE_HELD_BY_HUMAN": "Someone is typing in that terminal",
    "error.delivery.LEASE_REVOKED": "Someone took that terminal over",
    "error.delivery.LEASE_HELD_BY_AGENT": "Another agent is driving it",
    "error.delivery.TARGET_BUSY": "The target is in a turn",
    "error.delivery.TARGET_STARTING":
      "The target just started and has not reported yet",
    "error.delivery.TARGET_INPUT_PENDING":
      "The target has an unsubmitted half line in its input",
    "error.delivery.TARGET_NOT_AT_PROMPT":
      "The target is on one of its CLI's dialogs; nobody answered it for them",
    "error.delivery.QUEUE_FULL": "That target's queue is full",
    "error.delivery.TARGET_GONE": "The target has no running session",
  },
};
