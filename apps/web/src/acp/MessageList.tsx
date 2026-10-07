import * as React from "react";
import { ChevronDown, ChevronRight, Pencil, RotateCcw } from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { usePreferencesStore, useT } from "@/app/preferences-store";
import { Alert, AlertAction, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { Spinner } from "@/ui/spinner";
import { Attachments } from "./Attachments";
import { ExportMenu } from "./ExportMenu";
import { Action, ActionBar, CopyAction } from "./MessageActions";
import { PlanCard, type PlanView } from "./PlanCard";
import { ToolCallRow } from "./ToolCallRow";
import type { AcpItem } from "./store";

type MessageItem = Extract<AcpItem, { kind: "message" }>;
type StopItem = Extract<AcpItem, { kind: "stop" }>;

/** 会话视图里消息的来源：输出到画板时记进新对象（ACP 设计 §7）。 */
export interface MessageSource {
  nodeId: string;
  sessionId: string;
}

/**
 * 消息上的动作回到会话视图（ACP 会话视图 §5.2）。都不给时（展示页、只读的
 * 别处）消息只有复制。
 */
export interface MessageListActions {
  /** 把文字回填进输入框，不自动发。 */
  onEdit?: (text: string) => void;
  /** 重发一条提问（重新发送、重新生成）。 */
  onResend?: (text: string) => void;
  /** 直接发一句（「继续」）。 */
  onPrompt?: (text: string) => void;
  /** 最后一回合没有正常结束：它的提问上有「重新发送」。 */
  resendable?: boolean;
}

/** 思考折叠时摘要的长度。 */
const THOUGHT_SUMMARY = 40;

function Thought({ text, live }: { text: string; live: boolean }) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const summary = text.replace(/\s+/g, " ").trim().slice(0, THOUGHT_SUMMARY);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="group/act relative"
      data-role="thought"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0 font-normal text-muted-foreground"
          >
            {open ? <ChevronDown /> : <ChevronRight />}
            {t(live ? "acp.thought.working" : "acp.thought")}
          </Button>
        </CollapsibleTrigger>
        {live && (
          <Spinner aria-hidden className="size-3 text-muted-foreground" />
        )}
        {!open && summary && (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {summary}
          </span>
        )}
        <ActionBar className="ml-auto">
          <CopyAction text={text} />
        </ActionBar>
      </div>
      <CollapsibleContent className="px-2 pt-0.5 text-[11px] break-words whitespace-pre-wrap text-muted-foreground">
        {text}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 代码块：等宽 12px，右上角一个「复制」。 */
function CodeBlock({ children }: React.ComponentProps<"pre">) {
  const ref = React.useRef<HTMLPreElement>(null);
  return (
    <div className="group/act relative" data-slot="acp-code">
      <pre ref={ref}>{children}</pre>
      <ActionBar className="absolute top-1 right-1 rounded-[var(--r-control)] bg-[var(--surface-raised)]">
        <CopyAction text={() => ref.current?.textContent ?? ""} />
      </ActionBar>
    </div>
  );
}

const MARKDOWN: Components = { pre: CodeBlock };

function timeOf(at: string | undefined, locale: string): string | null {
  if (!at) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function UserMessage({
  item,
  showTime,
  resend,
  actions,
}: {
  item: MessageItem;
  showTime: boolean;
  resend: boolean;
  actions?: MessageListActions | undefined;
}) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const time = showTime ? timeOf(item.at, locale) : null;
  return (
    <div className="group/act relative flex max-w-[85%] flex-col items-end gap-0.5 self-end">
      {time && item.at && (
        <time
          dateTime={item.at}
          className="text-[11px] text-muted-foreground tabular-nums"
        >
          {time}
        </time>
      )}
      <div
        data-role="user"
        className="rounded-[var(--r-card)] bg-[var(--surface-raised)] px-2.5 py-1.5 text-[13px] [overflow-wrap:anywhere] whitespace-pre-wrap"
      >
        {item.text}
        {item.attachments && (
          <Attachments
            attachments={item.attachments}
            compact
            className={item.text ? "mt-1" : undefined}
          />
        )}
      </div>
      <ActionBar className="absolute top-0 right-full mr-1">
        {resend && actions?.onResend && (
          <Action
            label={t("acp.message.resend")}
            onClick={() => actions.onResend?.(item.text)}
          >
            <RotateCcw />
          </Action>
        )}
        {actions?.onEdit && (
          <Action
            label={t("acp.message.editResend")}
            onClick={() => actions.onEdit?.(item.text)}
          >
            <Pencil />
          </Action>
        )}
        <CopyAction text={item.text} />
      </ActionBar>
    </div>
  );
}

function AssistantMessage({
  item,
  source,
  regenerate,
}: {
  item: MessageItem;
  source?: MessageSource | undefined;
  /** 给了就有「重新生成」：重发这一回合的提问。 */
  regenerate?: (() => void) | undefined;
}) {
  const t = useT();
  const body = React.useRef<HTMLDivElement>(null);
  const hasText = item.text.trim() !== "";
  return (
    <div className="group/act relative max-w-[72ch]">
      <div
        ref={body}
        data-role="assistant"
        className="sticky-markdown text-[13px] leading-relaxed [overflow-wrap:anywhere]"
      >
        {hasText && (
          <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN}>
            {item.text}
          </Markdown>
        )}
      </div>
      {item.attachments && (
        <Attachments
          attachments={item.attachments}
          className={hasText ? "mt-1.5" : undefined}
        />
      )}
      {hasText && (
        <ActionBar className="absolute -top-2 right-0 rounded-[var(--r-control)] bg-[var(--card)]">
          <CopyAction text={item.text} />
          {source && (
            <ExportMenu
              text={item.text}
              source={{ ...source, messageId: item.id }}
              selectionRoot={body}
            />
          )}
          {regenerate && (
            <Action label={t("acp.message.regenerate")} onClick={regenerate}>
              <RotateCcw />
            </Action>
          )}
        </ActionBar>
      )}
    </div>
  );
}

