import type { DatabaseSync } from "node:sqlite";
import type {
  Attachment,
  BackendKind,
  SessionKey,
  TerminalBackend,
  TerminalSize,
  TerminalSpec,
} from "./backend";
import type { Lease } from "../drive/lease";
import type { TargetState } from "../agent/target-state";
import type { InputSafety } from "./input";

/**
 * The manager's public shapes, apart from the class so `manager.ts` stays
 * about behaviour. `manager.ts` re-exports every one of them.
 */

/** The row shape `/api/terminals` answers with. camelCase, contract §5.1. */
export interface TerminalSession {
  readonly id: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly shell: string;
  readonly command: string | null;
  readonly kind: string;
  readonly ownerNodeId: string | null;
  readonly agentId: string | null;
  readonly status: string;
  readonly exitCode: number | null;
  readonly pid: number | null;
  readonly createdAt: string;
  readonly endedAt: string | null;
  readonly sessionKey: string;
  readonly backend: string;
  readonly generation: number;
  readonly attachState: string;
  readonly lastOutputAt: string | null;
  /**
   * 这一行以 Eco 休眠结束（终端宿主设计 §7.2）：进程已经不在，节点上的会话可以
   * 用 CLI 自己的 resume 接回来。活着的行恒为 `null`。
   */
  readonly hibernation: "hibernated" | null;
  /** 创建者 = 触发者（契约 §23）；空串是本机 owner。读行时才带，起会话的回答里缺席。 */
  readonly creatorPrincipalId?: string;
}

/**
 * 一次投递要知道的全部（设计 `agent-delivery.md` §4 / §6）：目标在五态里的
 * 哪一个、租约在谁手里、代次是几。留给阶段 C 的 `send`。
 */
export interface DriveTarget {
  readonly nodeId: string;
  /** 这个节点当前那个终端会话；没有会话时缺席，此时 `state` 是 `exited`。 */
  readonly sessionId?: string;
  readonly state: TargetState;
  /** 状态是从哪条通道学来的；`observed` 与缺席都不满足空闲门（§4.3）。 */
  readonly stateSource?: string;
  readonly lease: Lease;
  /** `terminal_sessions.drive_generation`，乐观并发用的那个数。 */
  readonly driveGeneration: number;
}

export interface SessionRecord {
  readonly id: string;
  readonly key: SessionKey;
  readonly workspaceId: string;
  readonly ownerNodeId: string | null;
  kind: BackendKind;
  generation: number;
  pid: number | undefined;
  cols: number;
  rows: number;
  exited: boolean;
  /** Kept so `recycle` can restart the same terminal, environment included. */
  spec: TerminalSpec;
  inputRevision: number;
  inputSafety: InputSafety;
  /** When this session last had input written in, or output come back out. */
  lastActivity: number | undefined;
  /**
   * 这一代进程起来（或重启后被接管）的时刻。行上的 `created_at` 是第一代的：
   * 回收、节能唤醒都在同一行上起下一代，首投放行门要的「会话够老」得从这里算。
   */
  startedAt: number;
}

/** What one socket needs to serve a terminal. */
export interface AttachSession {
  readonly attachment: Attachment;
  readonly record: SessionRecord;
  /** The replay, for a backend that does not redraw on attach. */
  readonly snapshot: string | undefined;
  /** This viewer's size as it starts out: what the `hello` reports. */
  readonly size: TerminalSize;
}

export interface TerminalManagerOptions {
  readonly sequenceDirectory?: string;
  readonly database: DatabaseSync;
  /** Every backend this build can reach, by kind. */
  readonly backends: ReadonlyMap<BackendKind, TerminalBackend>;
  /** The one new sessions are created with (contract §15.1). */
  readonly effective: BackendKind;
  /** `terminal.detachedGraceMinutes` / `terminal.dormantAfterSeconds`. */
  readonly policy?: () => {
    detachedGraceMinutes: number;
    dormantAfterSeconds: number;
  };
  /** Injected so a test can make the timestamps deterministic. */
  readonly now?: () => string;
  readonly clock?: () => number;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
  readonly onExit?: (event: {
    workspaceId: string;
    sessionId: string;
    nodeId: string | null;
    exitCode: number | null;
  }) => void;
  /**
   * 驱动租约换手了（设计 `agent-delivery.md` §6）。抢占、接管、自然过期各一
   * 帧，节点头的徽标从这里同步。
   */
  readonly onProgramStatus?: (event: {
    workspaceId: string;
    sessionId: string;
    nodeId: string | null;
    /** 缺席表示这个终端不再有任何程序自报的记录（契约 §53）。 */
    status: import("./program-status-book").ProgramStatusWire | undefined;
  }) => void;
  readonly onLease?: (event: {
    workspaceId: string;
    sessionId: string;
    nodeId: string | null;
    lease: Lease;
  }) => void;
}
