/**
 * `wizard` 分区的假数据（设计展示页 §2.1）。纯对象，无副作用。
 */
import type { AgentInfo } from "@armadra/shared";

function agent(
  id: string,
  label: string,
  installed: boolean,
  program: string,
): AgentInfo {
  return {
    id,
    label,
    color: "",
    launchCmd: id,
    promptMode: "argv",
    args: [],
    capabilities: [],
    installed: true,
    resolvedPath: `/usr/local/bin/${id}`,
    acp: {
      support: "official",
      program,
      installed,
      resume: "load",
    },
  } as unknown as AgentInfo;
}

export const WIZARD_AGENTS: AgentInfo[] = [
  agent("claude", "Claude Code", true, "claude-agent-acp"),
  agent("codex", "Codex", true, "codex-acp"),
  agent("opencode", "OpenCode", true, "opencode"),
  agent("pi", "Pi", false, "pi-acp"),
];

export const WIZARD_NO_AGENTS: AgentInfo[] = [
  agent("claude", "Claude Code", false, "claude-agent-acp"),
];
