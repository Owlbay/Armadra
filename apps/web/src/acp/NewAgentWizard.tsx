import * as React from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import {
  supportedPermissionModes,
  type AgentInfo,
  type PermissionMode,
} from "@armadra/shared";

import { usePreferencesStore, useT } from "@/app/preferences-store";
import { useAgentsQuery } from "@/app/use-agents";
import { revealCreatedNode } from "@/canvas/created-node";
import { nodeDropPosition } from "@/canvas/placement";
import { useCompactLayout } from "@/platform/layout";
import { useCanvasStore } from "@/store/canvas-store";
import { AgentAvatar } from "@/ui/agent-avatar";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@/ui/empty";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { Label } from "@/ui/label";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/ui/sheet";
import { Textarea } from "@/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { acpApi } from "./api";
import {
  TASK_TEMPLATES,
  templateById,
  templateLabel,
  templatePrompt,
} from "./templates";
import { closeNewAgentWizard, useWizardOpen } from "./wizard-open";

/**
 * 新建 Agent 向导（ACP 设计 §8 第 1 条，设计系统 §5.3）。
 *
 * 三步：选 Agent（只有 CLI 与 ACP 入口都装了的能选，其余灰掉并给安装命令）
 * → 选目录（工作区根 / 画布上用过的目录）→ 选任务（模板 chip 预填，或自己
 * 写一句）。「创建」先经 `POST /api/acp/sessions` 起会话并把任务当第一条
 * prompt 带上，再建节点并写好 `sessionId`——会话视图挂上来时直接接这一行，
 * 不会再起第二个，第一条 prompt 也不依赖哪个窗口挂没挂上来。
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

/** 目录候选：工作区根 + 画布上终端用过的目录，最多 5 个，去重。 */
export function folderChoices(
  rootPath: string,
  cwds: readonly (string | undefined)[],
): string[] {
  const seen = new Set<string>([rootPath]);
  const result = [rootPath];
  for (const cwd of cwds) {
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    result.push(cwd);
    if (result.length >= 6) break;
  }
  return result;
}

export type WizardStep = 0 | 1 | 2;

export interface WizardState {
  step: WizardStep;
  agentId: string | null;
  folder: string;
  templateId: string | null;
  task: string;
  busy: boolean;
  failed: boolean;
}

export function initialWizardState(
  agents: readonly AgentInfo[],
  rootPath: string,
): WizardState {
  const first = wizardAgents(agents).find(agentReady);
  return {
    step: 0,
    agentId: first?.id ?? null,
    folder: rootPath,
    templateId: null,
    task: "",
    busy: false,
    failed: false,
  };
}

const STEP_TITLES = [
  "wizard.step.agent",
  "wizard.step.folder",
  "wizard.step.task",
] as const;

function StepDots({ step }: { step: WizardStep }) {
  return (
    <span className="flex items-center gap-1.5" aria-hidden>
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-1.5 rounded-full"
          style={{
            background: index === step ? "var(--brand)" : "var(--faint)",
          }}
        />
      ))}
    </span>
  );
}

/**
 * 向导的内容（三步之一 + 底栏）。不带 Dialog：展示页把三步并排画出来，
 * 对话框与手机上的底部 Sheet 也各自包它一层。
 */
