import * as React from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import {
  supportedPermissionModes,
  type AgentInfo,
  type CanvasNode,
  type PermissionMode,
  type Position,
} from "@armadra/shared";

import { usePreferencesStore, useT } from "@/app/preferences-store";
import { useAgentsQuery } from "@/app/use-agents";
import { revealCreatedNode } from "@/canvas/created-node";
import {
  enclosingBoundFrame,
  frameBindingOf,
  inheritedNodeData,
} from "@/canvas/frame-binding";
import { nodeDropPosition } from "@/canvas/placement";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { useCompactLayout } from "@/platform/layout";
import { useCanvasStore } from "@/store/canvas-store";
import { AgentAvatar } from "@/ui/agent-avatar";
import { Button } from "@/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@/ui/empty";
import { FieldError } from "@/ui/field";
import { Label } from "@/ui/label";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { acpApi } from "./api";
import { closeNewAgentWizard, useWizardOpen } from "./wizard-open";

/**
 * 新建 Agent 向导（ACP 设计 §8 第 1 条，设计系统 §5.3）。
 *
 * 只有一步：选 Agent（只有 CLI 与 ACP 入口都装了的能选，其余灰掉并给安装命令），
 * 点「创建」就起会话。目录不问：画布已经知道新节点该开在哪（落点所在的绑定分组
 * 的 worktree，否则工作区根，与菜单里直接新建 Agent 同一口径，见
 * `canvasDefaultCwd`）。任务也不问：会话起来后用户直接在会话里说要做什么。
 * 「创建」先经 `POST /api/acp/sessions` 起会话，再建节点并写好 `sessionId`——
 * 会话视图挂上来时直接接这一行，不会再起第二个。
 */

/** 适配器 / CLI 的安装命令。没有公开的 npm 包时不给（不猜）。 */
export const INSTALL_COMMANDS: Readonly<Record<string, string>> = {
  claude: "npm i -g @agentclientprotocol/claude-agent-acp",
  codex: "npm i -g @agentclientprotocol/codex-acp",
  pi: "npm i -g pi-acp",
  opencode: "npm i -g opencode-ai",
  copilot: "npm i -g @github/copilot",
  ama: "npm i -g @armadra/agent",
};

/** 向导列出的 Agent：有 ACP 入口的那些（自定义 Agent 跟它的基础 CLI 走）。 */
export function wizardAgents(agents: readonly AgentInfo[]): AgentInfo[] {
  return agents.filter((agent) => agent.acp);
}

export function agentReady(agent: AgentInfo): boolean {
  return Boolean(agent.installed && agent.acp?.installed);
}

export function installCommand(agent: AgentInfo): string | null {
  return INSTALL_COMMANDS[agent.baseAgent ?? agent.id] ?? null;
}

/**
 * 画布给新终端的缺省目录：落点在绑定了 worktree 的分组里就是那个 checkout，
 * 否则工作区根。和 `addNode` 的继承同一个函数，会话 cwd 与节点 cwd 才不会分家。
 */
export function canvasDefaultCwd(
  nodes: readonly CanvasNode[],
  position: Position,
  rootPath: string,
): string {
  const inherited = inheritedNodeData(
    "terminal",
    frameBindingOf(enclosingBoundFrame(nodes, position)),
    { workspaceRoot: rootPath },
  );
  const cwd =
    inherited && "cwd" in inherited
      ? (inherited.cwd as string | undefined)
      : undefined;
  return cwd || rootPath;
}

export interface WizardState {
  agentId: string | null;
  busy: boolean;
  failed: boolean;
}

export function initialWizardState(agents: readonly AgentInfo[]): WizardState {
  const first = wizardAgents(agents).find(agentReady);
  return { agentId: first?.id ?? null, busy: false, failed: false };
}

/**
 * 向导的内容（Agent 列表 + 底栏）。不带 Dialog：展示页直接画它，对话框与
 * 手机上的底部 Sheet 也各自包它一层。
 */
