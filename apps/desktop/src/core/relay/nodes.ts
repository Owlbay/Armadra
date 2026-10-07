/**
 * 节点与隧道令牌（平台规格 core 包 §4.2 第 1 步；远程服务一侧见 cloud-api §4 的
 * `sources.heartbeatHint` 与 §10 的「源认证」）。
 *
 * `GET <issuer>/v1/sources/me/relay`，`Authorization: Source <jws>`（源私钥签，
 * `aud` = issuer）→ `{ tunnelToken, expiresAtMs, nodes, limits }`。令牌一小时有效，
 * 这里缓存 50 分钟（外呼登记 `cloudApi`「隧道令牌每 50 分钟」），被中继拒了就丢。
 * 节点按 `cloud.relay.preferredNode`（地址或区域名）→ 权重排序；一个连不上就换
 * 下一个。请求与 `core/sources` 同一个发送点：按远程服务的 CA 指纹钉扎。
 */

import { relayNodeSchema } from "@armadra/platform-protocol/cloud-api";
import { tunnelLimitsSchema } from "@armadra/platform-protocol/tunnel";

import type { Transport } from "../sources/http-client";

/** 缓存的隧道令牌最多用这么久（令牌本身一小时）。 */
export const TUNNEL_TOKEN_REUSE_MS = 50 * 60_000;
/** 离到期不到这么久的令牌不再用。 */
const EXPIRY_MARGIN_MS = 60_000;
const TIMEOUT_MS = 10_000;

export interface RelayNode {
  readonly url: string;
  readonly region?: string | undefined;
  readonly weight: number;
}

export interface RelayHint {
  readonly tunnelToken: string;
  readonly expiresAtMs: number;
  readonly nodes: readonly RelayNode[];
  readonly limits: RelayLimits;
}

/** 中继给的流控限制（`ready.limits` 同形）。 */
export interface RelayLimits {
  readonly maxStreams: number;
  readonly streamWindow: number;
  readonly tunnelWindow: number;
  readonly maxFrameBytes: number;
}

/** `sources.heartbeatHint` 的答案（协议包的节点与限制 schema 逐项验）。 */
function parseHint(body: unknown): RelayHint | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = body as Record<string, unknown>;
  if (typeof value.tunnelToken !== "string" || value.tunnelToken === "") {
    return undefined;
  }
  if (typeof value.expiresAtMs !== "number") return undefined;
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) return undefined;
  const nodes: RelayNode[] = [];
  for (const raw of value.nodes as unknown[]) {
    const node = relayNodeSchema.safeParse(raw);
    if (!node.success) return undefined;
    nodes.push(node.data);
  }
  const limits = tunnelLimitsSchema.safeParse(value.limits);
  if (!limits.success) return undefined;
  return {
    tunnelToken: value.tunnelToken,
    expiresAtMs: value.expiresAtMs,
    nodes,
    limits: limits.data,
  };
}

/** 取令牌或节点时的失败：`code` 进隧道状态的 `lastError`。 */
export class RelayError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

export interface NodeDirectoryOptions {
  readonly issuer: string;
  readonly transport: Transport;
  /** `Authorization: Source <jws>` 的那张 JWS（`aud` = issuer）。 */
  readonly signSourceJws: (audience: string) => Promise<string>;
  /** 远程服务的 CA 指纹；空串 = 系统信任。 */
  readonly fingerprint: () => string;
  /** `cloud.relay.preferredNode`：节点地址或区域名，空串 = 不偏好。 */
  readonly preferredNode: () => string;
  readonly now?: () => number;
}

export interface PickedNode {
  readonly url: string;
  readonly tunnelToken: string;
}

/** 偏好的排最前，其余按权重从大到小（同权重保持原顺序）。 */
export function orderNodes(
  nodes: readonly RelayNode[],
  preferred: string,
): RelayNode[] {
  const wanted = preferred.trim();
  const rank = (node: RelayNode) =>
    wanted !== "" && (node.url === wanted || node.region === wanted) ? 1 : 0;
  return nodes
    .map((node, index) => ({ node, index }))
    .sort(
      (a, b) =>
        rank(b.node) - rank(a.node) ||
        b.node.weight - a.node.weight ||
        a.index - b.index,
    )
    .map((entry) => entry.node);
}

export class NodeDirectory {
  private hint: { value: RelayHint; fetchedAtMs: number } | undefined;
  private cursor = 0;
  private readonly now: () => number;

  constructor(private readonly options: NodeDirectoryOptions) {
    this.now = options.now ?? Date.now;
  }

  /** 中继给的限制（握手前的初值；`ready` 里的为准）。 */
  limits(): RelayLimits | undefined {
    return this.hint?.value.limits;
  }

  /** 这一次连哪个节点、带哪张令牌。缓存的令牌够新就不再问远程服务。 */
  async pick(): Promise<PickedNode> {
    const at = this.now();
    let hint = this.hint;
    if (
      hint === undefined ||
      at - hint.fetchedAtMs >= TUNNEL_TOKEN_REUSE_MS ||
      hint.value.expiresAtMs - EXPIRY_MARGIN_MS <= at
    ) {
      hint = { value: await this.fetch(), fetchedAtMs: at };
      this.hint = hint;
    }
    const nodes = orderNodes(hint.value.nodes, this.options.preferredNode());
    const node = nodes[this.cursor % nodes.length] as RelayNode;
    return { url: node.url, tunnelToken: hint.value.tunnelToken };
  }

  /** 这个节点不行：下一次换下一个。 */
  rotate(): void {
    this.cursor += 1;
  }

  /** 中继不认这张令牌：下一次重新取。 */
  invalidate(): void {
    this.hint = undefined;
  }

  private async fetch(): Promise<RelayHint> {
    const { issuer } = this.options;
    let jws: string;
    try {
      jws = await this.options.signSourceJws(issuer);
    } catch {
      throw new RelayError("source_key_unavailable", "源私钥不可用");
    }
    let answer: { status: number; body: unknown };
    try {
      answer = await this.options.transport({
        method: "GET",
        url: `${issuer}/v1/sources/me/relay`,
        fingerprint: this.options.fingerprint(),
        timeoutMs: TIMEOUT_MS,
        headers: { authorization: `Source ${jws}` },
      });
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: unknown }).code === "fingerprint_mismatch"
          ? "fingerprint_mismatch"
          : "relay_unreachable";
      throw new RelayError(code, "连不上远程服务");
    }
    const code =
      typeof answer.body === "object" &&
      answer.body !== null &&
      "code" in answer.body
        ? String((answer.body as { code: unknown }).code)
        : "";
    if (answer.status === 410 || code === "source_revoked") {
      throw new RelayError("source_revoked", "远程服务已撤销这台机器的登记");
    }
    if (answer.status === 401 || answer.status === 403) {
      throw new RelayError("source_unauthenticated", "远程服务不认这台机器");
    }
    if (answer.status < 200 || answer.status >= 300) {
      throw new RelayError(
        "relay_unreachable",
        `远程服务没能给出隧道令牌（${answer.status}）`,
      );
    }
    const parsed = parseHint(answer.body);
    if (parsed === undefined) {
      throw new RelayError("relay_unreachable", "远程服务的隧道令牌答案不完整");
    }
    return parsed;
  }
}
