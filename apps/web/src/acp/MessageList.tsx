import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { Spinner } from "@/ui/spinner";
import { ToolCallRow } from "./ToolCallRow";
import type { AcpItem } from "./store";

type MessageItem = Extract<AcpItem, { kind: "message" }>;

function Thought({ text }: { text: string }) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="text-[11px] font-normal text-muted-foreground"
        >
          {open ? <ChevronDown /> : <ChevronRight />}
          {t("acp.thought")}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-2 pt-0.5 text-[11px] whitespace-pre-wrap text-muted-foreground">
        {text}
      </CollapsibleContent>
    </Collapsible>
  );
}

function Message({ item }: { item: MessageItem }) {
  if (item.role === "thought") return <Thought text={item.text} />;
  if (item.role === "user") {
    return (
      <div
        data-role="user"
        className="ml-8 self-end rounded-[var(--r-card)] bg-[var(--surface-raised)] px-2.5 py-1.5 text-[13px] whitespace-pre-wrap"
      >
        {item.text}
      </div>
    );
  }
  return (
    <div
      data-role="assistant"
      className="sticky-markdown text-[13px] leading-relaxed"
    >
      <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
    </div>
  );
}

/**
 * 消息流（设计系统 §5.1）：用户靠右、Agent 靠左，发言人不写名字；
 * 思考折叠；工具调用一行一个。流式中最后一条尾部一个小 Spinner。
 */
export function MessageList({
  items,
  streaming,
}: {
  items: readonly AcpItem[];
  streaming: boolean;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2" data-slot="acp-messages">
      {items.map((item) =>
        item.kind === "tool" ? (
          <ToolCallRow key={item.id} call={item.call} />
        ) : (
          <Message key={item.id} item={item} />
        ),
      )}
      {streaming && (
        <Spinner
          aria-label={t("acp.streaming")}
          className="size-3 text-muted-foreground"
        />
      )}
    </div>
  );
}
