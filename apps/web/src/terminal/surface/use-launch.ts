import * as React from "react";

import {
  launchHold,
  migrateLegacyLaunch,
  whenDependenciesKnown,
} from "@/agent/dependency-store";
import { buildAgentLaunch, launchDialect } from "@/agent/launch";
import { armPendingLaunch } from "@/agent/pending-launch";
import { runtimeApi } from "@/api/client";
import { useCanvasStore } from "@/store/canvas-store";
import {
  LAUNCH_ATTEMPTS,
  LAUNCH_COLD_MS,
  LAUNCH_QUIET_MS,
  LAUNCH_RESULT_WAIT_MS,
  LAUNCH_RETRY_MAX_MS,
  LAUNCH_RETRY_MIN_MS,
  LAUNCH_SLOT_WAIT_MS,
} from "./constants";
import type { SurfaceRefs } from "./refs";
import type { ConnectionStatus } from "./types";

export interface LaunchSequence {
  clearLaunchTimers: () => void;
  armLaunch: () => void;
  noteOutput: () => void;
}

/**
 * 启动行时序（计划书 §5.1）：`hello` 之后武装，提示符安静下来就敲，
 * 一直没有输出则冷启动兜底。整个过程只发生一次，由 `launchPhaseRef` 保证；
 * 敲之前过启动闸门，敲之后没起来自动重敲一次（契约 §52）。
 */
