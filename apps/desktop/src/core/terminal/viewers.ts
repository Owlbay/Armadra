import { type Lease, deviceOrLocal } from "../drive/lease";
import type { TerminalSize } from "./backend";

/**
 * 多端观看同一个终端时的尺寸（ui-acp-refresh §7.3 E-1）。
 *
 * 会话只有一个**窗口**尺寸——里面的程序看到的那个；每一端（一个 socket）各自
 * 记着自己的尺寸。窗口取谁的由 {@link windowSizeOf} 决定，只在结果变了时才
 * 告诉后端一次，所以一端加入、离开或改自己的容器，不会让别的端整屏重绘。
 */

/**
 * One socket watching a session, as the window-size rule sees it. `actor` is
 * the drive-lease id the same socket's keystrokes would hold the lease under.
 */
export interface WindowViewer {
  readonly id: number;
  readonly actor: string;
  readonly cols: number;
  readonly rows: number;
}

/**
 * The window size of a session several viewers watch.
 *
 *   1. A person holding the drive lease, through a viewer that is still
 *      connected, gets their size: typing from a phone is choosing the phone's
 *      width. `driving` is the viewer that last sent keystrokes; without one,
 *      the largest of the holder's viewers.
 *   2. Otherwise the largest viewer by area. A phone that only watches never
 *      shrinks a desktop, and the window grows back once the phone lets go.
 *   3. Between equally large viewers the current window stays, so a tie never
 *      flips back and forth.
 *
 * `undefined` with no viewer at all: nobody to size for, the window stays.
 */
export function windowSizeOf(
  viewers: readonly WindowViewer[],
  lease: Lease,
  current: TerminalSize,
  driving?: number,
): TerminalSize | undefined {
  if (viewers.length === 0) return undefined;
  const area = (viewer: WindowViewer) => viewer.cols * viewer.rows;
  const holder = lease.holder;
  if (
    holder?.kind === "human" &&
    (lease.state === "human" || lease.state === "humanTakeover")
  ) {
    const own = viewers.filter((viewer) => viewer.actor === holder.id);
    const driver =
      own.find((viewer) => viewer.id === driving) ??
      own.reduce<WindowViewer | undefined>(
        (best, viewer) =>
          best === undefined || area(viewer) > area(best) ? viewer : best,
        undefined,
      );
    if (driver !== undefined) return { cols: driver.cols, rows: driver.rows };
  }
  const largest = Math.max(...viewers.map(area));
  const tied = viewers.filter((viewer) => area(viewer) === largest);
  const keep = tied.find(
    (viewer) => viewer.cols === current.cols && viewer.rows === current.rows,
  );
  const chosen = keep ?? tied[0]!;
  return { cols: chosen.cols, rows: chosen.rows };
}

export function clampSize(size: TerminalSize): TerminalSize {
  return {
    cols: Math.max(2, Math.trunc(size.cols)),
    rows: Math.max(2, Math.trunc(size.rows)),
  };
}

/** What the window book needs from the manager about one live session. */
export interface WindowHost {
  /** The current window, and how to change it; `undefined` once it ended. */
  window(sessionId: string):
    | {
        readonly size: TerminalSize;
        apply(next: TerminalSize): Promise<void>;
      }
    | undefined;
  lease(sessionId: string): Lease;
  log(message: string, fields?: Record<string, unknown>): void;
}

/**
 * 每个会话的观看者（按 attach 顺序）、最近敲键的那一端，以及窗口改动的队列。
 */
export class TerminalWindows {
  private readonly viewers = new Map<string, Map<number, WindowViewer>>();
  private readonly driving = new Map<string, number>();
  private readonly queue = new Map<string, Promise<void>>();

  constructor(private readonly host: WindowHost) {}

  add(sessionId: string, id: number, writer: string, size: TerminalSize) {
    let viewers = this.viewers.get(sessionId);
    if (viewers === undefined) {
      viewers = new Map();
      this.viewers.set(sessionId, viewers);
    }
    viewers.set(id, { id, actor: deviceOrLocal(writer), ...size });
  }

  remove(sessionId: string, id: number): void {
    this.viewers.get(sessionId)?.delete(id);
    if (this.driving.get(sessionId) === id) this.driving.delete(sessionId);
  }

  /**
   * The viewer `id` sent keystrokes: if its person holds (or is about to hold)
   * the drive lease, the window follows this viewer.
   */
  noteInput(sessionId: string, id: number): void {
    if (this.driving.get(sessionId) === id) return;
    if (this.viewers.get(sessionId)?.has(id) !== true) return;
    this.driving.set(sessionId, id);
    void this.refresh(sessionId);
  }

  /** Records one viewer's new size. `unknown` when no such viewer watches. */
  resize(
    sessionId: string,
    id: number | undefined,
    size: TerminalSize,
  ): "unknown" | "same" | "changed" {
    const viewers = this.viewers.get(sessionId);
    const viewer = id === undefined ? undefined : viewers?.get(id);
    if (viewers === undefined || viewer === undefined) return "unknown";
    if (viewer.cols === size.cols && viewer.rows === size.rows) return "same";
    viewers.set(viewer.id, { ...viewer, ...size });
    return "changed";
  }

  list(sessionId: string): readonly WindowViewer[] {
    return [...(this.viewers.get(sessionId)?.values() ?? [])];
  }

  forget(sessionId: string): void {
    this.viewers.delete(sessionId);
    this.driving.delete(sessionId);
    this.queue.delete(sessionId);
  }

  /**
   * Re-decides the window and tells the backend only when it changed. Queued
   * per session, so two decisions cannot reach the backend out of order.
   */
  refresh(sessionId: string): Promise<void> {
    const previous = this.queue.get(sessionId) ?? Promise.resolve();
    const settled = previous
      .then(() => this.apply(sessionId))
      .catch((error: unknown) => {
        this.host.log("终端窗口尺寸没能改", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    this.queue.set(sessionId, settled);
    return settled;
  }

  private async apply(sessionId: string): Promise<void> {
    const window = this.host.window(sessionId);
    if (window === undefined) return;
    const next = windowSizeOf(
      this.list(sessionId),
      this.host.lease(sessionId),
      window.size,
      this.driving.get(sessionId),
    );
    if (
      next === undefined ||
      (next.cols === window.size.cols && next.rows === window.size.rows)
    ) {
      return;
    }
    await window.apply(next);
  }
}
