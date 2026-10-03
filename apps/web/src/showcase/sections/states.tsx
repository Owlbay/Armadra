import { RotateCw, WifiOff } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { Alert, AlertAction, AlertTitle } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/ui/empty";
import { IconButton } from "@/ui/icon-button";
import { Skeleton } from "@/ui/skeleton";
import { Spinner } from "@/ui/spinner";

/**
 * `states` 分区（设计展示页 §2.1，设计系统 §5.16）：通用五态并排——
 * 空态、骨架、行内错误、权限徽标、离线。末尾一张是列表 / 树里的行内形态
 * （文件树、项目搜索、资源抽屉用的那套）：骨架行、带重试的行内错误、一行空态、
 * 行内 Spinner。
 */
export default function StatesSection() {
  const t = useT();
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Empty className="border border-dashed border-border">
        <EmptyHeader>
          <EmptyTitle>{t("showcase.sample.emptyTitle")}</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm">{t("showcase.sample.create")}</Button>
        </EmptyContent>
      </Empty>

      <div className="flex flex-col gap-3 rounded-[var(--r-card)] border border-border bg-card p-4">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-3">
            <Skeleton className="size-6 rounded-[var(--r-pill)]" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>

      <Alert variant="destructive" className="self-start">
        <AlertTitle>{t("showcase.sample.alertTitle")}</AlertTitle>
        <AlertAction>
          <Button size="xs" variant="outline">
            {t("showcase.sample.retry")}
          </Button>
        </AlertAction>
      </Alert>

      <div className="flex flex-wrap items-start gap-2">
        <Badge variant="secondary">{t("showcase.sample.owner")}</Badge>
        <Badge variant="outline">{t("showcase.sample.member")}</Badge>
        <Badge variant="outline">{t("showcase.sample.viewer")}</Badge>
      </div>

      <Alert className="self-start">
        <WifiOff />
        <AlertTitle>{t("showcase.sample.offline")}</AlertTitle>
      </Alert>

      <div
        data-sample="inline-states"
        className="flex flex-col gap-1 rounded-[var(--r-card)] border border-border bg-card py-2 text-xs"
      >
        <div role="status" className="flex flex-col gap-1.5 px-3 py-1.5">
          <span className="sr-only">{t("showcase.state.loading")}</span>
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
        <Alert
          variant="destructive"
          className="flex items-center gap-1 rounded-none border-0 bg-transparent px-3 py-1 text-xs"
        >
          <AlertTitle className="min-w-0 flex-1 truncate font-normal">
            {t("showcase.sample.alertTitle")}
          </AlertTitle>
          <IconButton label={t("showcase.sample.retry")}>
            <RotateCw />
          </IconButton>
        </Alert>
        <Empty className="items-start gap-0 rounded-none p-0 px-3 py-1 text-left">
          <EmptyDescription className="text-xs">
            {t("showcase.sample.emptyTitle")}
          </EmptyDescription>
        </Empty>
        <span className="flex items-center gap-1 px-3 py-1 text-muted-foreground">
          <Spinner aria-hidden role="presentation" className="size-3" />
          {t("showcase.sample.search")}
        </span>
      </div>
    </div>
  );
}
