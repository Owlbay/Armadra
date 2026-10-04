import { coreError } from "../http/errors";
import type { HandlerResult, RouteMatch, CoreRequest } from "../http/router";
import type { CoreServer } from "../http/server";
import { requestIdentity } from "../identity/gate";
import { parseKinds, parseRegistration } from "./devices";
import type { PushService } from "./service";
import { PREFERENCE_KINDS, type PushDevice } from "./types";

/**
 * `/api/push/*`（契约 §19）。
 *
 * 路由门不判这一段（`http/route-scopes.ts` 的 `SELF_GUARDED`）：这里自己认请求
 * 身份。规矩只有一条——**只碰请求主体自己的设备**：
 *
 *   * 登记永远是这次请求背后的那台身份设备，请求体里没有设备 id 可填；
 *   * 列表只列自己名下的；撤销只撤自己名下的，owner 例外（他管这台 core）；
 *   * 桌面壳的本机请求没有请求身份（主体是本机 owner、没有设备）：看配置与列表
 *     可以，登记答 409 `device_required`——桌面有自己的系统通知，不需要推送。
 */

export const PUSH_ROUTES = {
  config: "/api/push/config",
  devices: "/api/push/devices",
  device: "/api/push/devices/{deviceId}",
  test: "/api/push/test",
} as const;

/** 设备在接口上的样子：没有令牌、没有公钥本身，只说有没有。 */
export function deviceView(
  device: PushDevice,
  currentDeviceId: string | undefined,
): Record<string, unknown> {
  return {
    deviceId: device.deviceId,
    platform: device.platform,
    transport: device.transport,
    appVersion: device.appVersion,
    locale: device.locale,
    encrypted: device.transport === "webpush" || device.publicKey !== "",
    // 契约 §27：要收的种类（没设过就是全部），以及是不是走 UnifiedPush——
    // 端点本身和令牌一样不出接口。
    kinds: device.kinds ?? PREFERENCE_KINDS,
    unifiedpush: device.unifiedpushEndpoint !== "",
    createdAt: new Date(device.createdAtMs).toISOString(),
    current: device.deviceId === currentDeviceId,
  };
}

interface Caller {
  /** `undefined` = 本机 owner（桌面壳，没有请求身份）。 */
  readonly principalId: string | undefined;
  readonly owner: boolean;
  readonly deviceId: string | undefined;
}

type Who = { readonly caller: Caller } | { readonly refusal: HandlerResult };

function caller(): Who {
  const identity = requestIdentity();
  if (identity === undefined) {
    return {
      caller: { principalId: undefined, owner: true, deviceId: undefined },
    };
  }
  const subject = identity.subject;
  // 服务器壳的匿名主体是一个没有 id 的成员：路由门放行了这一段，这里拦下。
  if (subject.kind !== "owner" && subject.principalId === "") {
    return {
      refusal: coreError(401, "unauthenticated", "需要一个已配对设备的会话"),
    };
  }
  return {
    caller: {
      principalId: subject.principalId,
      owner: subject.kind === "owner",
      deviceId: identity.device?.deviceId,
    },
  };
}

function guarded(
  handle: (
    caller: Caller,
    match: RouteMatch,
    request: CoreRequest,
  ) => HandlerResult,
): (match: RouteMatch, request: CoreRequest) => HandlerResult {
  return (match, request) => {
    const who = caller();
    if ("refusal" in who) return who.refusal;
    try {
      return handle(who.caller, match, request);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return coreError(400, "bad_request", "请求体不是合法的 JSON");
      }
      throw error;
    }
  };
}

export function installRoutes(server: CoreServer, push: PushService): void {
  const { router } = server;

  router.handle(
    "GET",
    PUSH_ROUTES.config,
    guarded(() => ({ status: 200, body: push.view() })),
  );

  router.handle(
    "GET",
    PUSH_ROUTES.devices,
    guarded((who) => ({
      status: 200,
      body: {
        devices: push.devices
          .list(who.principalId)
          .map((device) => deviceView(device, who.deviceId)),
      },
    })),
  );

  router.handle(
    "PUT",
    PUSH_ROUTES.devices,
    guarded((who, _match, request) => {
      if (who.deviceId === undefined) {
        return coreError(
          409,
          "device_required",
          "这次请求不属于任何已配对的设备，无法登记推送",
        );
      }
      if (!push.devices.identityDeviceActive(who.deviceId)) {
        return coreError(403, "forbidden", "这台设备已被撤销");
      }
      const parsed = parseRegistration(request.json());
      if (!parsed.ok) return coreError(400, "bad_request", parsed.message);
      const device = push.devices.register(who.deviceId, parsed.registration);
      return {
        status: 200,
        body: { device: deviceView(device, who.deviceId) },
      };
    }),
  );

  router.handle(
    "PATCH",
    PUSH_ROUTES.device,
    guarded((who, match, request) => {
      const deviceId = match.params.deviceId ?? "";
      const device = push.devices.get(deviceId);
      // 偏好只有设备的主人能改；owner 也不替别人决定他的手机响不响。
      if (
        device === undefined ||
        device.revokedAtMs !== 0 ||
        device.principalId !== who.principalId
      ) {
        return coreError(404, "not_found", "没有这台推送设备");
      }
      const body = request.json() as { kinds?: unknown } | null;
      const kinds =
        typeof body === "object" && body !== null
          ? parseKinds(body.kinds)
          : undefined;
      if (kinds === undefined) {
        return coreError(
          400,
          "bad_request",
          `kinds 应是由 ${PREFERENCE_KINDS.join("、")} 组成的数组`,
        );
      }
      // 全选存成「全部」：以后新加的种类缺省也收。
      push.devices.setKinds(
        deviceId,
        kinds.length === PREFERENCE_KINDS.length ? null : kinds,
      );
      const updated = push.devices.get(deviceId) as PushDevice;
      return {
        status: 200,
        body: { device: deviceView(updated, who.deviceId) },
      };
    }),
  );

  router.handle(
    "DELETE",
    PUSH_ROUTES.device,
    guarded((who, match) => {
      const deviceId = match.params.deviceId ?? "";
      const device = push.devices.get(deviceId);
      // 别人的设备与不存在的设备答同一句：不让成员借此探测设备 id。
      if (
        device === undefined ||
        (!who.owner && device.principalId !== who.principalId)
      ) {
        return coreError(404, "not_found", "没有这台推送设备");
      }
      return {
        status: 200,
        body: { revoked: push.devices.revoke(deviceId, "user") },
      };
    }),
  );

  router.handle(
    "POST",
    PUSH_ROUTES.test,
    guarded((who) => {
      const device =
        who.deviceId === undefined ? undefined : push.devices.get(who.deviceId);
      if (device === undefined || device.revokedAtMs !== 0) {
        return coreError(409, "device_required", "这台设备还没有登记推送");
      }
      return { status: 202, body: { queued: true, id: push.sendTest(device) } };
    }),
  );
}
