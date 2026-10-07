import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentInfo } from "@armadra/shared";

import { setCoreHost } from "@/app/core-host";
import { usePreferencesStore } from "@/app/preferences-store";
import {
  agentColor,
  agentColorVar,
  agentLabel,
  agentSessionRequest,
  agentTextColorVar,
  buildAgentLaunch,
  buildResumeLaunch,
  customAgentFor,
  launchDialect,
  setAgentRegistry,
} from "./launch";

const echo: AgentInfo = {
  id: "custom:echo",
  label: "Echo",
  // Runtime reports the base agent's brand colour, not the settings dot.
  color: "#d97757",
  launchCmd: "/bin/echo",
  promptMode: "argv",
  capabilities: ["hooks"],
  args: ["hello"],
  baseAgent: "claude",
  resolvedPath: "/bin/echo",
  installed: true,
};

beforeEach(() => {
  setAgentRegistry([]);
});

describe("自定义 Agent 的显示名与颜色", () => {
  it("在 GET /api/agents 到达之前退回 id 的可读部分", () => {
    expect(agentLabel("custom:echo")).toBe("echo");
    expect(agentColorVar("custom:echo")).toBe("var(--agent-opencode)");
  });

  it("列表到了之后用自定义名字与借用的品牌色", () => {
    setAgentRegistry([echo]);
    expect(agentLabel("custom:echo")).toBe("Echo");
    expect(agentColor("custom:echo")).toBe("#d97757");
    // 借用 claude 的变量，主题切换才跟得住。
    expect(agentColorVar("custom:echo")).toBe("var(--agent-claude)");
  });

  it("不影响内置 Agent", () => {
    setAgentRegistry([echo]);
    expect(agentLabel("claude")).toBe("Claude Code");
    expect(agentColorVar("codex")).toBe("var(--agent-codex)");
    expect(agentLabel(undefined)).toBe("");
  });

  it("文字色只给内置 Agent 用 `-text` 变量，自定义与缺省退回正文色", () => {
    setAgentRegistry([echo]);
    expect(agentTextColorVar("claude")).toBe("var(--agent-claude-text)");
    expect(agentTextColorVar("codex")).toBe("var(--agent-codex-text)");
    expect(agentTextColorVar("custom:echo")).toBe("var(--text)");
    expect(agentTextColorVar(undefined)).toBe("var(--text)");
  });
});

describe("自定义 Agent 的启动行", () => {
  it("用自定义程序与它自己的参数", () => {
    setAgentRegistry([echo]);
    expect(customAgentFor("custom:echo")).toMatchObject({
      launchCmd: "/bin/echo",
      args: ["hello"],
      baseAgent: "claude",
    });
    const launch = buildAgentLaunch({
      id: "custom:echo",
      permissionMode: "plan",
    });
    expect(launch.command).toBe("/bin/echo --permission-mode plan hello");
  });

  it("列表尚未提供自定义 Agent 时不猜测基础程序", () => {
    expect(customAgentFor("custom:echo")).toBeUndefined();
    expect(() => buildAgentLaunch({ id: "custom:echo" })).toThrow(
      /Unknown agent/,
    );
  });

  it("运行时收窄的恢复能力不会在启动时重新授予", () => {
    setAgentRegistry([echo]);
    expect(customAgentFor(echo.id)?.disabledCapabilities).toContain("resume");
  });
});

describe("启动行用探测到的绝对路径", () => {
  it("内置 Agent 有 resolvedPath 时不再敲裸命令名", () => {
    setAgentRegistry([
      {
        id: "codex",
        label: "Codex",
        color: "#000",
        launchCmd: "codex",
        promptMode: "argv",
        capabilities: [],
        args: [],
        resolvedPath: "/Users/me/.local/share/mise/installs/node/26/bin/codex",
        installed: true,
      },
    ]);
    const launch = buildAgentLaunch({ id: "codex" });
    expect(launch.command).toMatch(
      /^\/Users\/me\/\.local\/share\/mise\/installs\/node\/26\/bin\/codex/,
    );
  });

  it("没探测到时仍用注册表里的命令名", () => {
    const launch = buildAgentLaunch({ id: "codex" });
    expect(launch.command.startsWith("codex")).toBe(true);
  });
});

