import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CoreLog } from "../platform";
import type { DeviceStore } from "./devices";
import {
  type PushDevice,
  type PushPayload,
  type PushSender,
  encodePayload,
} from "./types";

/**
 * 发送队列（`push_outbox`）与把它清空的那个循环。
 *
 * 先落库再发：触发规则只负责「该给谁发什么」，写一行就返回，事件总线上的发布
 * 者不会被一次慢的 APNs 往返拖住；core 在发送途中退出，下次启动接着发。
 *
 * 重试上限是**总共 3 次尝试**（补全架构 §8.1「发送失败不重试超过 3 次」）：第一次
 * 失败后 5 秒、第二次失败后 30 秒各再试一次。平台说令牌作废（`gone`）就不试了，
 * 设备随之撤销。
 */

export const MAX_ATTEMPTS = 3;
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000];
/** 终态的行留一周给排查，之后清掉。 */
export const OUTBOX_RETENTION_MS = 7 * 24 * 3600 * 1000;
const BATCH = 32;

export interface OutboxEntry {
  readonly id: string;
  readonly deviceId: string;
  readonly payload: PushPayload;
  readonly attempts: number;
  readonly createdAtMs: number;
  readonly sentAtMs: number;
  readonly failedAtMs: number;
  readonly nextAttemptAtMs: number;
  readonly reason: string;
}

interface OutboxRow {
  readonly id: string;
  readonly device_id: string;
  readonly payload_blob: Uint8Array;
  readonly attempts: number;
  readonly created_at_ms: number;
  readonly sent_at_ms: number;
  readonly failed_at_ms: number;
  readonly next_attempt_at_ms: number;
  readonly reason: string;
}

function entry(row: OutboxRow): OutboxEntry {
  return {
    id: row.id,
    deviceId: row.device_id,
    payload: JSON.parse(
      Buffer.from(row.payload_blob).toString("utf8"),
    ) as PushPayload,
    attempts: Number(row.attempts),
    createdAtMs: Number(row.created_at_ms),
    sentAtMs: Number(row.sent_at_ms),
    failedAtMs: Number(row.failed_at_ms),
    nextAttemptAtMs: Number(row.next_attempt_at_ms),
    reason: row.reason,
  };
}

const COLUMNS =
  "id, device_id, payload_blob, attempts, created_at_ms, sent_at_ms, failed_at_ms, next_attempt_at_ms, reason";

export class Outbox {
  constructor(
    private readonly database: DatabaseSync,
    private readonly clock: () => number = Date.now,
  ) {}

