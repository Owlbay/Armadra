import { WifiOff } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { Alert, AlertAction, AlertTitle } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@/ui/empty";
import { Skeleton } from "@/ui/skeleton";

/**
 * `states` 分区（设计展示页 §2.1，设计系统 §5.16）：通用五态并排——
 * 空态、骨架、行内错误、权限徽标、离线。
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
    </div>
  );
}
