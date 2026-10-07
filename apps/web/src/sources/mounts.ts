import { createLocalConnection } from "./connection";
import { installPageSourceRegistry, type SourceRegistry } from "./registry";
import { attachRemoteStreams } from "./remote-stream";
import type { CloudAuth, CredentialProvider, SourceDescriptor } from "./types";

/**
 * 一个标签页同时挂多个源（手机与中继托管的页面，客户端包 §4、§5）。
 *
 * 选中的那台照旧装成本机源（`route-entry.ts`）：页面其余部分、身份面与五条流
 * 都不变，单源时与原来逐字相同。其余的连接作为远程源挂进页面源表，各自选路、
 * 换票、连流；侧栏按源分组列出它们，点一行即切当前源。
 */
export interface SiblingMountOptions {
  /** 已经装成本机源的那台（不再重复挂）。 */
  readonly primary: SourceDescriptor;
  /** 想一起挂上的连接（可以含 `primary`，会跳过）。 */
  readonly siblings: readonly SourceDescriptor[];
  /** 远程源的凭据来源（手机的钥匙串、托管页面的内存保管处）。 */
  readonly provider: CredentialProvider;
  /**
   * 远程服务的会话：给经中继的源各签发方开一条 `me.stream`（主机上线叫醒、
   * 撤销失权）。省略 = 调用方自己管那条流（中继托管的页面）。
   */
  readonly cloudAuth?: CloudAuth;
  /** 测试注入：换一张源表的做法。 */
  readonly install?: typeof installPageSourceRegistry;
  readonly attach?: typeof attachRemoteStreams;
}

export interface SiblingMount {
  readonly registry: SourceRegistry;
  dispose(): void;
}

/** 有别的连接才换源表；只有选中的那一台时什么也不做，答 `null`。 */
export function mountSiblingSources(
  options: SiblingMountOptions,
): SiblingMount | null {
  const { primary } = options;
  const others = options.siblings.filter(
    (row) => row.kind !== "local" && row.sourceId !== primary.sourceId,
  );
  if (others.length === 0) return null;
  const registry = (options.install ?? installPageSourceRegistry)({
    provider: options.provider,
    local: createLocalConnection({ label: primary.label }),
  });
  others.forEach((row, index) => registry.add({ ...row, orderIndex: index }));
  const detach =
    options.cloudAuth === undefined
      ? () => undefined
      : (options.attach ?? attachRemoteStreams)(registry, {
          auth: options.cloudAuth,
        });
  return {
    registry,
    dispose() {
      detach();
      registry.dispose();
    },
  };
}
