import { useState, type ReactNode } from "react";

import { useT } from "@/app/preferences-store";
import { RunPanel } from "@/workflow/RunPanel";
import { TemplateEditor } from "@/workflow/TemplateEditor";
import { TemplateLibrary } from "@/workflow/TemplateLibrary";
import { useWorkflowView } from "@/workflow/store";
import { COMPARED, EXPANDED, NOW, RUNS, TEMPLATES } from "../fixtures/workflow";

const noop = () => undefined;

function Sample({
  caption,
  children,
}: {
  caption: string;
  children: ReactNode;
}) {
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="text-[12px] text-muted-foreground">
        {caption}
      </figcaption>
      {children}
    </figure>
  );
}

/**
 * `workflow` 分区（设计展示页 §2.1，设计系统 §5.5）：真的模板库、编辑器与运行
 * 记录，喂假数据。模板库三张卡与空态；编辑器选中第二步；运行记录五行、展开
 * 一行（关卡在等人）、勾了两行对比。时钟钉住。
 */
export default function WorkflowSection() {
  const t = useT();
  // 视图状态是全局 store：渲染前摆好，第一帧就是展开的样子。
  useState(() => {
    useWorkflowView.setState({ expanded: EXPANDED, compare: COMPARED });
    return null;
  });
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Sample caption={t("workflow.tab.templates")}>
          <TemplateLibrary templates={TEMPLATES} runs={RUNS} now={NOW} />
        </Sample>
        <Sample caption={t("workflow.library.empty")}>
          <div className="rounded-xl border border-dashed border-border">
            <TemplateLibrary templates={[]} runs={[]} now={NOW} />
          </div>
        </Sample>
      </div>
      <Sample caption={t("workflow.editor.steps")}>
        <TemplateEditor
          inline
          template={TEMPLATES[0]!}
          initialStep={TEMPLATES[0]!.template.steps[1]!.id}
          onClose={noop}
        />
      </Sample>
      <Sample caption={t("workflow.tab.runs")}>
        <div className="max-w-[460px] rounded-xl border border-border p-3">
          <RunPanel runs={RUNS} templates={TEMPLATES} />
        </div>
      </Sample>
    </div>
  );
}
