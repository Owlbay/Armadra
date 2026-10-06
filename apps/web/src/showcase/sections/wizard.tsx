import * as React from "react";

import { useT } from "@/app/preferences-store";
import {
  WizardBody,
  initialWizardState,
  type WizardState,
} from "@/acp/NewAgentWizard";
import { WIZARD_AGENTS, WIZARD_NO_AGENTS } from "../fixtures/wizard";

/**
 * `wizard` 分区（设计展示页 §2.1，设计系统 §5.3）：新建 Agent 向导（选 Agent
 * 即创建）与没有可用 Agent 的空态。用的是向导的真内容组件，外面画一个对话框
 * 大小的框，不弹真的对话框。
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

function Step({ agents = WIZARD_AGENTS }: { agents?: typeof WIZARD_AGENTS }) {
  const t = useT();
  const [state, setState] = React.useState<WizardState>(() =>
    initialWizardState(agents),
  );
  return (
    <Card title={t("wizard.title")}>
      <WizardBody
        state={state}
        onChange={(patch) => setState((current) => ({ ...current, ...patch }))}
        agents={agents}
        onCancel={() => undefined}
        onCreate={() => undefined}
        onOpenSettings={() => undefined}
      />
    </Card>
  );
}

export default function WizardSection() {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Step />
      <Step agents={WIZARD_NO_AGENTS} />
    </div>
  );
}
