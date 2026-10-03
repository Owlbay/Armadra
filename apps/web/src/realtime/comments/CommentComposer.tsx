import * as React from "react";
import { AtSign } from "lucide-react";
import type { CommentPerson } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import { Command, CommandEmpty, CommandItem, CommandList } from "@/ui/command";
import { IconButton } from "@/ui/icon-button";
import { Popover, PopoverAnchor, PopoverContent } from "@/ui/popover";
import { Textarea } from "@/ui/textarea";
import { decodeMentions, encodeMentions } from "./store";

/**
 * 评论输入框（设计系统 §5.7）：Textarea + 发送；打 `@` 弹出成员表
 * （`Command`，上下键选、回车确认），选中的人在发出前换成提及记号。
 *
 * 离线时发送禁用、草稿留着；`⌘/Ctrl + Enter` 发送。
 */
export interface CommentComposerProps {
  people: readonly CommentPerson[];
  placeholder: string;
  /** 编辑已有评论时的原文（带提及记号）。 */
  initial?: string;
  submitLabel?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  onSubmit: (body: string) => Promise<unknown> | void;
  onCancel?: () => void;
}

/** 光标前那个还没打完的 `@xxx`：没有就是 `null`。 */
export function mentionQuery(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1] ?? "")) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query) || query.length > 40) return null;
  return { start: at, query };
}

export function CommentComposer({
  people,
  placeholder,
  initial,
  submitLabel,
  disabled = false,
  autoFocus = false,
  onSubmit,
  onCancel,
}: CommentComposerProps) {
  const t = useT();
  const decoded = React.useMemo(() => decodeMentions(initial ?? ""), [initial]);
  const [text, setText] = React.useState(decoded.text);
  const [picked, setPicked] = React.useState<CommentPerson[]>(decoded.picked);
  const [mention, setMention] = React.useState<{
    start: number;
    query: string;
  } | null>(null);
  const [active, setActive] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const area = React.useRef<HTMLTextAreaElement>(null);

  const matches = React.useMemo(() => {
    if (mention === null) return [];
    const query = mention.query.toLowerCase();
    return people
      .filter((person) => person.name.toLowerCase().includes(query))
      .slice(0, 8);
  }, [mention, people]);

  const sync = (value: string, caret: number) => {
    setText(value);
    const next = mentionQuery(value, caret);
    setMention(next);
    setActive(0);
  };

  const pick = (person: CommentPerson) => {
    if (mention === null) return;
    const insert = `@${person.name} `;
    const end = mention.start + 1 + mention.query.length;
    const value = text.slice(0, mention.start) + insert + text.slice(end);
    setText(value);
    setMention(null);
    setPicked((current) =>
      current.some((one) => one.principalId === person.principalId)
        ? current
        : [...current, person],
    );
    const caret = mention.start + insert.length;
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(caret, caret);
    });
  };

  const trimmed = text.trim();
  const canSend = trimmed !== "" && !disabled && !busy;

  const submit = async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      await onSubmit(encodeMentions(trimmed, picked));
      setText("");
      setPicked([]);
      setMention(null);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention !== null && matches.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((index) => (index + step + matches.length) % matches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const person = matches[active];
        if (person) pick(person);
        return;
      }
    }
    if (event.key === "Escape" && mention !== null) {
      event.preventDefault();
      event.stopPropagation();
      setMention(null);
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  const insertAt = () => {
    const node = area.current;
    const caret = node?.selectionStart ?? text.length;
    const lead = caret > 0 && !/\s/.test(text[caret - 1] ?? "") ? " @" : "@";
    const value = text.slice(0, caret) + lead + text.slice(caret);
    sync(value, caret + lead.length);
    requestAnimationFrame(() => {
      node?.focus();
      node?.setSelectionRange(caret + lead.length, caret + lead.length);
    });
  };

  const activeId = matches[active]?.principalId ?? "";

  return (
    <div data-slot="comment-composer" className="flex flex-col gap-2">
      <Popover
        open={mention !== null}
        onOpenChange={(open) => !open && setMention(null)}
      >
        <PopoverAnchor asChild>
          <Textarea
            ref={area}
            value={text}
            rows={2}
            autoFocus={autoFocus}
            placeholder={placeholder}
            aria-label={placeholder}
            className="min-h-16 resize-none"
            onChange={(event) =>
              sync(event.target.value, event.target.selectionStart)
            }
            onKeyDown={onKeyDown}
          />
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="w-56 p-0"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <Command value={activeId} shouldFilter={false}>
            <CommandList>
              <CommandEmpty>{t("comments.noPeople")}</CommandEmpty>
              {matches.map((person) => (
                <CommandItem
                  key={person.principalId}
                  value={person.principalId}
                  onSelect={() => pick(person)}
                >
                  {person.name}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <div className="flex items-center gap-2">
        <IconButton
          label={t("comments.mention")}
          disabled={disabled || people.length === 0}
          onClick={insertAt}
        >
          <AtSign />
        </IconButton>
        <div className="ml-auto flex items-center gap-2">
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              {t("comments.cancel")}
            </Button>
          )}
          <Button size="sm" disabled={!canSend} onClick={() => void submit()}>
            {submitLabel ?? t("comments.send")}
          </Button>
        </div>
      </div>
    </div>
  );
}
