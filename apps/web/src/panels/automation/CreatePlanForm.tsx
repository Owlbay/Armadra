import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  workflowRunPayload,
  workflowRunPayloadSchema,
  type AutomationScheduleKind,
  type NativeRecurrence,
} from "@armadra/shared";

import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { Input } from "@/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Textarea } from "@/ui/textarea";
import { localPathRules, useCoreHost } from "@/app/core-host";
import { useT } from "@/app/preferences-store";
import { useAccess } from "@/app/use-access";
import { isAbsoluteHostPath } from "@/lib/host-path";
import { runtimeApi } from "@/api/client";
import { useCanvasStore } from "@/store/canvas-store";
import { agentTargets, frozenLaunch } from "./agent-targets";
import { validCron, validTimezone } from "./model";
import { TimezonePicker } from "./TimezonePicker";
import { translateNativeRecurrence } from "./native-recurrence";
import { allCommandSessions, automationKeys } from "./queries";
import { workflowsApi } from "@/workflow/api";
import { defaultParams, filledParams, missingParams } from "@/workflow/model";
import { workflowKeys } from "@/workflow/store";
import {
  buildLaunchSpec,
  buildPlanConfig,
  defaultWizardState,
  targetFromConfig,
  wizardStateFromConfig,
  type WizardState,
} from "./wizard";
import {
  AutomationApi,
  AutomationCommandSession,
  AutomationCommandSessionState,
  AutomationPlanConfig,
  CommandLaunchSpec,
} from "../../api/automations";

/** A command session the form asks the panel to freeze before saving the plan. */
export interface NewSessionRequest {
  sessionId: string;
  rootPath: string;
  launch: CommandLaunchSpec;
}

export interface CreatePlanRequest {
  planId: string;
  config: AutomationPlanConfig;
  /** 冻结的 stdin / prompt。原文，不是字节（R7a）。 */
  payload: string;
  session?: NewSessionRequest;
  /**
   * Zero creates. Any other value edits the plan at exactly that revision, so
   * a save that raced another device is refused instead of overwriting it.
   */
  expectedRevision: bigint;
}

/**
 * What the form should start from. Used by "turn into a platform plan" on a
 * native activity card: the card fills in the target and the origin, the person
 * still reviews and confirms, and the plan is created as a draft.
 */
export interface CreatePlanPrefill {
  targetKind: "agent" | "workflow";
  /** Agent 目标的节点；工作流目标为空串。 */
  nodeId: string;
  title: string;
  /**
   * `native` when this came from an observed CLI loop rather than the wizard;
   * `workflow` when the workflow library asked to schedule a template.
   */
  origin: "native" | "workflow";
  /** 工作流目标：模板与它的参数初值（契约 §15.6）。 */
  workflow?: { templateId: string; params: Record<string, string> };
  /**
   * The repeat rule the card observed, if it read one. Translated into the
   * schedule fields where that is possible and shown verbatim where it is
   * not — see `native-recurrence.ts`. Nothing here is created or activated.
   */
  recurrence?: NativeRecurrence;
}

/**
 * An existing plan being edited. The Host treats an edit as a new version of
 * the same plan: `config_version` advances, the activation is invalidated, and
 * the plan returns to draft — so saving is never the same as re-arming it.
 */
export interface EditPlanTarget {
  planId: string;
  config: AutomationPlanConfig;
  expectedRevision: bigint;
  configVersion: bigint;
}

export interface CreatePlanFormProps {
  client: AutomationApi;
  /** This Host's own id; a plan may only target the Host it is defined on. */
  hostId: string;
  workspaceId: string;
  busy: boolean;
  prefill?: CreatePlanPrefill | null;
  /** Set to edit an existing plan instead of creating one. */
  edit?: EditPlanTarget | null;
  onCreate: (input: CreatePlanRequest) => void;
}

const SCHEDULE_KINDS: AutomationScheduleKind[] = [
  "once",
  "interval",
  "cron",
  "loop",
];

