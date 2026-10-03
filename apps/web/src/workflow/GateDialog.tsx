import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useT } from "@/app/preferences-store";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Button } from "@/ui/button";
import { Field, FieldLabel } from "@/ui/field";
import { Textarea } from "@/ui/textarea";
import { workflowErrorKey, workflowsApi } from "./api";
import { type GateTarget, useWorkflowView, workflowKeys } from "./store";

/**
 * 关卡答复（契约 §15.3 `POST …/gates/{stepId}`）：标题是关卡的说明，一个可选
 * 备注，「拒绝」在左、「通过」在右。答完关掉；关卡已经被别人答过时说一句。
 */
export function GateDialog() {
  const gate = useWorkflowView((state) => state.gate);
  const openGate = useWorkflowView((state) => state.openGate);
  return <GateDialogView gate={gate} onClose={() => openGate(null)} />;
}

export function GateDialogView({
  gate,
  onClose,
}: {
  gate: GateTarget | null;
  onClose: () => void;
}) {
  const t = useT();
  const client = useQueryClient();
  const [note, setNote] = React.useState("");
  React.useEffect(() => setNote(""), [gate?.runId, gate?.stepId]);
  const answer = useMutation({
    mutationFn: (decision: "approve" | "reject") =>
      workflowsApi.answerGate(gate!.runId, gate!.stepId, {
        decision,
        ...(note.trim() === "" ? {} : { note: note.trim() }),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: workflowKeys.all });
      onClose();
    },
    onError: (error) => toast.error(t(workflowErrorKey(error))),
  });

  return (
    <ResponsiveDialog
      open={gate !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ResponsiveDialogContent
        className="sm:max-w-[420px]"
        data-slot="workflow-gate-dialog"
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{gate?.label ?? ""}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <Field>
          <FieldLabel htmlFor="workflow-gate-note">
            {t("workflow.gate.note")}
          </FieldLabel>
          <Textarea
            id="workflow-gate-note"
            rows={3}
            maxLength={2000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        <ResponsiveDialogFooter>
          <Button
            variant="outline"
            data-slot="workflow-gate-reject"
            disabled={answer.isPending}
            onClick={() => answer.mutate("reject")}
          >
            {t("workflow.gate.reject")}
          </Button>
          <Button
            data-slot="workflow-gate-approve"
            disabled={answer.isPending}
            onClick={() => answer.mutate("approve")}
          >
            {t("workflow.gate.approve")}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
