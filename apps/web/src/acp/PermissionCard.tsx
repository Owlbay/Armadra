import type { AcpPermissionOption } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { useAgentStatusStore } from "@/agent/status-store";
import { cn } from "@/lib/cn";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { ButtonGroup } from "@/ui/button-group";
import { Card } from "@/ui/card";
import { acpApi } from "./api";
import { useAcpStore, type AcpPermissionView } from "./store";

const OPTION_LABELS: Record<AcpPermissionOption["kind"], string> = {
  allow_once: "acp.permission.allowOnce",
  allow_always: "acp.permission.allowAlways",
  reject_once: "acp.permission.reject",
  reject_always: "acp.permission.rejectAlways",
};

export function isAllowOption(option: AcpPermissionOption): boolean {
  return option.kind.startsWith("allow");
}

/**
 * 答一次：先收起（会话视图的卡片与头部的允许 / 拒绝一起），再发请求——与
 * 头部直答同一个做法，下一条事件未必立刻到，不能让人对着答过的请求再点。
 */
export function answerPermission(
  permission: AcpPermissionView,
  option: AcpPermissionOption,
): Promise<unknown> {
  useAcpStore.getState().resolvePermission(permission.pendingId);
  useAgentStatusStore.getState().resolveApproval(permission.pendingId);
  return acpApi
    .answer(
      permission.pendingId,
      isAllowOption(option) ? "allow" : "deny",
      option.optionId,
    )
    .catch(() => undefined);
}

/**
 * `session/request_permission` 的卡片（设计系统 §5.1）：标题是工具调用，
 * 选项按 ACP 的 kind 分允许 / 拒绝两组，允许用 default、拒绝用 outline。
 * 没有答复权限的人（不是 driver、终端也不是自己起的，契约 §23）看到同一张卡，
 * 按钮换成「等待接管」（设计系统 §5.8）。
 */
export function PermissionCard({
  permission,
  canAnswer,
  className,
}: {
  permission: AcpPermissionView;
  canAnswer: boolean;
  className?: string;
}) {
  const t = useT();
  const allow = permission.options.filter(isAllowOption);
  const reject = permission.options.filter((option) => !isAllowOption(option));
  const group = (options: AcpPermissionOption[], allowGroup: boolean) =>
    options.length > 0 && (
      <ButtonGroup>
        {options.map((option) => (
          <Button
            key={option.optionId}
            size="sm"
            variant={allowGroup ? "default" : "outline"}
            onClick={() => void answerPermission(permission, option)}
          >
            {t(OPTION_LABELS[option.kind])}
          </Button>
        ))}
      </ButtonGroup>
    );

  return (
    <Card
      data-slot="acp-permission"
      data-pending-id={permission.pendingId}
      className={cn(
        "gap-2 border-l-2 border-l-[var(--warn)] px-3 py-2",
        className,
      )}
    >
      <span className="text-[13px]">{permission.toolCall.title}</span>
      {canAnswer ? (
        <div className="flex flex-wrap gap-2">
          {group(allow, true)}
          {group(reject, false)}
        </div>
      ) : (
        <Badge variant="outline" className="self-start">
          {t("acp.permission.awaitingDriver")}
        </Badge>
      )}
    </Card>
  );
}