  enqueue(deviceId: string, payload: PushPayload): string {
    const id = randomBytes(16).toString("hex");
    const now = this.clock();
    this.database
      .prepare(
        `INSERT INTO push_outbox (id, device_id, payload_blob, created_at_ms, next_attempt_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, deviceId, encodePayload(payload), now, now);
    return id;
  }

  get(id: string): OutboxEntry | undefined {
    const row = this.database
      .prepare(`SELECT ${COLUMNS} FROM push_outbox WHERE id = ?`)
      .get(id) as OutboxRow | undefined;
    return row === undefined ? undefined : entry(row);
  }

  /** 到点的、还没终态的那些，最早的先。 */
  due(now: number, limit = BATCH): OutboxEntry[] {
    const rows = this.database
      .prepare(
        `SELECT ${COLUMNS} FROM push_outbox
          WHERE sent_at_ms = 0 AND failed_at_ms = 0 AND next_attempt_at_ms <= ?
          ORDER BY next_attempt_at_ms, created_at_ms LIMIT ?`,
      )
      .all(now, limit) as unknown as OutboxRow[];
    return rows.map(entry);
  }

  /** 下一条要等的行什么时候到点；没有就是 `undefined`。 */
  nextDueAt(): number | undefined {
    const row = this.database
      .prepare(
        `SELECT MIN(next_attempt_at_ms) AS at FROM push_outbox
          WHERE sent_at_ms = 0 AND failed_at_ms = 0`,
      )
      .get() as { at: number | null } | undefined;
    return row?.at === null || row?.at === undefined
      ? undefined
      : Number(row.at);
  }

  /** 领走一次尝试：次数 +1，在答复回来之前别的循环不会再领它。 */
  claim(id: string, until: number): void {
    this.database
      .prepare(
        "UPDATE push_outbox SET attempts = attempts + 1, next_attempt_at_ms = ? WHERE id = ?",
      )
      .run(until, id);
  }

  markSent(id: string): void {
    this.database
      .prepare(
        "UPDATE push_outbox SET sent_at_ms = ?, reason = '' WHERE id = ?",
      )
      .run(this.clock(), id);
  }

  markFailed(id: string, reason: string): void {
    this.database
      .prepare(
        "UPDATE push_outbox SET failed_at_ms = ?, reason = ? WHERE id = ?",
      )
      .run(this.clock(), reason.slice(0, 256), id);
  }

  retryAt(id: string, at: number, reason: string): void {
    this.database
      .prepare(
        "UPDATE push_outbox SET next_attempt_at_ms = ?, reason = ? WHERE id = ?",
      )
      .run(at, reason.slice(0, 256), id);
  }

  /** 删掉终态超过保留期的行；还在等的一条不动。 */
  prune(now: number): number {
    const cutoff = now - OUTBOX_RETENTION_MS;
    const result = this.database
      .prepare(
        `DELETE FROM push_outbox
          WHERE (sent_at_ms > 0 AND sent_at_ms < ?) OR (failed_at_ms > 0 AND failed_at_ms < ?)`,
      )
      .run(cutoff, cutoff);
    return Number(result.changes);
  }
}

export interface DispatcherOptions {
  readonly outbox: Outbox;
  readonly devices: DeviceStore;
  /** 按设备与当时的设置选发送器；设置改了下一条就换。 */
  readonly senderFor: (device: PushDevice) => PushSender;
  readonly log: CoreLog;
  readonly clock?: () => number;
}

/**
 * 清空队列的循环。`kick()` 让它尽快跑一轮；一轮里同一时刻只有一个 `drain` 在
 * 跑，跑的过程中又被 kick 就再跑一轮。还有等着重试的行时挂一个 unref 的定时器，
 * 不拖住进程退出。
 */
export class PushDispatcher {
  private draining: Promise<void> | undefined;
  private again = false;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly clock: () => number;

  constructor(private readonly options: DispatcherOptions) {
    this.clock = options.clock ?? Date.now;
  }

  kick(): void {
    if (this.stopped) return;
    if (this.draining !== undefined) {
      this.again = true;
      return;
    }
    this.draining = this.drain()
      .catch((error: unknown) => {
        // 库在关闭途中（core 正在退出）或别的意外：这一轮作罢，行还在库里，
        // 下次启动接着发。不能让它变成一个未处理的拒绝。
        this.options.log.warn("推送队列这一轮没跑完", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.draining = undefined;
        if (this.again) {
          this.again = false;
          this.kick();
        } else {
          this.arm();
        }
      });
  }

  /** 等当前这一轮（以及它触发的下一轮）跑完。测试与退出用。 */
  async idle(): Promise<void> {
    while (this.draining !== undefined) await this.draining;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    if (this.stopped) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const next = this.options.outbox.nextDueAt();
    if (next === undefined) return;
    const delay = Math.max(0, next - this.clock());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.kick();
    }, delay);
    this.timer.unref();
  }

  private async drain(): Promise<void> {
    const { outbox } = this.options;
    for (;;) {
      if (this.stopped) return;
      const batch = outbox.due(this.clock());
      if (batch.length === 0) return;
      await Promise.all(batch.map((item) => this.attempt(item)));
    }
  }

  private async attempt(item: OutboxEntry): Promise<void> {
    const { outbox, devices, log } = this.options;
    const now = this.clock();
    const device = devices.get(item.deviceId);
    if (device === undefined || device.revokedAtMs !== 0) {
      outbox.markFailed(item.id, "deviceRevoked");
      return;
    }
    const attempt = item.attempts + 1;
    // 领走：答复回来之前把到点时间推远，别的一轮不会再领它。
    outbox.claim(item.id, now + 60_000);
    let result;
    try {
      result = await this.options.senderFor(device).send(device, item.payload);
    } catch (error) {
      result = {
        ok: false as const,
        retry: true,
        gone: false,
        reason: `sender: ${(error as Error).message}`,
      };
    }
    if (result.ok) {
      outbox.markSent(item.id);
      return;
    }
    if (result.gone) {
      devices.revoke(device.deviceId, "gone");
      outbox.markFailed(item.id, result.reason);
      log.info("推送令牌已作废，设备登记已撤销", {
        deviceId: device.deviceId,
        transport: device.transport,
      });
      return;
    }
    const delay = RETRY_DELAYS_MS[attempt - 1];
    if (result.retry && attempt < MAX_ATTEMPTS && delay !== undefined) {
      outbox.retryAt(item.id, this.clock() + delay, result.reason);
      return;
    }
    outbox.markFailed(item.id, result.reason);
    log.warn("推送没有送出", {
      deviceId: device.deviceId,
      transport: device.transport,
      attempts: attempt,
      reason: result.reason,
    });
  }
}
