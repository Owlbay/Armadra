/**
 * 终端程序自报状态的前端镜像（契约 §53：OSC 7501 / OSC 9;4）。
 *
 * 与 `status-store.ts` 分开放：那张表里的每一条都是 Hook / 扩展 / ACP 的
 * 上报，好几处闸门（启动等待、投递）把「有一条」当作「报过了」。程序自报
 * 谁都能伪造——`cat` 一个文件就够——所以它只进这张表，只用来画节点头、
 * 小地图描边与离屏提醒，不进任何判据。
 *
 * 合并规则（{@link headerStateFor}）：节点有一条**本进程内**的上报状态时，
 * 上报说了算，程序自报只补进度；没有上报（普通终端、没装适配器的 CLI、
 * core 重启后读回来的旧行）时，程序自报画节点头。
 */
import { create } from "zustand";
import type {
  AgentStatus,
  ProgramStatus,
  SessionSummary,
  WorkspaceEvent,
} from "@armadra/shared";

import {
  agentHeaderState,
  type AgentHeaderState,
  type AgentStateLabelKey,
} from "./status-store";
import { scoped } from "../sources/scope";

export interface ProgramStatusState {
  /** 键是 `${sourceId}:${nodeId}`，与 `status-store.ts` 同一套。 */
  programs: Record<string, ProgramStatus>;
  /** `done` 被看过的节点：规范把「什么时候收起 done」留给终端。 */
  seen: Record<string, true>;
  handleEvent: (event: WorkspaceEvent) => void;
  hydrate: (sessions: SessionSummary[], sourceId?: string) => void;
  /** 用户看过这个节点了：收起 `done` / `error` 的光晕。 */
  markSeen: (nodeId: string) => void;
  reset: () => void;
}

function millis(timestamp: string): number {
  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? 0 : value;
}

export const useProgramStatusStore = create<ProgramStatusState>((set, get) => ({
  programs: {},
  seen: {},

  handleEvent: (event) => {
    if (event.type === "terminal.exit") {
      if (!event.nodeId) return;
      const key = scoped(event.nodeId);
      if (!get().programs[key]) return;
      set((current) => {
        const programs = { ...current.programs };
        delete programs[key];
        return { programs };
      });
      return;
    }
    if (event.type !== "terminal.program" || !event.nodeId) return;
    const key = scoped(event.nodeId);
    const status = event.status;
    set((current) => {
      const programs = { ...current.programs };
      const seen = { ...current.seen };
      if (status) programs[key] = status;
      else delete programs[key];
      // 新的一条状态：上一条「看过了」不再适用。
      delete seen[key];
      return { programs, seen };
    });
  },

  hydrate: (sessions, sourceId) =>
    set((current) => {
      const programs = { ...current.programs };
      let changed = false;
      for (const session of sessions) {
        const key = scoped(session.nodeId, sourceId);
        const incoming = session.alive ? session.programStatus : undefined;
        const previous = programs[key];
        if (!incoming) {
          if (previous) {
            delete programs[key];
            changed = true;
          }
          continue;
        }
        if (
          previous &&
          millis(previous.updatedAt) >= millis(incoming.updatedAt)
        )
          continue;
        programs[key] = incoming;
        changed = true;
      }
      return changed ? { programs } : current;
    }),

  markSeen: (nodeId) => {
    const key = scoped(nodeId);
    const program = get().programs[key];
    if (!program || get().seen[key]) return;
    if (program.state !== "done" && program.state !== "error") return;
    set((current) => ({ seen: { ...current.seen, [key]: true } }));
  },

  reset: () => set({ programs: {}, seen: {} }),
}));

export function useProgramStatus(
  nodeId: string,
  sourceId?: string,
): ProgramStatus | undefined {
  return useProgramStatusStore(
    (state) => state.programs[scoped(nodeId, sourceId)],
  );
}

export function useProgramSeen(nodeId: string, sourceId?: string): boolean {
  return useProgramStatusStore((state) =>
    Boolean(state.seen[scoped(nodeId, sourceId)]),
  );
}

/* -------------------------------- 显示映射 -------------------------------- */

/** 节点头里多出来的一项：进度百分比，随「运行中」胶囊一起出现。 */
export interface MergedHeaderState extends AgentHeaderState {
  progress?: number;
  /** 节点头这一刻说的话是谁说的：上报，还是程序自报。 */
  source?: "reported" | "program";
}

/** 上报的状态在这个 core 进程里是活的：它说了算。 */
export function reportedLive(status: AgentStatus | undefined): boolean {
  return Boolean(
    status?.state &&
      !status.restored &&
      (status.stateSource === "hook" ||
        status.stateSource === "extension" ||
        status.stateSource === "acp"),
  );
}

/**
 * 程序自报 → 胶囊 + 光晕。`idle` 什么都不画，与上报的「已读的 done」同理：
 * 静止是常态。`done` / `error` 被看过之后只留胶囊。
 */
export function programHeaderState(
  program: ProgramStatus | undefined,
  seen = false,
): MergedHeaderState {
  if (!program) return {};
  const withProgress =
    program.progress === undefined ? {} : { progress: program.progress };
  const pill = (
    tone: NonNullable<AgentHeaderState["pill"]>["tone"],
    labelKey: AgentStateLabelKey,
  ) => ({ tone, labelKey });
  switch (program.state) {
    case "working":
      return {
        pill: pill("working", "agent.state.working"),
        glow: "working",
        source: "program",
        ...withProgress,
      };
    case "blocked":
      return {
        pill: pill(
          "attention",
          program.kind === "question"
            ? "agent.state.waiting"
            : "agent.state.blocked",
        ),
        glow: "attention",
        source: "program",
        ...withProgress,
      };
    case "done":
      return seen
        ? {}
        : {
            pill: pill("unread", "agent.state.done"),
            glow: "unread",
            source: "program",
          };
    case "error":
      return {
        pill: pill("failed", "agent.program.error"),
        ...(seen ? {} : { glow: "unread" as const }),
        source: "program",
      };
    default:
      return {};
  }
}

/**
 * 节点头最终画什么。`agent` 为假时（普通终端）上报不参与；Agent 节点有活的
 * 上报时用上报，程序自报只在两边都说「在跑」时补一个进度。
 */
export function headerStateFor(
  agent: boolean,
  status: AgentStatus | undefined,
  program: ProgramStatus | undefined,
  seen = false,
): MergedHeaderState {
  if (agent && reportedLive(status)) {
    const reported: MergedHeaderState = {
      ...agentHeaderState(status),
      source: "reported",
    };
    if (
      status?.state === "working" &&
      program?.state === "working" &&
      program.progress !== undefined
    ) {
      reported.progress = program.progress;
    }
    return reported;
  }
  const fromProgram = programHeaderState(program, seen);
  if (fromProgram.pill) return fromProgram;
  return agent ? { ...agentHeaderState(status), source: "reported" } : {};
}