export function WizardBody({
  state,
  onChange,
  agents,
  folders,
  rootPath,
  onCancel,
  onCreate,
  onOpenSettings,
}: {
  state: WizardState;
  onChange: (patch: Partial<WizardState>) => void;
  agents: readonly AgentInfo[];
  folders: readonly string[];
  rootPath: string;
  onCancel: () => void;
  onCreate: () => void;
  onOpenSettings: () => void;
}) {
  const t = useT();
  const listed = wizardAgents(agents);
  const ready = listed.filter(agentReady);
  const selected = ready.find((agent) => agent.id === state.agentId) ?? null;

  if (state.step === 0 && ready.length === 0) {
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

  let body: React.ReactNode;
  if (state.step === 0) {
    body = (
      <RadioGroup
        value={state.agentId ?? ""}
        onValueChange={(value) => onChange({ agentId: value })}
        aria-label={t("wizard.step.agent")}
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
    );
  } else if (state.step === 1) {
    body = (
      <Field>
        <FieldLabel>{t("wizard.folder.label")}</FieldLabel>
        <Select
          value={state.folder}
          onValueChange={(value) => onChange({ folder: value })}
        >
          <SelectTrigger
            aria-label={t("wizard.folder.label")}
            className="w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {folders.map((folder) => (
              <SelectItem key={folder} value={folder}>
                {folder === rootPath ? t("wizard.folder.root") : folder}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    );
  } else {
    body = (
      <div className="flex flex-col gap-3">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={1}
          className="flex-wrap"
          aria-label={t("wizard.templates")}
          value={state.templateId ?? ""}
          onValueChange={(value) => {
            const template = templateById(value);
            onChange({
              templateId: template ? template.id : null,
              ...(template ? { task: templatePrompt(template, t) } : {}),
            });
          }}
        >
          {TASK_TEMPLATES.map((template) => (
            <ToggleGroupItem key={template.id} value={template.id}>
              {templateLabel(template, t)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Field data-invalid={state.failed || undefined}>
          <FieldLabel htmlFor="wizard-task">
            {t("wizard.task.label")}
          </FieldLabel>
          <Textarea
            id="wizard-task"
            rows={4}
            placeholder={t("wizard.task.placeholder")}
            value={state.task}
            aria-invalid={state.failed || undefined}
            onChange={(event) =>
              onChange({ task: event.target.value, failed: false })
            }
          />
          {state.failed && <FieldError>{t("wizard.failed")}</FieldError>}
        </Field>
      </div>
    );
  }

  const last = state.step === 2;
  return (
    <div
      className="flex flex-col gap-4"
      data-slot="wizard-body"
      data-step={state.step}
    >
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <StepDots step={state.step} />
        <span>{t(STEP_TITLES[state.step])}</span>
      </div>
      {body}
      <WizardFooter>
        <Button
          variant="outline"
          onClick={() =>
            state.step === 0
              ? onCancel()
              : onChange({ step: (state.step - 1) as WizardStep })
          }
        >
          {t(state.step === 0 ? "wizard.cancel" : "wizard.back")}
        </Button>
        <Button
          disabled={!selected || state.busy}
          onClick={() =>
            last
              ? onCreate()
              : onChange({ step: (state.step + 1) as WizardStep })
          }
        >
          {t(last ? "wizard.create" : "wizard.next")}
        </Button>
      </WizardFooter>
    </div>
  );
}

function WizardFooter({ children }: { children: React.ReactNode }) {
  return <div className="flex justify-end gap-2">{children}</div>;
}

/** 模板建议的权限模式；这家不支持就退回用户的缺省，再不行就不写。 */
function permissionFor(
  agent: AgentInfo,
  templateId: string | null,
): PermissionMode | undefined {
  const supported = supportedPermissionModes(agent.baseAgent ?? agent.id);
  const suggested = templateId
    ? templateById(templateId)?.permissionMode
    : undefined;
  const fallback = usePreferencesStore.getState().defaultPermissionMode;
  const mode = [suggested, fallback].find(
    (candidate): candidate is PermissionMode =>
      Boolean(candidate) && supported.includes(candidate as PermissionMode),
  );
  return mode && mode !== "default" ? mode : undefined;
}

/**
 * 「创建」：先起会话（带第一条 prompt），成功后再建节点。失败停在第三步。
 * 返回新节点 id；失败返回 null。
 */
export async function createAgentFromWizard(
  state: WizardState,
  agent: AgentInfo,
  at: { x: number; y: number } | null,
): Promise<string | null> {
  const store = useCanvasStore.getState();
  const workspace = store.workspace;
  if (!workspace || !store.document) return null;
  const nodeId = crypto.randomUUID();
  const permissionMode = permissionFor(agent, state.templateId);
  const prompt = state.task.trim();
  const session = await acpApi.createSession({
    workspaceId: workspace.id,
    nodeId,
    cwd: state.folder,
    agentId: agent.id,
    ...(permissionMode ? { permissionMode } : {}),
    ...(prompt ? { prompt } : {}),
  });
  const id = useCanvasStore.getState().addNode("terminal", {
    id: nodeId,
    title: agent.label,
    position: nodeDropPosition("terminal", at ? { anchor: at } : {}),
    data: {
      kind: "terminal",
      sessionId: session.id,
      ...(state.folder !== workspace.rootPath ? { cwd: state.folder } : {}),
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
  const rootPath = useCanvasStore((state) => state.workspace?.rootPath ?? "");
  const nodes = useCanvasStore((state) => state.document?.nodes);
  const folders = React.useMemo(
    () =>
      folderChoices(
        rootPath,
        (nodes ?? []).map((node) =>
          node.data.kind === "terminal" ? node.data.cwd : undefined,
        ),
      ),
    [nodes, rootPath],
  );
  const [state, setState] = React.useState<WizardState>(() =>
    initialWizardState(agents, rootPath),
  );

  // 每次打开都从第一步开始；Agent 列表晚到时补上缺省选中。
  React.useEffect(() => {
    if (open) setState(initialWizardState(agents, rootPath));
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
      const id = await createAgentFromWizard(state, agent, at);
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

  const body = (
    <WizardBody
      state={state}
      onChange={change}
      agents={agents}
      folders={folders}
      rootPath={rootPath}
      onCancel={closeNewAgentWizard}
      onCreate={() => void create()}
      onOpenSettings={openSettings}
    />
  );

  const onOpenChange = (next: boolean) => {
    if (!next) closeNewAgentWizard();
  };

  if (compact) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          className="h-[100dvh] gap-4 p-4"
          aria-describedby={undefined}
        >
          <SheetHeader className="p-0">
            <SheetTitle>{t("wizard.title")}</SheetTitle>
          </SheetHeader>
          {body}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t("wizard.title")}</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}

export default NewAgentWizard;