/** 一行居中的灰字，回合尾与模式切换共用。 */
function CenterLine({ children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className="flex items-center justify-center gap-2 py-0.5 text-[11px] text-muted-foreground"
      {...props}
    >
      {children}
    </div>
  );
}

/** 回合没有正常说完时回合尾那一行（ACP 会话视图 §5.2）。 */
function StopRow({
  item,
  prompt,
  last,
  actions,
}: {
  item: StopItem;
  /** 这一回合的提问。 */
  prompt: string | null;
  /** 是最后一回合、此刻没有在跑：动作才有意义。 */
  last: boolean;
  actions?: MessageListActions | undefined;
}) {
  const t = useT();
  if (item.stopReason === "refusal") {
    return (
      <Alert data-stop="refusal">
        <AlertTitle>{t("acp.turn.refused")}</AlertTitle>
        {prompt !== null && actions?.onEdit && (
          <AlertAction>
            <Button
              size="xs"
              variant="outline"
              onClick={() => actions.onEdit?.(prompt)}
            >
              {t("acp.message.editResend")}
            </Button>
          </AlertAction>
        )}
      </Alert>
    );
  }
  if (item.stopReason === "cancelled") {
    return (
      <CenterLine data-stop="cancelled">
        <span>{t("acp.turn.cancelled")}</span>
        {last && prompt !== null && actions?.onResend && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => actions.onResend?.(prompt)}
          >
            {t("acp.message.resend")}
          </Button>
        )}
      </CenterLine>
    );
  }
  return (
    <CenterLine data-stop={item.stopReason}>
      <span>{t("acp.turn.limit")}</span>
      {last && actions?.onPrompt && (
        <Button
          size="xs"
          variant="outline"
          onClick={() => actions.onPrompt?.(t("acp.turn.continuePrompt"))}
        >
          {t("acp.turn.continue")}
        </Button>
      )}
    </CenterLine>
  );
}

interface Section {
  readonly turn: number;
  readonly items: AcpItem[];
}

function sectionsOf(items: readonly AcpItem[]): Section[] {
  const sections: Section[] = [];
  for (const item of items) {
    const last = sections.at(-1);
    if (last && last.turn === item.turn) last.items.push(item);
    else sections.push({ turn: item.turn, items: [item] });
  }
  return sections;
}

