import {
  type PushPreferenceKind,
  type PushRegistration,
  pushConfigSchema,
  pushDeviceListSchema,
  pushDeviceResponseSchema,
  pushRevokeResponseSchema,
  pushTestResponseSchema,
} from "@armadra/shared";

import { currentClient } from "./client";

/**
 * 推送（契约 §43.4，形状见 §19、§27）：配置、设备登记与撤销、测试通知，经
 * `push.*` procedure。推送域只碰请求主体自己的设备；答案里没有令牌与密钥，页面
 * 照旧按自己的 schema 再解析一遍。登记体里的令牌与订阅密钥只在这次调用里出去一次。
 */
export const pushApi = {
  config: async () =>
    pushConfigSchema.parse(await currentClient().push.config()),
  devices: async () =>
    pushDeviceListSchema.parse(await currentClient().push.devices()),
  /** 登记或覆盖这次请求背后那台设备的推送；`body` 是浏览器订阅或原生登记。 */
  register: async (body: PushRegistration | Record<string, unknown>) =>
    pushDeviceResponseSchema.parse(
      await currentClient().push.register(body as never),
    ),
  setKinds: async (deviceId: string, kinds: readonly PushPreferenceKind[]) =>
    pushDeviceResponseSchema.parse(
      await currentClient().push.setKinds({ deviceId, kinds: [...kinds] }),
    ),
  revoke: async (deviceId: string) =>
    pushRevokeResponseSchema.parse(
      await currentClient().push.revoke({ deviceId }),
    ),
  test: async () =>
    pushTestResponseSchema.parse(await currentClient().push.test()),
};