function field(label: string, control: React.ReactNode, help?: string) {
  return (
    <label className="block min-w-0 space-y-1">
      <span className="block text-[12px] font-medium">{label}</span>
      {control}
      {help ? (
        <span className="block text-[11px] text-destructive">{help}</span>
      ) : null}
    </label>
  );
}

function randomId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, "");
  return `${prefix}-${random ?? Date.now().toString(36)}`;
}

/**
 * 创建向导（自动化设计 §4）。
 *
 * 执行位置固定为当前 Host——计划只能派发到定义它的那台 Host，所以这里不给
 * 一个会失败的下拉。命令会话要么选已有的，要么当场定义一个新的；两者都会
 * 冻结 LaunchSpec 与 generation 后再保存计划。
 */
export function CreatePlanForm({
  client,
  hostId,
  workspaceId,
  busy,
  prefill,
  edit,
  onCreate,
}: CreatePlanFormProps) {
  const t = useT();
  // 命令会话的根目录与程序在哪台机器上，就按哪台的规则判：工作区绑在执行主机
  // 上时是那台（POSIX），否则是 core 本机（Windows 上是盘符或 UNC 路径）。
  const coreHost = useCoreHost();
  const remote = useCanvasStore(
    (store) => (store.workspace?.executionHostId ?? "") !== "",
  );
  const pathRules = remote ? "posix" : localPathRules(coreHost);
  // A native card's rule is translated once, not on every render, and the
  // refusal is kept: "we could not translate this, here is what it said" is
  // the useful answer, and re-deriving it below would drop it.
  const translated = React.useMemo(
    () =>
      prefill?.recurrence
        ? translateNativeRecurrence(prefill.recurrence)
        : null,
    [prefill?.recurrence],
  );
  // The stored plan's own target. An edit re-sends it rather than re-picking
  // it: repointing a plan is a separate decision from rescheduling it.
  const frozenTarget = React.useMemo(
    () => (edit ? targetFromConfig(edit.config) : null),
    [edit],
  );
  const [state, setState] = React.useState<WizardState>(() => {
    if (edit) return wizardStateFromConfig(edit.config, "");
    const base = defaultWizardState();
    return {
      ...base,
      ...(prefill?.title ? { title: prefill.title } : {}),
      ...(translated?.ok ? translated.draft : {}),
    };
  });
  // The payload lives apart from the configuration on the Host, so an edit
  // reads it back. Until it arrives the field stays empty and the form is not
  // submittable: saving an empty payload would silently blank the prompt.
  const stored = useQuery({
    queryKey: automationKeys.payload(workspaceId, edit?.planId ?? ""),
    queryFn: () => client.planPayload(edit!.planId),
    enabled: Boolean(edit),
    retry: false,
  });
  const loadedPayload = React.useRef(false);
  React.useEffect(() => {
    if (!edit || loadedPayload.current || !stored.data) return;
    loadedPayload.current = true;
    setState((current) => ({
      ...current,
      // 载荷在线上就是原文（R7a），不再是一段要解码的字节。
      payload: stored.data,
    }));
  }, [edit, stored.data]);
  const [targetKind, setTargetKind] = React.useState<
    "command" | "agent" | "workflow"
  >(frozenTarget?.kind ?? prefill?.targetKind ?? "command");
  // 工作流目标（契约 §15.6）：模板在当前画布上起跑，参数冻结进载荷。
  const boardId = useCanvasStore((store) => store.boardId);
  const member = useAccess().member;
  const templates = useQuery({
    queryKey: workflowKeys.templates(),
    queryFn: () => workflowsApi.templates(),
    // 成员访问工作流路由一律 403（契约 §15）：不取，「运行工作流」因此不可选。
    enabled: !member,
    retry: false,
  });
  const [templateId, setTemplateId] = React.useState(
    (frozenTarget?.kind === "workflow"
      ? frozenTarget.workflowRun.templateId
      : "") ||
      (prefill?.workflow?.templateId ?? ""),
  );
  const template = templates.data?.find((item) => item.id === templateId);
  const [paramValues, setParamValues] = React.useState<Record<string, string>>(
    () => prefill?.workflow?.params ?? {},
  );
  // 编辑一个工作流计划：参数从存着的载荷里读回来。
  const loadedParams = React.useRef(false);
  React.useEffect(() => {
    if (frozenTarget?.kind !== "workflow" || loadedParams.current) return;
    if (!stored.data) return;
    loadedParams.current = true;
    try {
      const parsed = workflowRunPayloadSchema.safeParse(
        JSON.parse(stored.data),
      );
      if (parsed.success) setParamValues(parsed.data.params);
    } catch {
      // 读不出来就从空的开始；保存时按模板再校验一遍。
    }
  }, [frozenTarget, stored.data]);
  const [agentNodeId, setAgentNodeId] = React.useState(
    (frozenTarget?.kind === "agent" ? frozenTarget.nodeId : "") ||
      (prefill?.nodeId ?? ""),
  );
  const [coldStart, setColdStart] = React.useState(
    frozenTarget?.kind === "agent" ? frozenTarget.coldStart : false,
  );
  const nodes = useCanvasStore((store) => store.document?.nodes);
  const agents = React.useMemo(() => agentTargets(nodes), [nodes]);
  const agentNode = nodes?.find((node) => node.id === agentNodeId);
  const agentOption = agents.find((option) => option.nodeId === agentNodeId);
  const [mode, setMode] = React.useState<"existing" | "new">("existing");
  const [sessionId, setSessionId] = React.useState("");
  const [draft, setDraft] = React.useState({
    sessionId: randomId("session"),
    rootPath: "",
    executable: "",
    args: "",
    timeoutMs: "60000",
  });
  const [error, setError] = React.useState<{
    field: string;
    messageKey: string;
  } | null>(null);

  const sessions = useQuery({
    queryKey: automationKeys.sessions(workspaceId),
    queryFn: () => allCommandSessions(client),
    retry: false,
  });
  const ready = React.useMemo(
    () =>
      (sessions.data ?? []).filter(
        (session) => session.state === AutomationCommandSessionState.READY,
      ),
    [sessions.data],
  );
  React.useEffect(() => {
    if (!sessionId && ready[0]) setSessionId(ready[0].sessionId);
  }, [ready, sessionId]);
  const selected: AutomationCommandSession | undefined = ready.find(
    (session) => session.sessionId === sessionId,
  );

  const set = <K extends keyof WizardState>(key: K, value: WizardState[K]) =>
    setState((current) => ({ ...current, [key]: value }));
  const problem = (name: string) =>
    error?.field === name ? t(error.messageKey) : undefined;

  /**
   * An agent plan writes into a terminal the Runtime owns, so the wizard reads
   * the live generation once and records it. It is a note of what the plan was
   * defined against, not a lock: the executor re-checks the node's identity and
   * the frozen definition at the write itself, and reports what it wrote to.
   */
  async function agentTarget() {
    if (!agentOption) return null;
    let generation = 0n;
    try {
      const session = await runtimeApi.getTerminal(agentOption.sessionId);
      if (session.status === "running")
        generation = BigInt(session.generation ?? 0);
    } catch {
      // No live session is a legitimate state for a plan that cold starts.
    }
    return {
      kind: "agent" as const,
      sessionId: agentOption.sessionId,
      generation,
      nodeId: agentOption.nodeId,
      agentLaunch: frozenLaunch(agentOption, agentNode),
      coldStart,
    };
  }

  /** 工作流目标的载荷：缺参数时给出错误，返回 `null`。 */
  function workflowPayload(): string | null {
    if (!template) {
      setError({
        field: "session",
        messageKey: "automation.wizard.workflowRequired",
      });
      return null;
    }
    const values = { ...defaultParams(template.template), ...paramValues };
    if (missingParams(template.template, values).length > 0) {
      setError({
        field: "payload",
        messageKey: "automation.wizard.workflowParamsMissing",
      });
      return null;
    }
    return workflowRunPayload(filledParams(paramValues));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    // An edit re-sends the plan's own frozen target. Everything else the form
    // shows is editable; the target is displayed and left alone.
    if (edit && frozenTarget) {
      const payload =
        frozenTarget.kind === "workflow" ? workflowPayload() : state.payload;
      if (payload === null) return;
      // 工作流计划的参数按模板的当前版本填，存的也就是当前版本：冻结在旧版本
      // 上的计划经一次编辑升级（契约 §15.6）。
      const target =
        frozenTarget.kind === "workflow" && template
          ? {
              ...frozenTarget,
              workflowRun: {
                ...frozenTarget.workflowRun,
                templateVersion: template.version,
              },
            }
          : frozenTarget;
      const config = buildPlanConfig(state, target);
      if (!config.ok) {
        setError({ field: config.field, messageKey: config.messageKey });
        return;
      }
      onCreate({
        planId: edit.planId,
        config: config.config,
        payload,
        expectedRevision: edit.expectedRevision,
      });
      return;
    }
    if (targetKind === "workflow") {
      const payload = workflowPayload();
      if (payload === null || !template) return;
      if (!boardId) {
        setError({
          field: "session",
          messageKey: "automation.wizard.workflowRequired",
        });
        return;
      }
      const config = buildPlanConfig(state, {
        kind: "workflow",
        workspaceId,
        executionHostId: hostId,
        sessionId: "",
        generation: 0n,
        workflowRun: {
          templateId: template.id,
          templateVersion: template.version,
          boardId,
        },
      });
      if (!config.ok) {
        setError({ field: config.field, messageKey: config.messageKey });
        return;
      }
      onCreate({
        planId: randomId("plan"),
        config: config.config,
        payload,
        expectedRevision: 0n,
      });
      return;
    }
    if (targetKind === "agent") {
      const target = await agentTarget();
      if (!target) {
        setError({
          field: "session",
          messageKey: "automation.wizard.agentTargetRequired",
        });
        return;
      }
      const config = buildPlanConfig(state, {
        workspaceId,
        executionHostId: hostId,
        ...target,
      });
      if (!config.ok) {
        setError({ field: config.field, messageKey: config.messageKey });
        return;
      }
      onCreate({
        planId: randomId("plan"),
        config: config.config,
        payload: state.payload,
        expectedRevision: 0n,
      });
      return;
    }
    let target = {
      sessionId: selected?.sessionId ?? "",
      generation: selected?.generation ?? 0n,
    };
    let session: NewSessionRequest | undefined;
    if (mode === "new") {
      const launch = buildLaunchSpec(draft, pathRules);
      if ("messageKey" in launch) {
        setError({ field: "executable", messageKey: launch.messageKey });
        return;
      }
      if (!isAbsoluteHostPath(draft.rootPath.trim(), pathRules)) {
        setError({
          field: "rootPath",
          messageKey: "automation.wizard.invalidPath",
        });
        return;
      }
      session = {
        sessionId: draft.sessionId,
        rootPath: draft.rootPath.trim(),
        launch,
      };
      // Generation 0 tells the Host to freeze whatever the Worker reports for
      // the session it is about to create.
      target = { sessionId: draft.sessionId, generation: 0n };
    }
    const config = buildPlanConfig(state, {
      kind: "command",
      workspaceId,
      executionHostId: hostId,
      sessionId: target.sessionId,
      generation: target.generation,
    });
    if (!config.ok) {
      setError({ field: config.field, messageKey: config.messageKey });
      return;
    }
    onCreate({
      planId: randomId("plan"),
      config: config.config,
      payload: state.payload,
      expectedRevision: 0n,
      ...(session ? { session } : {}),
    });
  }

  return (
    <form className="min-w-0 space-y-4 p-3" onSubmit={submit}>
      <fieldset className="min-w-0 space-y-3" disabled={busy}>
        {field(
          t("automation.wizard.location"),
          <p className="truncate rounded-md border border-border px-3 py-2 text-[12px] text-muted-foreground select-text">
            {t("automation.wizard.currentHost")} · {hostId}
          </p>,
        )}

        {prefill?.origin === "native" ? (
          <Alert role="status">
            <AlertDescription className="text-[11px]">
              {t("automation.wizard.fromNative")}
            </AlertDescription>
          </Alert>
        ) : null}

        {/*
          原生规则：翻得动就把日程字段填好，翻不动就把原文原样摆出来，
          让人自己决定怎么写——不硬凑一个「差不多」的周期。
        */}
        {translated ? (
          <Alert
            role="status"
            data-slot="native-recurrence"
            data-translated={translated.ok ? "true" : "false"}
          >
            <AlertDescription className="min-w-0 space-y-1 text-[11px] [&_p:not(:last-child)]:mb-0">
              <p>
                {translated.ok
                  ? t("automation.wizard.recurrenceTranslated")
                  : t(`automation.wizard.recurrence.${translated.reason}`)}
              </p>
              <p className="min-w-0 break-all font-mono select-text">
                {t(`automation.wizard.dialect.${translated.source.dialect}`)} ·{" "}
                {translated.source.rule}
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        {edit ? (
          <>
            <Alert role="status" data-slot="automation-edit-notice">
              <AlertDescription className="text-[11px]">
                {t("automation.wizard.editNote")}
              </AlertDescription>
            </Alert>
            {field(
              t("automation.wizard.targetKind"),
              <p className="min-w-0 truncate rounded-md border border-border px-3 py-2 text-[12px] text-muted-foreground select-text">
                {t(`automation.wizard.targetKind.${targetKind}`)} ·{" "}
                {frozenTarget?.kind === "agent"
                  ? frozenTarget.agentLaunch.agentId
                  : frozenTarget?.kind === "workflow"
                    ? (template?.name ?? frozenTarget.workflowRun.templateId)
                    : (frozenTarget?.sessionId ?? "")}
              </p>,
            )}
            <p className="text-[11px] text-muted-foreground">
              {t("automation.wizard.editTargetFrozen")}
            </p>
          </>
        ) : (
          field(
            t("automation.wizard.targetKind"),
            <Select
              value={targetKind}
              onValueChange={(value) =>
                setTargetKind(value as "command" | "agent" | "workflow")
              }
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
                <SelectItem value="command">
                  {t("automation.wizard.targetKind.command")}
                </SelectItem>
                <SelectItem value="agent" disabled={agents.length === 0}>
                  {t("automation.wizard.targetKind.agent")}
                </SelectItem>
                <SelectItem
                  value="workflow"
                  disabled={(templates.data?.length ?? 0) === 0 || !boardId}
                >
                  {t("automation.wizard.targetKind.workflow")}
                </SelectItem>
              </SelectContent>
            </Select>,
          )
        )}

        {!edit && targetKind === "workflow"
          ? field(
              t("automation.wizard.workflowTemplate"),
              <Select
                value={templateId}
                onValueChange={(value) => {
                  setTemplateId(value);
                  const picked = templates.data?.find(
                    (item) => item.id === value,
                  );
                  if (picked && !state.title.trim()) set("title", picked.name);
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full"
                  data-slot="automation-workflow-template"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[var(--z-dialog)]">
                  {(templates.data ?? []).map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>,
              problem("session"),
            )
          : null}

        {targetKind === "workflow" && template
          ? template.template.params.map((param) => (
              <React.Fragment key={param.name}>
                {field(
                  param.label ?? param.name,
                  <Input
                    data-param={param.name}
                    value={paramValues[param.name] ?? ""}
                    placeholder={param.default ?? ""}
                    onChange={(event) =>
                      setParamValues((current) => ({
                        ...current,
                        [param.name]: event.target.value,
                      }))
                    }
                  />,
                )}
              </React.Fragment>
            ))
          : null}

        {edit || targetKind === "workflow" ? null : targetKind === "agent" ? (
          <>
            {field(
              t("automation.wizard.agentNode"),
              <Select value={agentNodeId} onValueChange={setAgentNodeId}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[var(--z-dialog)]">
                  {agents.map((option) => (
                    <SelectItem key={option.nodeId} value={option.nodeId}>
                      {option.title} · {option.agentId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>,
              problem("session"),
            )}
            <label className="flex min-w-0 items-start gap-2 text-[12px]">
              <Checkbox
                className="mt-0.5"
                checked={coldStart}
                onCheckedChange={(next) => setColdStart(next === true)}
              />
              <span className="min-w-0">
                <span className="block font-medium">
                  {t("automation.wizard.coldStart")}
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  {t("automation.wizard.coldStartNote")}
                </span>
              </span>
            </label>
            <p className="text-[11px] text-muted-foreground">
              {t("automation.wizard.agentDeliveryNote")}
            </p>
          </>
        ) : null}

        {!edit &&
          targetKind === "command" &&
          field(
            t("automation.wizard.session"),
            <Select
              value={mode}
              onValueChange={(value) => setMode(value as "existing" | "new")}
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
                <SelectItem value="existing" disabled={ready.length === 0}>
                  {t("automation.wizard.existingSession")}
                </SelectItem>
                <SelectItem value="new">
                  {t("automation.wizard.newSession")}
                </SelectItem>
              </SelectContent>
            </Select>,
            problem("session"),
          )}

        {edit || targetKind !== "command" ? null : mode === "existing" ? (
          field(
            t("automation.wizard.sessionId"),
            <Select value={sessionId} onValueChange={setSessionId}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
                {ready.map((session) => (
                  <SelectItem key={session.sessionId} value={session.sessionId}>
                    {session.sessionId} · {session.rootPath}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>,
          )
        ) : (
          <>
            {field(
              t("automation.wizard.sessionId"),
              <Input
                value={draft.sessionId}
                onChange={(event) =>
                  setDraft({ ...draft, sessionId: event.target.value })
                }
              />,
            )}
            {field(
              t("automation.wizard.rootPath"),
              <Input
                value={draft.rootPath}
                placeholder={pathRules === "windows" ? "C:\\" : "/"}
                onChange={(event) =>
                  setDraft({ ...draft, rootPath: event.target.value })
                }
              />,
              problem("rootPath"),
            )}
            {field(
              t("automation.wizard.executable"),
              <Input
                value={draft.executable}
                placeholder={
                  pathRules === "windows"
                    ? "C:\\Windows\\System32\\cmd.exe"
                    : "/bin/echo"
                }
                onChange={(event) =>
                  setDraft({ ...draft, executable: event.target.value })
                }
              />,
              problem("executable"),
            )}
            {field(
              t("automation.wizard.args"),
              <Textarea
                rows={3}
                value={draft.args}
                onChange={(event) =>
                  setDraft({ ...draft, args: event.target.value })
                }
              />,
            )}
            {field(
              t("automation.wizard.timeout"),
              <Input
                inputMode="numeric"
                value={draft.timeoutMs}
                onChange={(event) =>
                  setDraft({ ...draft, timeoutMs: event.target.value })
                }
              />,
            )}
          </>
        )}

        {field(
          t("automation.wizard.title"),
          <Input
            value={state.title}
            onChange={(event) => set("title", event.target.value)}
          />,
          problem("title"),
        )}

        {targetKind === "workflow"
          ? problem("payload") && (
              <p role="status" className="text-[11px] text-destructive">
                {problem("payload")}
              </p>
            )
          : field(
              targetKind === "agent"
                ? t("automation.wizard.prompt")
                : t("automation.wizard.payload"),
              <Textarea
                rows={3}
                value={state.payload}
                onChange={(event) => set("payload", event.target.value)}
              />,
              problem("payload"),
            )}

        {field(
          t("automation.wizard.scheduleKind"),
          <Select
            value={state.scheduleKind}
            onValueChange={(value) =>
              set("scheduleKind", value as AutomationScheduleKind)
            }
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {SCHEDULE_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {t(`automation.schedule.${kind}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>,
        )}

        {state.scheduleKind === "once" &&
          field(
            t("automation.wizard.at"),
            <Input
              type="datetime-local"
              value={state.at}
              onChange={(event) => set("at", event.target.value)}
            />,
            problem("at"),
          )}

        {state.scheduleKind === "interval" && (
          <>
            {field(
              t("automation.wizard.anchor"),
              <Input
                type="datetime-local"
                value={state.anchor}
                onChange={(event) => set("anchor", event.target.value)}
              />,
              problem("anchor"),
            )}
            {field(
              t("automation.wizard.interval"),
              <Input
                inputMode="numeric"
                value={state.intervalMs}
                onChange={(event) => set("intervalMs", event.target.value)}
              />,
              problem("intervalMs"),
            )}
          </>
        )}

        {state.scheduleKind === "cron" && (
          <>
            {field(
              t("automation.wizard.cron"),
              <Input
                spellCheck={false}
                autoCapitalize="none"
                value={state.cron}
                aria-invalid={!validCron(state.cron)}
                onChange={(event) => set("cron", event.target.value)}
              />,
              problem("cron") ??
                (validCron(state.cron)
                  ? undefined
                  : t("automation.wizard.invalidCron")),
            )}
            {field(
              t("automation.timezone"),
              <TimezonePicker
                value={state.timezone}
                invalid={!validTimezone(state.timezone)}
                onChange={(value) => set("timezone", value)}
              />,
              problem("timezone") ??
                (validTimezone(state.timezone)
                  ? undefined
                  : t("automation.wizard.invalidTimezone")),
            )}
          </>
        )}

        {state.scheduleKind === "loop" &&
          field(
            t("automation.wizard.loopDelay"),
            <Input
              inputMode="numeric"
              value={state.loopDelayMs}
              onChange={(event) => set("loopDelayMs", event.target.value)}
            />,
            problem("loopDelayMs"),
          )}

        {field(
          t("automation.wizard.maxRuns"),
          <Input
            inputMode="numeric"
            value={state.maxRuns}
            onChange={(event) => set("maxRuns", event.target.value)}
          />,
          problem("maxRuns"),
        )}
        {field(
          t("automation.wizard.expiresAt"),
          <Input
            type="datetime-local"
            value={state.expiresAt}
            onChange={(event) => set("expiresAt", event.target.value)}
          />,
          problem("expiresAt"),
        )}

        {field(
          t("automation.wizard.misfire"),
          <Select
            value={state.misfire}
            onValueChange={(value) =>
              set("misfire", value as WizardState["misfire"])
            }
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              <SelectItem value="skip">
                {t("automation.wizard.misfire.skip")}
              </SelectItem>
              <SelectItem value="coalesce">
                {t("automation.wizard.misfire.coalesce")}
              </SelectItem>
            </SelectContent>
          </Select>,
        )}
        {field(
          t("automation.wizard.concurrency"),
          <Select
            value={state.concurrency}
            onValueChange={(value) =>
              set("concurrency", value as WizardState["concurrency"])
            }
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              <SelectItem value="forbid">
                {t("automation.wizard.concurrency.forbid")}
              </SelectItem>
              <SelectItem value="queue">
                {t("automation.wizard.concurrency.queue")}
              </SelectItem>
            </SelectContent>
          </Select>,
        )}
        {field(
          t("automation.wizard.busyTtl"),
          <Input
            inputMode="numeric"
            value={state.busyTtlMs}
            onChange={(event) => set("busyTtlMs", event.target.value)}
          />,
          problem("busyTtlMs"),
        )}

        <p className="text-[11px] text-muted-foreground">
          {t(edit ? "automation.wizard.saved" : "automation.wizard.created")}
        </p>
        {edit && stored.isError ? (
          <Alert variant="destructive">
            <AlertTitle className="text-[12px] font-normal">
              {t("automation.wizard.payloadUnavailable")}
            </AlertTitle>
          </Alert>
        ) : null}
        <Button
          type="submit"
          size="sm"
          className="min-h-10"
          data-slot="automation-submit"
          // An edit cannot be saved before the stored payload has been read:
          // sending an empty one would blank the prompt without saying so.
          disabled={busy || (Boolean(edit) && !stored.isSuccess)}
        >
          {t(edit ? "automation.save" : "automation.create")}
        </Button>
      </fieldset>
    </form>
  );
}
