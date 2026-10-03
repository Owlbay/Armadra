import { Check, UserRound } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { CredentialEntry, TerminalAgent } from "@armadra/shared";
import { toast } from "sonner";

import { useT } from "@/app/preferences-store";
import { CREDENTIALS_QUERY_KEY, credentialsApi } from "@/api/credentials";
import { customAgentFor } from "@/agent/launch";
import { useCanvasStore } from "@/store/canvas-store";
import { Badge } from "@/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";

/**
 * 节点头部的账号标记（画布设计 §4「节点头部」，补全架构 §9.1）。
 *
 * 可选可切：菜单里是「默认登录」加上设置页里属于这个节点基础 CLI 的凭据条目。
 * 选中写进节点数据的 `agent.account`（`credentialRef` 是条目名，不是值），下一次
 * 起终端时随请求上行，由 core 校验。已经在跑的终端不受影响——重启终端才换账号。
 *
 * 不占位置的情形：没有绑定、也没有可选的条目（或者没有 `nodeId`，例如在节点
 * 之外渲染）。
 */
export function AccountBindingBadge({
  agent,
  nodeId,
}: {
  agent: TerminalAgent;
  nodeId?: string;
}) {
  const t = useT();
  const credentials = useQuery({
    queryKey: CREDENTIALS_QUERY_KEY,
    queryFn: ({ signal }) => credentialsApi.list(signal),
    staleTime: 60_000,
    retry: false,
    enabled: nodeId !== undefined,
  });
  const base = customAgentFor(agent.id)?.baseAgent ?? agent.id;
  const choices: CredentialEntry[] =
    credentials.data?.available === true
      ? credentials.data.entries.filter((entry) => entry.providerId === base)
      : [];
  const account = agent.account;
  const bound = account?.credentialRef;
  if (!account && choices.length === 0) return null;

  const label = account
    ? account.label || account.accountId
    : t("credentials.badge.default");
  const badge = (
    <Badge
      variant="outline"
      className="h-[18px] px-1.5 text-[length:var(--text-caption)]"
      title={t("credentials.badge.title", { account: label })}
    >
      <UserRound className="size-2.5" />
      {account && <span className="max-w-24 truncate">{label}</span>}
    </Badge>
  );
  if (nodeId === undefined || choices.length === 0) return badge;

  const select = (entry: CredentialEntry | undefined) => {
    const { account: _previous, ...rest } = agent;
    useCanvasStore.getState().updateNodeData(nodeId, {
      agent: entry
        ? {
            ...rest,
            account: {
              accountId: "default",
              providerId: entry.providerId,
              label: entry.label,
              credentialRef: entry.ref,
            },
          }
        : rest,
    });
    toast.info(t("credentials.badge.switched"));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="nodrag rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t("credentials.badge.title", { account: label })}
      >
        {badge}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuItem onSelect={() => select(undefined)}>
          {t("credentials.badge.default")}
          {!bound && <Check className="ml-auto" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {choices.map((entry) => (
          <DropdownMenuItem
            key={entry.ref}
            disabled={!entry.isSet}
            onSelect={() => select(entry)}
          >
            <span className="truncate">{entry.label}</span>
            {bound === entry.ref && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
