import * as React from "react";
import { MessageSquare } from "lucide-react";

import { useT } from "@/app/preferences-store";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/ui/accordion";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/ui/empty";
import { Label } from "@/ui/label";
import { ScrollArea } from "@/ui/scroll-area";
import { Separator } from "@/ui/separator";
import { Switch } from "@/ui/switch";
import type { CommentThreadData } from "./store";

/**
 * 评论抽屉的内容（设计系统 §5.7）：标题行带「只看未解决」开关；未解决的
 * 线程逐条列出，已解决的收进一个 `Accordion`；没有评论时 `Empty`。
 *
 * 线程怎么画由调用方给（`renderThread`），这里只管排布——展示页与画布用
 * 同一份。
 */
export interface CommentsPanelViewProps {
  threads: readonly CommentThreadData[];
  onlyOpen: boolean;
  onOnlyOpenChange: (value: boolean) => void;
  renderThread: (
    thread: CommentThreadData,
    options: { compact: boolean },
  ) => React.ReactNode;
}

export function CommentsPanelView({
  threads,
  onlyOpen,
  onOnlyOpenChange,
  renderThread,
}: CommentsPanelViewProps) {
  const t = useT();
  const switchId = React.useId();
  const open = threads.filter((thread) => thread.root.resolvedAtMs === null);
  const resolved = threads.filter(
    (thread) => thread.root.resolvedAtMs !== null,
  );
  return (
    <div data-slot="comments-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 pb-3">
        <Label htmlFor={switchId} className="ml-auto text-muted-foreground">
          {t("comments.onlyOpen")}
        </Label>
        <Switch
          id={switchId}
          checked={onlyOpen}
          onCheckedChange={onOnlyOpenChange}
        />
      </div>
      <Separator />
      {(onlyOpen ? open.length : threads.length) === 0 ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MessageSquare />
            </EmptyMedia>
            <EmptyTitle>{t("comments.empty")}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-4 p-4">
            {open.map((thread, index) => (
              <React.Fragment key={thread.root.id}>
                {index > 0 && <Separator />}
                {renderThread(thread, { compact: false })}
              </React.Fragment>
            ))}
            {!onlyOpen && resolved.length > 0 && (
              <Accordion type="single" collapsible>
                <AccordionItem value="resolved">
                  <AccordionTrigger>
                    {t("comments.resolvedCount", { count: resolved.length })}
                  </AccordionTrigger>
                  <AccordionContent className="flex flex-col gap-4">
                    {resolved.map((thread) => (
                      <React.Fragment key={thread.root.id}>
                        {renderThread(thread, { compact: true })}
                      </React.Fragment>
                    ))}
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