export function useLaunchSequence(
  refs: SurfaceRefs,
  options: {
    nodeId: string;
    patch: (next: Partial<ConnectionStatus>) => void;
  },
): LaunchSequence {
  const { nodeId, patch } = options;

  /** 每次启动一个序号：清定时器、换会话、卸载都让在途的那一次作废。 */
  const runRef = React.useRef(0);
  const abortRef = React.useRef<AbortController | null>(null);
  const retryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const clearLaunchTimers = React.useCallback(() => {
    if (refs.launchTimerRef.current) clearTimeout(refs.launchTimerRef.current);
    if (refs.promptTimerRef.current) clearTimeout(refs.promptTimerRef.current);
    refs.launchTimerRef.current = null;
    refs.promptTimerRef.current = null;
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    runRef.current += 1;
  }, [refs]);

  /** 节点数据现读：等闸门、等依赖那一下之后它可能已经变了。 */
  const currentData = React.useCallback(() => {
    const store = useCanvasStore.getState();
    const node = store.document?.nodes.find((item) => item.id === nodeId);
    return node && node.data.kind === "terminal"
      ? node.data
      : refs.dataRef.current;
  }, [refs, nodeId]);

  /** 真正敲那一行。成功答敲出去的命令，没敲答 `undefined`。 */
  const writeLaunch = React.useCallback((): string | undefined => {
    const store = useCanvasStore.getState();
    const nodeData = currentData();
    const agent = nodeData.agent;
    if (nodeData.launchPolicy === "manual") return undefined;
    if (!agent) return undefined;
    try {
      // 启动行永远在这里重拼，节点上那个 `initialCommand` 从来不是一条指令：
      // 它是「这次连接敲了什么」的记账，和会话 id 同一类（`use-session.ts`）。
      // Agent 建节点时也不再往里写任务了——第一条任务走投递，由 core 在节点第
      // 一次报空闲之后投进来（设计 agent-delivery.md §8）。所以这里也没有第二
      // 条「提示词写进 stdin」的路：启动行只负责把 CLI 起起来。
      const launch = buildAgentLaunch(
        agent,
        undefined,
        launchDialect(nodeData, refs.shellRef.current),
        Boolean(nodeData.ssh),
      );
      refs.transportRef.current?.input(`${launch.command}\r`);
      refs.freshSessionRef.current = false;
      store.updateNodeData(
        nodeId,
        { agent: { ...agent, initialCommand: launch.command } },
        { history: "ignore" },
      );
      return launch.command;
    } catch (cause) {
      patch({
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return undefined;
    }
  }, [refs, nodeId, patch, currentData]);

  /**
   * 页面自己敲启动行（契约 §52）：先向 core 的启动闸门申请位置（同一份配置目录
   * 上的 Codex 一个一个起），敲完问这一次起没起来；没起来就退避 2–5 s 再敲一
   * 次，第二次仍失败就把节点标成「启动失败」，不再自动重敲。
   *
   * 闸门是减速带不是门禁：申请失败、超时、旧 core 没有这条路由，都照常敲。
   * SSH 节点不排：CLI 在执行主机上，配置目录也在那边。
   */
  const typeLaunch = React.useCallback(
    async (attempt = 1) => {
      const run = runRef.current;
      const nodeData = currentData();
      const agent = nodeData.agent;
      if (nodeData.launchPolicy === "manual" || !agent) return;
      const workspaceId = useCanvasStore.getState().workspace?.id;
      const gated = workspaceId !== undefined && !nodeData.ssh;
      const target = gated
        ? { workspaceId, nodeId, agentId: agent.id }
        : undefined;
      const controller = new AbortController();
      abortRef.current = controller;
      if (target) {
        const timer = setTimeout(() => controller.abort(), LAUNCH_SLOT_WAIT_MS);
        await runtimeApi
          .launchSlot(target, controller.signal)
          .catch(() => undefined)
          .finally(() => clearTimeout(timer));
        if (run !== runRef.current) {
          // 等位置的时候连接断了：让重连之后的 hello 再武装一次。
          if (refs.freshSessionRef.current)
            refs.launchPhaseRef.current = "idle";
          return;
        }
      }
      if (writeLaunch() === undefined || !target) return;
      const timer = setTimeout(() => controller.abort(), LAUNCH_RESULT_WAIT_MS);
      const result = await runtimeApi
        .launchResult({ ...target, attempt }, controller.signal)
        .catch(() => undefined)
        .finally(() => clearTimeout(timer));
      if (run !== runRef.current || result?.verdict !== "failed") return;
      if (attempt >= LAUNCH_ATTEMPTS) {
        patch({ launch: "failed" });
        return;
      }
      const backoff =
        LAUNCH_RETRY_MIN_MS +
        Math.random() * (LAUNCH_RETRY_MAX_MS - LAUNCH_RETRY_MIN_MS);
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        if (run !== runRef.current) return;
        void typeLaunch(attempt + 1);
      }, backoff);
    },
    [refs, nodeId, patch, currentData, writeLaunch],
  );

  const fireLaunch = React.useCallback(() => {
    refs.launchTimerRef.current = null;
    if (refs.launchPhaseRef.current !== "armed") return;
    const store = useCanvasStore.getState();
    const node = store.document?.nodes.find((item) => item.id === nodeId);
    const nodeData =
      node && node.data.kind === "terminal" ? node.data : refs.dataRef.current;
    const agent = nodeData.agent;
    refs.launchPhaseRef.current = "sent";
    if (nodeData.launchPolicy === "manual") return;
    if (!agent) return;
    const workspaceId = store.workspace?.id;
    const send = (command: string) => {
      refs.transportRef.current?.input(`${command}\r`);
      refs.freshSessionRef.current = false;
    };
    if (agent.pendingLaunch) {
      const pending = agent.pendingLaunch;
      // 旧数据：带依赖的 `pendingLaunch` 迁进 core 的依赖表，之后由 core 启动
      // （Agent 自动化设计 §6）。迁不进去（旧 core）才退回页面自己等。
      if (pending.after.length > 0 && workspaceId !== undefined) {
        void migrateLegacyLaunch(workspaceId, nodeId, pending).then((moved) => {
          if (!moved) armPendingLaunch(nodeId, pending, send);
        });
        return;
      }
      // 不带依赖的那种是「敲这一行」（命令面板的恢复会话）：提示符已经安静
      // 下来了，交给 `pending-launch` 敲并等回执。
      armPendingLaunch(nodeId, pending, send);
      return;
    }
    // 还在等依赖的节点由 core 启动：页面只起 shell，不敲启动行。还不知道有没
    // 有等待时先读一次再决定。
    const hold = launchHold(workspaceId, nodeId);
    if (hold === "held") return;
    if (hold === "free") {
      void typeLaunch();
      return;
    }
    void whenDependenciesKnown(workspaceId).then(() => {
      if (launchHold(workspaceId, nodeId) !== "held") void typeLaunch();
    });
  }, [refs, nodeId, typeLaunch]);

  const armLaunch = React.useCallback(() => {
    if (refs.launchPhaseRef.current !== "idle") return;
    refs.launchPhaseRef.current = "armed";
    clearLaunchTimers();
    // 新的一次启动：上一次的「启动失败」不再成立。
    if (refs.statusRef.current?.launch) patch({ launch: null });
    refs.launchTimerRef.current = setTimeout(fireLaunch, LAUNCH_COLD_MS);
  }, [refs, clearLaunchTimers, fireLaunch, patch]);

  const noteOutput = React.useCallback(() => {
    if (refs.launchPhaseRef.current !== "armed") return;
    if (refs.launchTimerRef.current) clearTimeout(refs.launchTimerRef.current);
    refs.launchTimerRef.current = setTimeout(fireLaunch, LAUNCH_QUIET_MS);
  }, [fireLaunch]);

  return { clearLaunchTimers, armLaunch, noteOutput };
}