/**
 * 消息流（设计系统 §5.1，ACP 会话视图 §5.2–§5.3）：一回合一个 `section`，
 * 回合内 `gap-1.5`、回合之间 `gap-3`；用户靠右、Agent 靠左，发言人不写名字；
 * 回合第一条提问右上角是时间；计划卡在它那一回合的提问下面；思考折叠；工具
 * 调用一行一个；回合没有正常说完时尾部一行。流式中最后一条尾部一个小 Spinner。
 */
export function MessageList({
  items,
  streaming,
  source,
  plan,
  actions,
}: {
  items: readonly AcpItem[];
  streaming: boolean;
  /** 给了才有「输出到画板」。 */
  source?: MessageSource | undefined;
  plan?: PlanView | null | undefined;
  actions?: MessageListActions | undefined;
}) {
  const t = useT();
  const sections = React.useMemo(() => sectionsOf(items), [items]);
  const lastUser = React.useMemo(
    () =>
      [...items]
        .reverse()
        .find(
          (item): item is MessageItem =>
            item.kind === "message" && item.role === "user",
        ),
    [items],
  );
  const lastItem = items.at(-1);
  const planTurn =
    plan && plan.entries.length > 0
      ? sections.some((section) => section.turn === plan.turn)
        ? plan.turn
        : (sections.at(-1)?.turn ?? null)
      : null;

  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      data-slot="acp-messages"
      role="log"
      aria-live="off"
      aria-label={t("acp.messages.label")}
    >
      {sections.map((section) => {
        const prompt =
          section.items.find(
            (item): item is MessageItem =>
              item.kind === "message" && item.role === "user",
          ) ?? null;
        const lastTurn =
          lastUser !== undefined && section.turn === lastUser.turn;
        let shownTime = false;
        const children: React.ReactNode[] = [];
        for (const item of section.items) {
          if (item.kind === "tool") {
            children.push(
              <ToolCallRow
                key={item.id}
                call={item.call}
                source={source}
                {...(actions?.onEdit
                  ? {
                      onRetry: (text: string) => actions.onEdit?.(text),
                    }
                  : {})}
              />,
            );
          } else if (item.kind === "notice") {
            children.push(
              <CenterLine key={item.id} data-notice={item.notice}>
                {t("acp.mode.switched", { name: item.name })}
              </CenterLine>,
            );
          } else if (item.kind === "stop") {
            children.push(
              <StopRow
                key={item.id}
                item={item}
                prompt={prompt?.text ?? null}
                last={lastTurn && !streaming}
                actions={actions}
              />,
            );
          } else if (item.role === "user") {
            children.push(
              <UserMessage
                key={item.id}
                item={item}
                showTime={!shownTime}
                resend={
                  item === lastUser &&
                  !streaming &&
                  actions?.resendable === true
                }
                actions={actions}
              />,
            );
            shownTime = true;
          } else if (item.role === "thought") {
            children.push(
              <Thought
                key={item.id}
                text={item.text}
                live={streaming && item === lastItem}
              />,
            );
          } else {
            children.push(
              <AssistantMessage
                key={item.id}
                item={item}
                source={source}
                regenerate={
                  lastTurn && !streaming && prompt && actions?.onResend
                    ? () => actions.onResend?.(prompt.text)
                    : undefined
                }
              />,
            );
          }
        }
        // 计划卡在这一回合的提问下面（没有提问就在最上面）。
        if (plan && planTurn === section.turn) {
          const at = prompt ? section.items.indexOf(prompt) + 1 : 0;
          children.splice(
            at,
            0,
            <PlanCard key="plan" plan={plan} live={streaming && lastTurn} />,
          );
        }
        return (
          <section
            key={`turn-${section.turn}-${section.items[0]?.id ?? ""}`}
            data-turn={section.turn}
            className="flex min-w-0 flex-col gap-1.5"
          >
            {children}
          </section>
        );
      })}
      {streaming && (
        <Spinner
          aria-label={t("acp.streaming")}
          className="size-3 text-muted-foreground"
        />
      )}
    </div>
  );
}
