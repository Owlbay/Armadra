import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSettings, CustomAgent } from "../agent/registry";
import { availabilityOf } from "./availability";
import { HISTORY_ADAPTERS } from "./registry";

/**
 * `/api/agents` 行上的 `history`（契约 §12.2）。
 *
 * 每个用例都给一个临时 HOME 和显式的覆盖变量：不然读到的是跑测试那台机器自己
 * 的 `~/.claude`，结果随人而变。
 */

let home: string;

function env(): NodeJS.ProcessEnv {
  return {
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    CODEX_HOME: join(home, "codex"),
    COPILOT_HOME: join(home, "copilot"),
    XDG_CONFIG_HOME: join(home, "xdg"),
    XDG_DATA_HOME: join(home, "xdg-data"),
    PI_CODING_AGENT_DIR: join(home, "pi"),
  };
}

const settings = (custom: CustomAgent[] = []): AgentSettings => ({
  customAgents: () => custom,
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "armadra-history-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("availabilityOf", () => {
  it("根目录在时三项都是 available", () => {
    mkdirSync(join(home, "claude", "projects"), { recursive: true });
    expect(availabilityOf("claude", settings(), env())).toEqual({
      index: "available",
      cost: "available",
      transcript: "available",
    });
  });

  it("根目录一个都不在时是 not-found", () => {
    expect(availabilityOf("claude", settings(), env())).toEqual({
      index: "not-found",
      cost: "not-found",
      transcript: "not-found",
    });
  });

  it("没有适配器的条目三项都是 unsupported", () => {
    const orphan: CustomAgent = {
      id: "custom:orphan",
      label: "Orphan",
      baseAgent: "nothing-like-this",
      launchCmd: "/nope/orphan",
    };
    expect(availabilityOf(orphan.id, settings([orphan]), env())).toEqual({
      index: "unsupported",
      cost: "unsupported",
      transcript: "unsupported",
    });
  });

  it("自定义条目关掉 contextLink 时转录是 disabled，其余按 base 判", () => {
    mkdirSync(join(home, "claude", "projects"), { recursive: true });
    const mine: CustomAgent = {
      id: "custom:mine",
      label: "My Claude",
      baseAgent: "claude",
      launchCmd: "/nope/claude-wrapper",
      disabledCapabilities: ["contextLink"],
    };
    expect(availabilityOf(mine.id, settings([mine]), env())).toEqual({
      index: "available",
      cost: "available",
      transcript: "disabled",
    });
  });

  it("跟着注册表走：每个适配器都有答案，没有成本来源的成本是 unsupported", () => {
    for (const adapter of HISTORY_ADAPTERS) {
      const answer = availabilityOf(adapter.agentId, settings(), env());
      expect(answer.index).not.toBe("unsupported");
      if (adapter.cost === undefined) expect(answer.cost).toBe("unsupported");
    }
  });
});
