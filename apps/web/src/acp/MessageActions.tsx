import * as React from "react";
import { Check, Copy } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { IconButton, type IconButtonProps } from "@/ui/icon-button";
import { copyText } from "./copy";

/**
 * 消息级的次要动作（ACP 会话视图 §5.3）：一排 `IconButton inline`，悬停或
 * 键盘聚焦到这条消息时出现，触屏（没有悬停）常显，菜单开着时不收。
 * 每个钮都有 `aria-label`，Tab 到它时自然显形。
 */
export function ActionBar({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="acp-actions"
      className={cn(
        "flex items-center gap-0.5 opacity-0 transition-opacity duration-[var(--dur-fast)] motion-reduce:transition-none",
        "group-hover/act:opacity-100 group-focus-within/act:opacity-100 has-data-[state=open]:opacity-100",
        "[@media(hover:none)]:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

/** 一个动作：图标 + 无障碍名称。 */
export function Action({
  label,
  children,
  ...props
}: Omit<IconButtonProps, "size">) {
  return (
    <IconButton
      label={label}
      size="inline"
      // 节点体里按下不该让画布开始拖节点或平移（根上已有 `nodrag nopan`，
      // 这里再挡一次，工具条也可能被挂到别处）。
      onPointerDown={(event) => event.stopPropagation()}
      {...props}
    >
      {children}
    </IconButton>
  );
}

/** 复制：点了之后一小会儿换成「已复制」的勾。 */
export function CopyAction({
  text,
  label,
}: {
  /** 点的那一刻才取：流式中的消息复制到的是此刻的全文。 */
  text: string | (() => string);
  label?: string;
}) {
  const t = useT();
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Action
      label={
        copied ? t("acp.message.copied") : (label ?? t("acp.message.copy"))
      }
      onClick={() => {
        void copyText(typeof text === "function" ? text() : text).then((done) =>
          setCopied(done),
        );
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Action>
  );
}