describe("启动行经画布启动器", () => {
  const launcher =
    "/Users/me/Library/Application Support/Armadra/integration/run/codex";
  const codex: AgentInfo = {
    id: "codex",
    label: "Codex",
    color: "#000",
    launchCmd: "codex",
    promptMode: "argv",
    capabilities: [],
    args: [],
    resolvedPath: "/opt/homebrew/bin/codex",
    installed: true,
    launcher,
  };

  afterEach(() => {
    usePreferencesStore.setState({ launchOverrides: {} });
  });

  it("启动器在前，程序作它的第一个参数，行上没有注入", () => {
    setAgentRegistry([codex]);
    expect(buildAgentLaunch({ id: "codex", model: "gpt-5" }).command).toBe(
      `'${launcher}' /opt/homebrew/bin/codex --model gpt-5`,
    );
  });

  it("恢复与带帧粘贴同样经启动器，prompt 仍在最后", () => {
    setAgentRegistry([codex]);
    expect(buildResumeLaunch("codex", "t-1").command).toBe(
      `'${launcher}' /opt/homebrew/bin/codex resume t-1`,
    );
    expect(buildAgentLaunch({ id: "codex" }, "Reply OK").command).toBe(
      `'${launcher}' /opt/homebrew/bin/codex 'Reply OK'`,
    );
  });

  it("用户的启动命令与 npm 包装背后的程序都作启动器的参数", () => {
    usePreferencesStore.setState({
      launchOverrides: { codex: "/usr/local/bin/codex" },
    });
    setAgentRegistry([codex]);
    expect(buildAgentLaunch({ id: "codex" }).command).toBe(
      `'${launcher}' /usr/local/bin/codex`,
    );
    usePreferencesStore.setState({ launchOverrides: {} });
    const exe =
      "C:\\Users\\Ada Bell\\AppData\\Roaming\\Armadra\\integration\\run\\codex.exe";
    const node = "C:\\Program Files\\nodejs\\node.exe";
    const script =
      "C:\\Users\\Ada Bell\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
    setAgentRegistry([
      {
        ...codex,
        launcher: exe,
        launchTarget: { program: node, args: [script] },
      },
    ]);
    expect(
      buildAgentLaunch({ id: "codex", model: "gpt-5" }, undefined, "powershell")
        .command,
    ).toBe(`& '${exe}' '${node}' '${script}' --model gpt-5`);
  });

  it("自定义条目的程序是它自己的启动命令", () => {
    setAgentRegistry([
      {
        ...echo,
        resolvedPath: null,
        launcher: "/data/integration/run/claude",
      },
    ]);
    expect(buildAgentLaunch({ id: "custom:echo" }).command).toBe(
      "/data/integration/run/claude /bin/echo hello",
    );
  });

  it("没有启动器时是裸行", () => {
    setAgentRegistry([{ ...codex, launcher: undefined }]);
    expect(buildAgentLaunch({ id: "codex" }).command).toBe(
      "/opt/homebrew/bin/codex",
    );
  });

  it("旧 core 的 launchWords / launchArgs 自 0.2.0 起退役，不再写上行", () => {
    // 字段按计划删除（G4-2）：即使有旧 core 答了，页面也不再拼它们。
    const legacy = {
      launchArgs: ["-c", "a b"],
      launchWords: ["-c", { prefix: "hooks.Stop=", env: "ARMADRA_CODEX_HOOK" }],
    } as object;
    setAgentRegistry([{ ...codex, launcher: undefined, ...legacy }]);
    expect(buildAgentLaunch({ id: "codex" }).command).toBe(
      "/opt/homebrew/bin/codex",
    );
  });

  it("SSH 节点不经启动器：执行主机上没有这条路径", () => {
    setAgentRegistry([codex]);
    expect(
      buildAgentLaunch({ id: "codex" }, undefined, "posix", true).command,
    ).toBe("codex");
  });
});

