import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { WorkflowUpgradeResult } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { workflowErrorKey, workflowsApi } from "./api";

type Refusal = WorkflowUpgradeResult["frozen"][number];

/** 升级被拒的那一条 → 一句话的文案键与参数名。 */
export function refusalMessage(
  refusal: Refusal,
): { key: string; names: string } | null {
  if (refusal.reason === "missing_params") {
    return {
      key: "workflow.frozen.missing",
      names: refusal.missingParams.join(", "),
    };
  }
  if (refusal.reason === "param_mismatch") {
    return {
      key: "workflow.frozen.mismatch",
      names: refusal.unknownParams.join(", "),
    };
  }
  return null;
}

/**
 * 冻结在旧版本上的工作流计划（契约 §15.6）：模板改过之后计划到点会跳过。
 * 「更新到最新版本」把它改到当前版本（参数相容时；原来启用的仍启用），不相容
 * 时说出要补或不认的参数，人去编辑计划补上。
 */
export function FrozenScheduleAlert({
  templateId,
  templateVersion,
  workspaceId,
  planId,
  canManage,
}: {
  templateId: string;
  templateVersion: number;
  workspaceId: string;
  planId: string;
  canManage: boolean;
}) {
  const t = useT();
  const client = useQueryClient();
  const [refusal, setRefusal] = React.useState<Refusal | null>(null);
  const upgrade = useMutation({
    mutationFn: () =>
      workflowsApi.upgradeSchedules(templateId, workspaceId, [planId]),
    onSuccess: (result) => {
      const refused = result.frozen.find((item) => item.scheduleId === planId);
      if (refused) {
        setRefusal(refused);
        if (refusalMessage(refused) === null) {
          toast.error(t(workflowErrorKey(undefined)));
        }
        return;
      }
      setRefusal(null);
      void client.invalidateQueries({ queryKey: ["automation"] });
      toast.success(
        t("workflow.toast.upgraded", { count: result.upgraded.length }),
      );
    },
    onError: (error) => toast.error(t(workflowErrorKey(error))),
  });
  const message = refusal ? refusalMessage(refusal) : null;
  return (
    <Alert data-slot="automation-workflow-frozen" className="py-2">
      <AlertTitle className="text-[12px]">
        {t("workflow.frozen.title", { version: templateVersion })}
      </AlertTitle>
      {message ? (
        <AlertDescription className="text-[12px]">
          {t(message.key, { names: message.names })}
        </AlertDescription>
      ) : null}
      {canManage ? (
        <div className="pt-1">
          <Button
            size="sm"
            variant="outline"
            data-slot="automation-workflow-upgrade"
            disabled={upgrade.isPending}
            onClick={() => upgrade.mutate()}
          >
            {t("workflow.upgrade")}
          </Button>
        </div>
      ) : null}
    </Alert>
  );
}
