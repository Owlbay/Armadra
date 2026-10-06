/**
 * 隧道读的设置键（契约 §32）：`cloud.relay.enabled`（缺省 `true`，关掉即全部停）、
 * `cloud.relay.preferredNode`（节点地址或区域名，空串 = 不偏好）。每次现读；
 * 开关的翻转经 `SettingsStore.onChange` 当场生效。组织默认角色
 * `cloud.orgDefaultRole` 由身份域读（`identity/index.ts`）。
 */

import type { JsonValue } from "../settings";
import { completionSettings, settingsDomain } from "../settings";

export interface RelaySettings {
  readonly enabled: boolean;
  readonly preferredNode: string;
}

export function relaySettingsOf(document: JsonValue): RelaySettings {
  const { relay } = completionSettings(document).cloud;
  return { enabled: relay.enabled, preferredNode: relay.preferredNode.trim() };
}

/** 这一轮 core 的设置；设置域没装（单元测试）时按缺省。 */
export function currentRelaySettings(): RelaySettings {
  return relaySettingsOf(settingsDomain()?.settings.snapshot() ?? {});
}

/** 开关翻转时叫一次；没有设置域时不订阅。返回退订函数。 */
export function onRelaySettings(
  listener: (settings: RelaySettings) => void,
): () => void {
  const store = settingsDomain()?.settings;
  if (store === undefined) return () => undefined;
  return store.onChange((document) => listener(relaySettingsOf(document)));
}
