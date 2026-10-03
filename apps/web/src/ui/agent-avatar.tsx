import * as React from "react";

import { agentColorVar, agentLabel } from "@/agent/launch";
import { cn } from "@/lib/cn";
import { Avatar, AvatarFallback } from "@/ui/avatar";

/** 设计系统 §3.2：头像只有 20 / 24 / 32 三档。 */
export type AgentAvatarSize = 20 | 24 | 32;

export interface AgentAvatarProps
  extends Omit<React.ComponentProps<typeof Avatar>, "size" | "children"> {
  /** 内置 id（`claude`…）或 `custom:*`。 */
  agentId: string;
  size?: AgentAvatarSize;
}

/**
 * Agent 头像（设计系统 §3.3 薄封装）：实底标识色 + 首字母，字用 `--on-agent`。
 * 只做取色与尺寸预设；没有各家 logo，不引第三方商标图（§2.12）。
 * 自定义 Agent 借用它基于的内置 Agent 的标识色（`agentColorVar`）。
 */
export function AgentAvatar({
  agentId,
  size = 24,
  className,
  ...props
}: AgentAvatarProps) {
  const label = agentLabel(agentId);
  const initial = Array.from(label.trim())[0]?.toUpperCase() ?? "?";
  return (
    <Avatar
      role="img"
      data-agent={agentId}
      data-avatar-size={size}
      size={size === 32 ? "default" : "sm"}
      title={label}
      aria-label={label}
      className={cn(size === 20 && "size-5", className)}
      {...props}
    >
      <AvatarFallback
        aria-hidden
        className="text-[length:var(--text-caption)] font-semibold"
        style={{
          backgroundColor: agentColorVar(agentId),
          color: "var(--on-agent)",
        }}
      >
        {initial}
      </AvatarFallback>
    </Avatar>
  );
}