describe("启动行按节点终端的 shell 引用", () => {
  const codex: AgentInfo = {
    id: "codex",
    label: "Codex",
    color: "#000",
    launchCmd: "codex",
    promptMode: "argv",
    capabilities: [],
    args: [],
    resolvedPath: "C:\\Users\\Ada Bell\\AppData\\Roaming\\npm\\codex.cmd",
    installed: true,
  };

  afterEach(() => {
    setCoreHost(undefined);
  });

  it("会话记录里的 shell 优先，其次节点指定的，再次 core 的缺省", () => {
    setCoreHost({ platform: "win32", defaultShell: "cmd.exe" });
    expect(
      launchDialect({}, "C:\\Program Files\\PowerShell\\7\\pwsh.exe"),
    ).toBe("powershell");
    expect(launchDialect({ shell: "/usr/bin/fish" })).toBe("fish");
    expect(launchDialect({})).toBe("cmd");
    // SSH 节点的行由远端的登录 shell 读。
    expect(launchDialect({ ssh: { hostId: "h" } }, "cmd.exe")).toBe("posix");
    setCoreHost(undefined);
    expect(launchDialect({})).toBe("posix");
  });

  it("cmd.exe 与 PowerShell 各用自己的引号写法", () => {
    setAgentRegistry([codex]);
    expect(buildAgentLaunch({ id: "codex" }, "hi there", "cmd").command).toBe(
      '"C:\\Users\\Ada Bell\\AppData\\Roaming\\npm\\codex.cmd" "hi there"',
    );
    expect(
      buildAgentLaunch({ id: "codex" }, "hi there", "powershell").command,
    ).toBe(
      "& 'C:\\Users\\Ada Bell\\AppData\\Roaming\\npm\\codex.cmd' 'hi there'",
    );
    // 恢复行没有显式方言时按 core 的缺省 shell。
    setCoreHost({ platform: "win32", defaultShell: "cmd.exe" });
    expect(buildResumeLaunch("codex", "t-1").command).toBe(
      '"C:\\Users\\Ada Bell\\AppData\\Roaming\\npm\\codex.cmd" resume t-1',
    );
  });

  it("读出了 npm 包装背后的程序时绕过 .cmd 直接起它", () => {
    const node = "C:\\Program Files\\nodejs\\node.exe";
    const script =
      "C:\\Users\\Ada Bell\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
    setAgentRegistry([
      { ...codex, launchTarget: { program: node, args: [script] } },
    ]);
    // 批处理挡不住的 `&` 与 `"`，直接起 node 时照常引用就能原样到达。
    expect(
      buildAgentLaunch({ id: "codex" }, 'fix "a" & b', "cmd").command,
    ).toBe(`"${node}" "${script}" ^"fix \\^"a\\^" ^& b^"`);
    // 没读出来时 .cmd 就是程序：这样的提示词宁可不启动。
    setAgentRegistry([codex]);
    expect(() =>
      buildAgentLaunch({ id: "codex" }, 'fix "a" & b', "cmd"),
    ).toThrow(/batch/);
  });

  it("SSH 节点只敲程序名：本机路径与注入路径在执行主机上都不存在", () => {
    setAgentRegistry([codex]);
    expect(
      buildAgentLaunch({ id: "codex" }, undefined, "posix", true).command,
    ).toBe("codex");
  });
});

describe("建会话请求里的账号绑定（S02 预留）", () => {
  it("没有绑定就不发 accountId，不凭空替用户选一个账号", () => {
    expect(agentSessionRequest({ id: "claude" })).toEqual({ id: "claude" });
    expect(
      agentSessionRequest({ id: "claude", permissionMode: "plan" }),
    ).toEqual({ id: "claude", permissionMode: "plan" });
  });

  it("字段存在时原样透传 accountId，前端不做放行判断", () => {
    // 非 default 也照发：拒不拒绝是 Runtime 的事，前端假装拦住只会掩盖问题。
    expect(
      agentSessionRequest({
        id: "claude",
        account: { accountId: "work", providerId: "claude" },
      }),
    ).toEqual({ id: "claude", accountId: "work" });
    expect(agentSessionRequest({ id: "claude", accountId: "default" })).toEqual(
      { id: "claude", accountId: "default" },
    );
    // 新字段优先于旧的扁平 accountId。
    expect(
      agentSessionRequest({
        id: "claude",
        accountId: "old",
        account: { accountId: "new" },
      }).accountId,
    ).toBe("new");
  });

  it("凭据引用上行（契约 §20）：只是条目名，放不放行由 core 判", () => {
    const request = agentSessionRequest({
      id: "claude",
      account: {
        accountId: "default",
        providerId: "claude",
        label: "Work",
        credentialRef: "0123456789abcdef",
      },
    });
    expect(request).toEqual({
      id: "claude",
      accountId: "default",
      credentialRef: "0123456789abcdef",
    });
    // 显示名不上行：它从来不决定会话能做什么。
    expect(JSON.stringify(request)).not.toContain("Work");
    expect(
      agentSessionRequest({ id: "claude", account: { accountId: "default" } }),
    ).toEqual({ id: "claude", accountId: "default" });
  });
});