export function WizardBody({
  state,
  onChange,
  agents,
  onCancel,
  onCreate,
  onOpenSettings,
}: {
  state: WizardState;
  onChange: (patch: Partial<WizardState>) => void;
  agents: readonly AgentInfo[];
  onCancel: () => void;
  onCreate: () => void;
  onOpenSettings: () => void;
}) {
  const t = useT();
  const listed = wizardAgents(agents);
  const ready = listed.filter(agentReady);
  const selected = ready.find((agent) => agent.id === state.agentId) ?? null;

  if (ready.length === 0) {
    return (
      <Empty className="border-0 p-6" data-slot="wizard-empty">
        <EmptyHeader>
          <EmptyTitle className="text-[13px] font-normal">
            {t("wizard.empty")}
          </EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" onClick={onOpenSettings}>
            {t("wizard.empty.action")}
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  const copy = (command: string) => {
    void navigator.clipboard?.writeText(command).then(
      () => toast.success(t("wizard.install.copied")),
      () => undefined,
    );
  };

  return (
    <div className="flex flex-col gap-4" data-slot="wizard-body">
      <RadioGroup
        value={state.agentId ?? ""}
        onValueChange={(value) => onChange({ agentId: value, failed: false })}
        aria-label={t("wizard.title")}
        className="gap-1.5"
      >
        {listed.map((agent) => {
          const usable = agentReady(agent);
          const command = usable ? null : installCommand(agent);
          const id = `wizard-agent-${agent.id}`;
          return (
            <div
              key={agent.id}
              data-agent-row={agent.id}
              data-disabled={usable ? undefined : "true"}
              className="flex min-h-11 items-center gap-2.5 rounded-[var(--r-card)] border border-border px-3 py-2 data-[disabled=true]:opacity-60"
            >
              <RadioGroupItem id={id} value={agent.id} disabled={!usable} />
              <AgentAvatar agentId={agent.id} size={24} />
              <Label
                htmlFor={id}
                className="min-w-0 flex-1 truncate font-normal"
              >
                {agent.label}
              </Label>
              {!usable && (
                <>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {t("wizard.install.needed")}
                  </span>
                  {command && (
                    <Button
                      variant="outline"
                      size="xs"
                      title={command}
                      onClick={() => copy(command)}
                    >
                      <Copy />
                      {t("wizard.install.copy")}
                    </Button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </RadioGroup>
      {state.failed && <FieldError>{t("wizard.failed")}</FieldError>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          {t("wizard.cancel")}
        </Button>
        <Button disabled={!selected || state.busy} onClick={onCreate}>
          {t("wizard.create")}
        </Button>
      </div>
    </div>
  );
}

/** 用户的缺省权限模式；这家不支持就不写（由 Agent 自己的缺省决定）。 */
function permissionFor(agent: AgentInfo): PermissionMode | undefined {
  const supported = supportedPermissionModes(agent.baseAgent ?? agent.id);
  const mode = usePreferencesStore.getState().defaultPermissionMode;
  return supported.includes(mode) && mode !== "default" ? mode : undefined;
}

/**
 * 「创建」：在画布给的目录里起会话（不带 prompt），成功后再建节点。失败留在
 * 对话框里并给错误行。返回新节点 id；失败返回 null。
 */
export async function createAgentFromWizard(
  agent: AgentInfo,
  position: Position,
): Promise<string | null> {
  const store = useCanvasStore.getState();
  const workspace = store.workspace;
  if (!workspace || !store.document) return null;
  const nodeId = crypto.randomUUID();
  const permissionMode = permissionFor(agent);
  const cwd = canvasDefaultCwd(
    store.document.nodes,
    position,
    workspace.rootPath,
  );
  const session = await acpApi.createSession({
    workspaceId: workspace.id,
    nodeId,
    cwd,
    agentId: agent.id,
    ...(permissionMode ? { permissionMode } : {}),
  });
  // 不写 cwd：addNode 按同一落点继承出同一个目录，会话与节点不会分家。
  const id = useCanvasStore.getState().addNode("terminal", {
    id: nodeId,
    title: agent.label,
    position,
    data: {
      kind: "terminal",
      sessionId: session.id,
      agent: {
        id: agent.id,
        driver: "acp",
        ...(permissionMode ? { permissionMode } : {}),
      },
    },
  });
  if (!id) return null;
  revealCreatedNode(id);
  return id;
}

/** 挂在画布上，跟着 `wizard-open` 开关。 */
export function NewAgentWizard() {
  const t = useT();
  const { open, at } = useWizardOpen();
  const compact = useCompactLayout();
  const agents = useAgentsQuery().data ?? [];
  /** 新节点的落点在打开时定下来：会话目录看它，节点也放在这里。 */
  const [position, setPosition] = React.useState<Position | null>(null);
  const [state, setState] = React.useState<WizardState>(() =>
    initialWizardState(agents),
  );

  // 每次打开都重来；Agent 列表晚到时补上缺省选中。
  React.useEffect(() => {
    if (open) {
      setPosition(nodeDropPosition("terminal", at ? { anchor: at } : {}));
      setState(initialWizardState(agents));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  React.useEffect(() => {
    if (!state.agentId && agents.length > 0) {
      const first = wizardAgents(agents).find(agentReady);
      if (first) setState((current) => ({ ...current, agentId: first.id }));
    }
  }, [agents, state.agentId]);

  const change = (patch: Partial<WizardState>) =>
    setState((current) => ({ ...current, ...patch }));

  const create = async () => {
    const agent = agents.find((candidate) => candidate.id === state.agentId);
    if (!agent) return;
    change({ busy: true, failed: false });
    try {
      const id = await createAgentFromWizard(
        agent,
        position ?? nodeDropPosition("terminal", at ? { anchor: at } : {}),
      );
      if (!id) throw new Error("not created");
      closeNewAgentWizard();
    } catch {
      change({ busy: false, failed: true });
    }
  };

  const openSettings = () => {
    closeNewAgentWizard();
    usePreferencesStore.getState().setLastSettingsSection("integration");
    useCanvasStore.getState().setPanel("settings", true);
  };

  const onOpenChange = (next: boolean) => {
    if (!next) closeNewAgentWizard();
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        // 手机上整高（设计系统 §5.3），桌面 560 宽。
        className={
          compact ? "h-[calc(100dvh-48px-var(--safe-top))]" : "sm:max-w-[560px]"
        }
        aria-describedby={undefined}
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{t("wizard.title")}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <WizardBody
          state={state}
          onChange={change}
          agents={agents}
          onCancel={closeNewAgentWizard}
          onCreate={() => void create()}
          onOpenSettings={openSettings}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

export default NewAgentWizard;
