/**
 * 推送域：设备注册、Web Push / APNs / FCM / 中继四种传输与触发规则（补全架构
 * §10、外部服务 §5.2、契约 §19）。
 *
 * 边界：
 *   * 只发给对该工作空间有 `canvas:read` 的 principal 的设备；正文不含终端
 *     原文与文件内容（`triggers.ts`）。
 *   * 没配置时原生传输是 `log`（设置 `push.transport`），接口照常答 `queued`；
 *     Web Push 不需要任何配置，VAPID 密钥对首次用到时生成到
 *     `<数据目录>/push/vapid.json`（0600）。
 *   * 密钥只存文件路径（`push.apns.keyFile`、`push.fcm.serviceAccountFile`）。
 *   * `/api/push/*` 登录即可：路由门不判 scope（`http/route-scopes.ts` 的
 *     `SELF_GUARDED`），本域只操作请求主体自己的设备，自己认请求身份
 *     （`routes.ts`）。
 *
 * 推送是事件总线的一个订阅者，装在 `DOMAINS` 里所有会发事件的域之后。
 */

import type { CoreContext } from "../main";
import { Authorizer } from "../identity/authorize";
import { scope } from "../identity/scopes";
import { IdentityStore } from "../identity/store";
import { settingsDomain } from "../settings";
import { completionSettings } from "../settings/schema";
import { installRoutes } from "./routes";
import { PushService } from "./service";
import type { EventFrame } from "./triggers";

export { PushService } from "./service";
export type { PushConfigView } from "./service";
export type { PushPayload, PushDevice } from "./types";

let assembled: PushService | undefined;

/** 装配好的推送域；没装（库没过统一迁移）时是 `undefined`。 */
export function pushDomain(): PushService | undefined {
  return assembled;
}

export function install(context: CoreContext): void {
  // 设备挂在 `identity_devices` 上：没过统一库迁移的库里没有身份表，路由留着
  // 答 501，页面据此不摆推送的入口。
  if (!context.db.unified) {
    context.log.info("推送域未装配：统一库迁移尚未应用");
    return;
  }
  const database = context.db.database;
  const authorizer = new Authorizer(new IdentityStore(database));
  const service = new PushService({
    database,
    dataDir: context.dataDir,
    log: context.log,
    env: process.env,
    settings: () =>
      completionSettings(settingsDomain()?.settings.snapshot() ?? {}),
    canRead: (principalId, principalKind, workspaceId) =>
      authorizer.permits(
        {
          principalId,
          kind: principalKind === "owner" ? "owner" : "member",
          scopes: [],
        },
        [scope("canvas:read", workspaceId)],
      ),
  });
  installRoutes(context.server, service);
  context.bus.on("workspace.event", ({ workspaceId, event }) => {
    try {
      service.handleEvent(workspaceId, event as unknown as EventFrame);
    } catch (error) {
      // 推送出错不该让发布事件的那个域跟着失败。
      context.log.warn("推送触发失败", {
        type: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  service.start();
  assembled = service;
}
