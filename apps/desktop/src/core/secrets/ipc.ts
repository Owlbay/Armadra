/**
 * 桌面壳的 `safeStorage`，隔着 fork 的 IPC 通道。
 *
 * 桌面壳的 core 是 `child_process.fork` 出来的 `ELECTRON_RUN_AS_NODE` 子进程，那里
 * 没有 `safeStorage`——它只在 Electron 主进程里。所以封与解经 fork 自带的 IPC
 * 通道问壳（`main/secrets.ts` 应答）。壳在 spawn 时把它能给的种类写进
 * {@link SEALER_ENV}；core 只在看到这个变量**而且**有通道时才用这一条。
 *
 * 线上形状（两边共用这里的类型）：
 *
 *     core → 壳  { type: "armadra:secrets", id, op: "seal" | "unseal", data }
 *     壳 → core  { type: "armadra:secrets", id, ok: true, data }
 *                { type: "armadra:secrets", id, ok: false, code }
 *
 * `data` 是 base64：IPC 的 JSON 序列化不保留 Buffer。每个请求有 id 与超时；通道
 * 断开时所有挂着的请求一起以 `shell_disconnected` 失败。
 */

import { SecretUnavailable, type SecretSealer } from "./backend";

/** 壳写给 core 的环境变量：`ipc:dpapi` 或 `ipc:libsecret`。 */
export const SEALER_ENV = "ARMADRA_SECRET_SEALER";

export const SECRETS_MESSAGE = "armadra:secrets";

export type SealerKind = SecretSealer["kind"];

export interface SealRequest {
  readonly type: typeof SECRETS_MESSAGE;
  readonly id: number;
  readonly op: "seal" | "unseal";
  readonly data: string;
}

export type SealResponse =
  | {
      readonly type: typeof SECRETS_MESSAGE;
      readonly id: number;
      readonly ok: true;
      readonly data: string;
    }
  | {
      readonly type: typeof SECRETS_MESSAGE;
      readonly id: number;
      readonly ok: false;
      readonly code: string;
    };

/** 读 {@link SEALER_ENV}；不认识的值当作没有。 */
export function sealerKindFromEnv(
  env: NodeJS.ProcessEnv,
): SealerKind | undefined {
  const value = (env[SEALER_ENV] ?? "").trim();
  if (value === "ipc:dpapi") return "dpapi";
  if (value === "ipc:libsecret") return "libsecret";
  return undefined;
}

/** fork 的子进程那一端：`process` 本身就满足它。 */
export interface IpcChannel {
  send?: ((message: unknown) => boolean) | undefined;
  readonly connected?: boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "disconnect", listener: () => void): unknown;
}

export const SEAL_TIMEOUT_MS = 10_000;

function isResponse(message: unknown): message is SealResponse {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === SECRETS_MESSAGE &&
    typeof (message as { id?: unknown }).id === "number" &&
    typeof (message as { ok?: unknown }).ok === "boolean"
  );
}

/**
 * 一个经 IPC 问壳的 {@link SecretSealer}。通道已经断开（core 被下一个壳接管、
 * 原来的壳不在了）时每次调用都以 {@link SecretUnavailable} 失败——**不**降级成
 * 明文。
 */
export function ipcSealer(
  kind: SealerKind,
  channel: IpcChannel,
  timeoutMs: number = SEAL_TIMEOUT_MS,
): SecretSealer {
  let next = 1;
  let disconnected = false;
  const pending = new Map<
    number,
    {
      resolve: (data: Buffer) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  channel.on("message", (message) => {
    if (!isResponse(message)) return;
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.ok) waiter.resolve(Buffer.from(message.data, "base64"));
    else waiter.reject(new SecretUnavailable(message.code));
  });
  channel.on("disconnect", () => {
    disconnected = true;
    for (const [id, waiter] of pending) {
      pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(new SecretUnavailable("shell_disconnected"));
    }
  });

  const call = (op: SealRequest["op"], data: Buffer): Promise<Buffer> => {
    if (
      disconnected ||
      channel.send === undefined ||
      channel.connected === false
    ) {
      return Promise.reject(new SecretUnavailable("shell_disconnected"));
    }
    const id = next++;
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new SecretUnavailable("shell_timeout"));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      const request: SealRequest = {
        type: SECRETS_MESSAGE,
        id,
        op,
        data: data.toString("base64"),
      };
      try {
        channel.send?.(request);
      } catch {
        pending.delete(id);
        clearTimeout(timer);
        reject(new SecretUnavailable("shell_disconnected"));
      }
    });
  };

  return {
    kind,
    seal: (plain) => call("seal", plain),
    unseal: (sealed) => call("unseal", sealed),
  };
}
