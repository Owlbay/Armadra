import * as React from "react";

import { useT } from "@/app/preferences-store";
import {
  WizardBody,
  initialWizardState,
  type WizardState,
} from "@/acp/NewAgentWizard";
import { TASK_TEMPLATES, templatePrompt } from "@/acp/templates";
import {
  WIZARD_AGENTS,
  WIZARD_FOLDERS,
  WIZARD_NO_AGENTS,
  WIZARD_ROOT,
} from "../fixtures/wizard";

/**
 * `wizard` 分区（设计展示页 §2.1，设计系统 §5.3）：新建 Agent 向导的三步
 * 各一张（第三步选中一个模板）与没有可用 Agent 的空态。用的是向导的真内容
 * 组件，外面画一个对话框大小的框，不弹真的对话框。
 */

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex w-full max-w-[560px] flex-col gap-4 rounded-[var(--r-dialog)] bg-popover p-5 text-[length:var(--text-body)] text-popover-foreground shadow-[var(--shadow-dialog)] ring-1 ring-[var(--border)]">
      <h3 className="text-base leading-none font-medium">{title}</h3>
      {children}
    </div>
  );
}

function Step({
  initial,
  agents = WIZARD_AGENTS,
}: {
  initial: Partial<WizardState>;
  agents?: typeof WIZARD_AGENTS;
}) {
  const t = useT();
  const [state, setState] = React.useState<WizardState>(() => ({
    ...initialWizardState(agents, WIZARD_ROOT),
    ...initial,
  }));
  return (
    <Card title={t("wizard.title")}>
      <WizardBody
        state={state}
        onChange={(patch) => setState((current) => ({ ...current, ...patch }))}
        agents={agents}
        folders={WIZARD_FOLDERS}
        rootPath={WIZARD_ROOT}
        onCancel={() => undefined}
        onCreate={() => undefined}
        onOpenSettings={() => undefined}
      />
    </Card>
  );
}

export default function WizardSection() {
  const t = useT();
  const template = TASK_TEMPLATES.find((item) => item.id === "tests");
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Step initial={{ step: 0 }} />
      <Step
        initial={{
          step: 1,
          folder: WIZARD_FOLDERS[1] ?? WIZARD_ROOT,
          templateId: template?.id ?? null,
          task: template ? templatePrompt(template, t) : "",
        }}
      />
      <Step initial={{ step: 0 }} agents={WIZARD_NO_AGENTS} />
    </div>
  );
}
