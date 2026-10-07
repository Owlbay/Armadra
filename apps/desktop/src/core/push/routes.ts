import type { PushDevice as PushDeviceView } from "@armadra/shared";
import { CoreFailure, coreError, fail } from "../http/errors";
import type { HandlerResult, RouteMatch, CoreRequest } from "../http/router";
import { type DomainHandlers, registerProcedures } from "../http/rpc";
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
 *
 * 每个动作收成一份操作（{@link operations}），旧路径的 handler 与
 * `registerProcedures(server, "push", …)`（契约 §43.4）调同一份：身份都经
 * `requestIdentity()` 认，拒绝都是 {@link CoreFailure}，码、状态与原话一样。
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
): PushDeviceView {
  return {
    deviceId: device.deviceId,
    platform: device.platform,
    transport: device.transport,
    appVersion: device.appVersion,
    locale: device.locale,
    encrypted: device.transport === "webpush" || device.publicKey !== "",
    // 契约 §27：要收的种类（没设过就是全部），以及是不是走 UnifiedPush——
    // 端点本身和令牌一样不出接口。
    kinds: [...(device.kinds ?? PREFERENCE_KINDS)],
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

function caller(): Caller {
  const identity = requestIdentity();
  if (identity === undefined) {
    return { principalId: undefined, owner: true, deviceId: undefined };
  }
  const subject = identity.subject;
  // 服务器壳的匿名主体是一个没有 id 的成员：路由门放行了这一段，这里拦下。
  if (subject.kind !== "owner" && subject.principalId === "") {
    throw new CoreFailure(401, "unauthenticated", "需要一个已配对设备的会话");
  }
  return {
    principalId: subject.principalId,
    owner: subject.kind === "owner",
    deviceId: identity.device?.deviceId,
  };
}

/** 推送域的操作：旧路径与 procedure 共用；拒绝抛 {@link CoreFailure}。 */
function operations(push: PushService) {
  return {
    config: () => push.view(),
    devices: () => {
      const who = caller();
      return {
        devices: push.devices
          .list(who.principalId)
          .map((device) => deviceView(device, who.deviceId)),
      };
    },
    register: (body: unknown) => {
      const who = caller();
      if (who.deviceId === undefined) {
        throw fail(
          "device_required",
          "这次请求不属于任何已配对的设备，无法登记推送",
        );
      }
      if (!push.devices.identityDeviceActive(who.deviceId)) {
        throw fail("forbidden", "这台设备已被撤销");
      }
      const parsed = parseRegistration(body);
      if (!parsed.ok) throw fail("bad_request", parsed.message);
      const device = push.devices.register(who.deviceId, parsed.registration);
      return { device: deviceView(device, who.deviceId) };
    },
    setKinds: (deviceId: string, requested: unknown) => {
      const who = caller();
      const device = push.devices.get(deviceId);
      // 偏好只有设备的主人能改；owner 也不替别人决定他的手机响不响。
      if (
        device === undefined ||
        device.revokedAtMs !== 0 ||
        device.principalId !== who.principalId
      ) {
        throw fail("not_found", "没有这台推送设备");
      }
      const kinds = parseKinds(requested);
      if (kinds === undefined) {
        throw fail(
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
      return { device: deviceView(updated, who.deviceId) };
    },
    revoke: (deviceId: string) => {
      const who = caller();
      const device = push.devices.get(deviceId);
      // 别人的设备与不存在的设备答同一句：不让成员借此探测设备 id。
      if (
        device === undefined ||
        (!who.owner && device.principalId !== who.principalId)
      ) {
        throw fail("not_found", "没有这台推送设备");
      }
      return { revoked: push.devices.revoke(deviceId, "user") };
    },
    test: () => {
      const who = caller();
      const device =
        who.deviceId === undefined ? undefined : push.devices.get(who.deviceId);
      if (device === undefined || device.revokedAtMs !== 0) {
        throw fail("device_required", "这台设备还没有登记推送");
      }
      return { queued: true as const, id: push.sendTest(device) };
    },
  };
}

type Work = (match: RouteMatch, request: CoreRequest) => HandlerResult;

/** 旧路径：操作抛的拒绝换成 `{ code, message }`，坏 JSON 答 400。 */
function guarded(work: Work): Work {
  return (match, request) => {
    try {
      return work(match, request);
    } catch (error) {
      if (error instanceof CoreFailure) return error.response();
      if (error instanceof SyntaxError) {
        return coreError(400, "bad_request", "请求体不是合法的 JSON");
      }
      throw error;
    }
  };
}

export function installRoutes(server: CoreServer, push: PushService): void {
  const { router } = server;
  const run = operations(push);

  router.handle(
    "GET",
    PUSH_ROUTES.config,
    guarded(() => ({ status: 200, body: run.config() })),
  );
  router.handle(
    "GET",
    PUSH_ROUTES.devices,
    guarded(() => ({ status: 200, body: run.devices() })),
  );
  router.handle(
    "PUT",
    PUSH_ROUTES.devices,
    guarded((_match, request) => ({
      status: 200,
      body: run.register(request.json()),
    })),
  );
  router.handle(
    "PATCH",
    PUSH_ROUTES.device,
    guarded((match, request) => {
      const body = request.json() as { kinds?: unknown } | null;
      return {
        status: 200,
        body: run.setKinds(
          match.params.deviceId ?? "",
          typeof body === "object" && body !== null ? body.kinds : undefined,
        ),
      };
    }),
  );
  router.handle(
    "DELETE",
    PUSH_ROUTES.device,
    guarded((match) => ({
      status: 200,
      body: run.revoke(match.params.deviceId ?? ""),
    })),
  );
  router.handle(
    "POST",
    PUSH_ROUTES.test,
    guarded(() => ({ status: 202, body: run.test() })),
  );

  // procedure（契约 §43.4）：入参已由门面按契约解析，拒绝抛 `CoreFailure`。
  registerProcedures(server, "push", {
    config: () => run.config(),
    devices: () => run.devices(),
    register: (body) => run.register(body),
    setKinds: ({ deviceId, kinds }) => run.setKinds(deviceId, kinds),
    revoke: ({ deviceId }) => run.revoke(deviceId),
    test: () => run.test(),
  } satisfies DomainHandlers<"push">);
}
