import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentStatus,
  ProgramStatus,
  SessionSummary,
} from "@armadra/shared";

import {
  headerStateFor,
  programHeaderState,
  reportedLive,
  useProgramStatusStore,
} from "./program-status-store";
import { programNotificationStatus } from "../app/notifications";
import { scoped } from "../sources/scope";

const NODE = "019ff7d1-0d12-7421-833d-2c5e8d64ed31";
const WORKSPACE = "019ff7d1-0d12-7421-833d-2c5e8d64ed32";

function program(
  state: ProgramStatus["state"],
  extra: Partial<ProgramStatus> = {},
): ProgramStatus {
  return {
    state,
    source: "osc7501",
    updatedAt: "2026-10-09T10:00:00.000Z",
    ...extra,
  };
}

function reported(partial: Partial<AgentStatus> = {}): AgentStatus {
  return {
    nodeId: NODE,
    workspaceId: WORKSPACE,
    agentId: "claude",
    state: "working",
    stateSource: "hook",
    unread: false,
    verified: true,
    restored: false,
    updatedAt: "2026-10-09T10:00:00.000Z",
    ...partial,
  };
}

afterEach(() => {
  useProgramStatusStore.getState().reset();
});

describe("程序自报的镜像（契约 §53）", () => {
  it("follows terminal.program frames and drops the entry on exit", () => {
    const store = useProgramStatusStore.getState();
    store.handleEvent({
      type: "terminal.program",
      sessionId: "s",
      nodeId: NODE,
      status: program("working", { progress: 40 }),
    });
    expect(useProgramStatusStore.getState().programs[scoped(NODE)]).toEqual(
      program("working", { progress: 40 }),
    );
    store.handleEvent({
      type: "terminal.program",
      sessionId: "s",
      nodeId: NODE,
    });
    expect(
      useProgramStatusStore.getState().programs[scoped(NODE)],
    ).toBeUndefined();

    store.handleEvent({
      type: "terminal.program",
      sessionId: "s",
      nodeId: NODE,
      status: program("blocked"),
    });
    store.handleEvent({ type: "terminal.exit", sessionId: "s", nodeId: NODE });
    expect(
      useProgramStatusStore.getState().programs[scoped(NODE)],
    ).toBeUndefined();
  });

  it("hydrates from the session list, and only for live sessions", () => {
    const row = (alive: boolean, status?: ProgramStatus): SessionSummary => ({
      nodeId: NODE,
      boardId: "b",
      sessionId: "s",
      kind: "terminal",
      title: "T",
      cwd: "/tmp",
      unread: false,
      updatedAt: "2026-10-09T10:00:00.000Z",
      alive,
      ...(status ? { programStatus: status } : {}),
    });
    const store = useProgramStatusStore.getState();
    store.hydrate([row(true, program("working"))]);
    expect(useProgramStatusStore.getState().programs[scoped(NODE)]?.state).toBe(
      "working",
    );
    store.hydrate([row(false, program("working"))]);
    expect(
      useProgramStatusStore.getState().programs[scoped(NODE)],
    ).toBeUndefined();
  });

  it("hides the done glow once the node has been seen, until the next report", () => {
    const store = useProgramStatusStore.getState();
    store.handleEvent({
      type: "terminal.program",
      sessionId: "s",
      nodeId: NODE,
      status: program("done"),
    });
    store.markSeen(NODE);
    expect(useProgramStatusStore.getState().seen[scoped(NODE)]).toBe(true);
    store.handleEvent({
      type: "terminal.program",
      sessionId: "s",
      nodeId: NODE,
      status: program("done", { updatedAt: "2026-10-09T10:00:05.000Z" }),
    });
    expect(useProgramStatusStore.getState().seen[scoped(NODE)]).toBeUndefined();
  });
});

describe("节点头的合并规则", () => {
  it("maps each program state to a pill and a glow", () => {
    expect(programHeaderState(program("working", { progress: 7 }))).toEqual({
      pill: { tone: "working", labelKey: "agent.state.working" },
      glow: "working",
      source: "program",
      progress: 7,
    });
    expect(
      programHeaderState(program("blocked", { kind: "question" })),
    ).toMatchObject({
      pill: { tone: "attention", labelKey: "agent.state.waiting" },
      glow: "attention",
    });
    expect(
      programHeaderState(program("blocked", { kind: "permission" })),
    ).toMatchObject({ pill: { labelKey: "agent.state.blocked" } });
    expect(programHeaderState(program("done"))).toMatchObject({
      glow: "unread",
    });
    expect(programHeaderState(program("done"), true)).toEqual({});
    expect(programHeaderState(program("error"))).toMatchObject({
      pill: { tone: "failed", labelKey: "agent.program.error" },
      glow: "unread",
    });
    expect(programHeaderState(program("idle"))).toEqual({});
  });

  it("lets a live report win and only borrows the program's progress", () => {
    expect(
      headerStateFor(
        true,
        reported({ state: "working" }),
        program("working", { progress: 60 }),
      ),
    ).toMatchObject({ glow: "working", source: "reported", progress: 60 });
    // 上报说在等人，程序说在跑：上报为准，不带进度。
    const blocked = headerStateFor(
      true,
      reported({ state: "blocked" }),
      program("working", { progress: 60 }),
    );
    expect(blocked).toMatchObject({ glow: "attention", source: "reported" });
    expect(blocked.progress).toBeUndefined();
  });

  it("uses the program's report when nothing live has reported", () => {
    expect(headerStateFor(true, undefined, program("blocked"))).toMatchObject({
      glow: "attention",
      source: "program",
    });
    // 重启后读回来的旧行不算活的上报。
    expect(
      headerStateFor(
        true,
        reported({ state: "done", restored: true }),
        program("working"),
      ),
    ).toMatchObject({ glow: "working", source: "program" });
    // 普通终端只看程序自报。
    expect(headerStateFor(false, undefined, program("working"))).toMatchObject({
      source: "program",
    });
    expect(headerStateFor(false, undefined, undefined)).toEqual({});
  });

  it("does not count an observed guess as a live report", () => {
    expect(reportedLive(reported({ stateSource: "observed" }))).toBe(false);
    expect(reportedLive(reported({ stateSource: "extension" }))).toBe(true);
  });
});

describe("程序自报的离屏提醒", () => {
  it("projects blocked as needs-you and done / error as finished", () => {
    expect(programNotificationStatus(NODE, program("blocked")).state).toBe(
      "blocked",
    );
    expect(
      programNotificationStatus(NODE, program("blocked", { kind: "question" }))
        .state,
    ).toBe("waiting");
    expect(programNotificationStatus(NODE, program("error"))).toMatchObject({
      state: "done",
      unread: true,
      restored: false,
    });
    expect(programNotificationStatus(NODE, undefined).state).toBeUndefined();
  });
});
