/**
 * 主进程自己打 core 时带的会话（契约 §3.2，安全审查 L9）。
 *
 * core 不再放行回环上没带凭据的请求，托盘读用量、读写 Gateway 开关也得像页面
 * 一样带一个会话。做法与页面相同：向 core 的私有通道要一张票（壳这一侧的
 * `main/core-ticket.ts`），在回环监听上 `POST /api/identity/pair` 换一份只在
 * 内存里的 Bearer；401 时先用刷新密钥换，换不出再重新要票，只重发一次。
 *
 * 会话绑在来源上。托盘没有页面，来源用 core 自己的回环基址——它是一个壳能呈现
 * 的回环明文来源，和页面的来源分开，各是各的会话。core 换了端口（重启）就是
 * 换了来源，旧会话作废、重新配对。
 *
 * 不碰 Electron：票由调用方注入，测试给假的。
 */

export interface CoreSessionOptions {
  /** core 的 HTTP 基址，每次现问：端口由内核分配，core 重启会变。 */
  readonly base: () => Promise<string>;
  /** 为这个来源签一张一次性票（只回票本身）。 */
  readonly ticket: (origin: string) => Promise<string>;
  /** 测试注入；缺省是全局 `fetch`。 */
  readonly fetch?: typeof fetch;
}

interface Keys {
  readonly origin: string;
  readonly access: string;
  readonly refresh: string;
}

export class CoreSession {
  private keys: Keys | null = null;
  private renewing: Promise<Keys | null> | null = null;

  constructor(private readonly options: CoreSessionOptions) {}

  private get load(): typeof fetch {
    return this.options.fetch ?? ((input, init) => fetch(input, init));
  }

  /**
   * 带着会话发一个请求。`path` 相对 core 的基址。配不上对（core 还没起来、
   * 签不出票）时抛出，调用方按「这一轮没读到」处理。
   */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const base = (await this.options.base()).replace(/\/+$/, "");
    const origin = new URL(base).origin;
    let keys = this.keys?.origin === origin ? this.keys : null;
    keys ??= await this.renew(base, origin, null);
    if (keys === null) throw new Error("no core session");
    const send = (current: Keys) =>
      this.load(`${base}${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          origin: current.origin,
          authorization: `Bearer ${current.access}`,
        },
      });
    const response = await send(keys);
    const replayable =
      init.body === undefined ||
      init.body === null ||
      typeof init.body === "string";
    if (response.status !== 401 || !replayable) return response;
    // 访问密钥 15 分钟就过期：401 说明这次请求没进处理器，换一枚再发一次
    // 不会把任何事做两遍。
    const renewed = await this.renew(base, origin, keys);
    return renewed === null ? response : send(renewed);
  }

  /** 忘掉手里的会话（测试与 core 换人之后）。 */
  reset(): void {
    this.keys = null;
    this.renewing = null;
  }

  /**
   * 换一份会话：手里有被拒的那份就先用刷新密钥换，换不出（或根本没有）就重新
   * 要票配对。几个请求同时被拒只换一次。
   */
  private renew(
    base: string,
    origin: string,
    rejected: Keys | null,
  ): Promise<Keys | null> {
    if (
      this.keys !== null &&
      this.keys !== rejected &&
      this.keys.origin === origin
    )
      return Promise.resolve(this.keys);
    this.renewing ??= (async () => {
      try {
        let next: Keys | null = null;
        if (rejected !== null && rejected.origin === origin) {
          next = await this.exchange(base, origin, "session/refresh", {
            authorization: `Bearer ${rejected.refresh}`,
          }).catch(() => null);
        }
        next ??= await this.pair(base, origin).catch(() => null);
        this.keys = next;
        return next;
      } finally {
        this.renewing = null;
      }
    })();
    return this.renewing;
  }

  private async pair(base: string, origin: string): Promise<Keys | null> {
    const ticket = await this.options.ticket(origin);
    return this.exchange(base, origin, "pair", {}, { ticket });
  }

  private async exchange(
    base: string,
    origin: string,
    action: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<Keys | null> {
    const response = await this.load(`${base}/api/identity/${action}`, {
      method: "POST",
      headers: {
        ...headers,
        origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const answer = (await response.json()) as {
      native?: { accessToken?: unknown; refreshToken?: unknown };
    };
    const access = answer.native?.accessToken;
    const refresh = answer.native?.refreshToken;
    if (typeof access !== "string" || typeof refresh !== "string") return null;
    return { origin, access, refresh };
  }
}
