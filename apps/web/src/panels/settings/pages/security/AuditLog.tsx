import * as React from "react";
import type { AuditEntry, AuditPage, AuditQuery } from "@armadra/shared";
import { ChevronRight, Download } from "lucide-react";
import { toast } from "sonner";

import { exportAudit, readAudit } from "../../../../api/security";
import { useT } from "../../../../app/preferences-store";
import { securityFailure } from "../../../../session/sign-in-errors";
import { SecuritySection, downloadText, useDateTime } from "./parts";
import { Badge } from "@/ui/badge";
import { Card } from "@/ui/card";
import { Button } from "@/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/ui/empty";
import { IconButton } from "@/ui/icon-button";
import { MemberDot } from "@/ui/member-dot";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Skeleton } from "@/ui/skeleton";
import { Spinner } from "@/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";

export const AUDIT_RANGES = ["day", "week", "month", "all"] as const;
export type AuditRange = (typeof AUDIT_RANGES)[number];

const RANGE_MS: Record<AuditRange, number> = {
  day: 24 * 3_600_000,
  week: 7 * 24 * 3_600_000,
  month: 30 * 24 * 3_600_000,
  all: 0,
};

/** 类型筛选 → 动作族（契约 §18.6：一个族命中它自己与 `<族>.*`）。 */
export const AUDIT_TYPES = {
  all: [],
  signIn: ["identity.login"],
  lockout: ["identity.lockout"],
  passkey: ["identity.passkey"],
  mfa: ["identity.mfa"],
  session: ["identity.session", "identity.device"],
  oauth: ["identity.oauth"],
  accounts: [
    "identity.principal",
    "identity.invitation",
    "identity.group",
    "identity.credential",
    "identity.password",
  ],
  sharing: ["share"],
  agents: ["terminal", "approval", "agent", "canvas"],
  host: ["gateway", "credential", "ama.credential"],
} as const satisfies Record<string, readonly string[]>;
export type AuditType = keyof typeof AUDIT_TYPES;

export interface AuditFilters {
  readonly range: AuditRange;
  readonly principalId: string;
  readonly type: AuditType;
}

const PAGE = 50;

/** 筛选 → 查询参数。`now` 钉住时间窗的终点（测试、展示页）。 */
export function auditQuery(filters: AuditFilters, now: number): AuditQuery {
  const span = RANGE_MS[filters.range];
  const actions = AUDIT_TYPES[filters.type];
  return {
    ...(filters.principalId ? { principalId: filters.principalId } : {}),
    ...(actions.length > 0 ? { action: [...actions] } : {}),
    ...(span > 0 ? { sinceMs: Math.max(0, now - span) } : {}),
  };
}

/** 结果由动作名推：`.failed` 与上锁记为失败（契约 §18.6）。 */
export function auditFailed(action: string): boolean {
  return action.endsWith(".failed") || action === "identity.lockout";
}

export interface AuditMember {
  readonly principalId: string;
  readonly displayName: string;
}

/**
 * 审计（设计系统 §5.11）：时间范围 · 成员 · 类型三个筛选，表格（时间 · 成员 ·
 * 动作 · 对象 · 结果），行展开看详情 JSON，「加载更多」，按同样的筛选导出 CSV。
 * 只给 owner（`identity:manage`）；没有权限时这一块由安全页不渲染。
 */
export function AuditLog({
  members,
  load = readAudit,
  exportCsv = exportAudit,
  now: fixedNow,
  initial,
}: {
  members: readonly AuditMember[];
  load?: (query: AuditQuery) => Promise<AuditPage>;
  exportCsv?: (query: AuditQuery) => Promise<string>;
  now?: number;
  /** 展示页直接给一页，不发请求。 */
  initial?: AuditPage;
}) {
  const t = useT();
  const when = useDateTime();
  const [filters, setFilters] = React.useState<AuditFilters>({
    range: "week",
    principalId: "",
    type: "all",
  });
  const [entries, setEntries] = React.useState<readonly AuditEntry[] | null>(
    initial?.entries ?? null,
  );
  const [next, setNext] = React.useState(initial?.nextBeforeId ?? 0);
  const [loading, setLoading] = React.useState<"" | "page" | "more">(
    initial ? "" : "page",
  );
  const [exporting, setExporting] = React.useState(false);
  const [open, setOpen] = React.useState<ReadonlySet<number>>(new Set());
  const query = React.useMemo(
    () => auditQuery(filters, fixedNow ?? Date.now()),
    [filters, fixedNow],
  );
  const skipFirst = React.useRef(initial !== undefined);

  React.useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    let live = true;
    setLoading("page");
    setOpen(new Set());
    load({ ...query, limit: PAGE }).then(
      (page) => {
        if (!live) return;
        setEntries(page.entries);
        setNext(page.nextBeforeId);
        setLoading("");
      },
      (error: unknown) => {
        if (!live) return;
        setEntries([]);
        setNext(0);
        setLoading("");
        toast.error(securityFailure(error, t));
      },
    );
    return () => {
      live = false;
    };
  }, [load, query, t]);

  const more = () => {
    if (!next || loading) return;
    setLoading("more");
    load({ ...query, beforeId: next, limit: PAGE }).then(
      (page) => {
        setEntries((current) => [...(current ?? []), ...page.entries]);
        setNext(page.nextBeforeId);
        setLoading("");
      },
      (error: unknown) => {
        setLoading("");
        toast.error(securityFailure(error, t));
      },
    );
  };

  const download = () => {
    setExporting(true);
    exportCsv(query).then(
      (csv) => {
        setExporting(false);
        downloadText("armadra-audit.csv", csv, "text/csv");
      },
      (error: unknown) => {
        setExporting(false);
        toast.error(securityFailure(error, t));
      },
    );
  };

  const order = new Map(
    members.map((member, index) => [member.principalId, index + 1]),
  );
  const nameOf = (principalId: string) =>
    members.find((member) => member.principalId === principalId)?.displayName ||
    principalId.slice(0, 8);
  const label = (action: string) => {
    const key = `security.audit.action.${action}`;
    const text = t(key);
    return text === key ? action : text;
  };

  return (
    <SecuritySection
      title={t("security.audit")}
      action={
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={exporting || loading === "page"}
          onClick={download}
        >
          {exporting ? (
            <Spinner aria-label={t("security.audit.export")} />
          ) : (
            <Download />
          )}
          {t("security.audit.export")}
        </Button>
      }
    >
      <div className="flex flex-wrap gap-2">
        <Select
          value={filters.range}
          onValueChange={(range) =>
            setFilters((current) => ({
              ...current,
              range: range as AuditRange,
            }))
          }
        >
          <SelectTrigger
            size="sm"
            className="w-36"
            aria-label={t("security.audit.range")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AUDIT_RANGES.map((range) => (
              <SelectItem key={range} value={range}>
                {t(`security.audit.range.${range}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.principalId || "*"}
          onValueChange={(value) =>
            setFilters((current) => ({
              ...current,
              principalId: value === "*" ? "" : value,
            }))
          }
        >
          <SelectTrigger
            size="sm"
            className="w-40"
            aria-label={t("security.audit.member")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="*">{t("security.audit.members")}</SelectItem>
            {members.map((member) => (
              <SelectItem key={member.principalId} value={member.principalId}>
                {member.displayName || member.principalId.slice(0, 8)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.type}
          onValueChange={(type) =>
            setFilters((current) => ({ ...current, type: type as AuditType }))
          }
        >
          <SelectTrigger
            size="sm"
            className="w-40"
            aria-label={t("security.audit.type")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(AUDIT_TYPES) as AuditType[]).map((type) => (
              <SelectItem key={type} value={type}>
                {t(`security.audit.type.${type}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {loading === "page" || entries === null ? (
        <div className="flex flex-col gap-2" data-slot="audit-loading">
          {[0, 1, 2, 3, 4].map((row) => (
            <Skeleton key={row} className="h-7 w-full" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <Empty className="border border-dashed border-border/70 py-8">
          <EmptyHeader>
            <EmptyTitle className="text-[13px] font-normal text-muted-foreground">
              {t("security.audit.empty")}
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card className="gap-0 overflow-visible rounded-lg border border-border/70 py-0 text-[length:inherit] ring-0 px-2">
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-0">
                  <span className="sr-only">{t("security.audit.details")}</span>
                </TableHead>
                <TableHead>{t("security.audit.time")}</TableHead>
                <TableHead>{t("security.audit.member")}</TableHead>
                <TableHead>{t("security.audit.action")}</TableHead>
                <TableHead>{t("security.audit.target")}</TableHead>
                <TableHead>{t("security.audit.result")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => {
                const expanded = open.has(entry.id);
                const failed = auditFailed(entry.action);
                return (
                  <React.Fragment key={entry.id}>
                    <TableRow data-state={expanded ? "open" : "closed"}>
                      <TableCell className="w-0 pr-0">
                        <IconButton
                          label={t("security.audit.details")}
                          aria-expanded={expanded}
                          onClick={() =>
                            setOpen((current) => {
                              const copy = new Set(current);
                              if (copy.has(entry.id)) copy.delete(entry.id);
                              else copy.add(entry.id);
                              return copy;
                            })
                          }
                        >
                          <ChevronRight
                            className={`transition-transform ${expanded ? "rotate-90" : ""}`}
                          />
                        </IconButton>
                      </TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {when(entry.atMs)}
                      </TableCell>
                      <TableCell className="max-w-[10rem]">
                        {entry.principalId ? (
                          <span className="flex min-w-0 items-center gap-1.5">
                            <MemberDot
                              index={order.get(entry.principalId) ?? 0}
                              name={nameOf(entry.principalId)}
                            />
                            <span className="truncate">
                              {nameOf(entry.principalId)}
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[12rem] truncate">
                        {label(entry.action)}
                      </TableCell>
                      <TableCell className="max-w-[10rem] truncate font-mono text-[12px] text-muted-foreground">
                        {entry.target || entry.workspaceId || "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={failed ? "destructive" : "outline"}>
                          {t(
                            failed
                              ? "security.audit.failed"
                              : "security.audit.ok",
                          )}
                        </Badge>
                      </TableCell>
                    </TableRow>
                    {expanded && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={6} className="p-0 pb-2">
                          <pre className="max-h-64 overflow-auto rounded-md bg-[var(--surface-raised)] p-3 font-mono text-[12px] whitespace-pre-wrap break-all">
                            {JSON.stringify(
                              {
                                action: entry.action,
                                principalId: entry.principalId,
                                deviceId: entry.deviceId,
                                target: entry.target,
                                workspaceId: entry.workspaceId,
                                detail: entry.detail,
                              },
                              null,
                              2,
                            )}
                          </pre>
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
      {next > 0 && entries !== null && loading !== "page" && (
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading !== ""}
            onClick={more}
          >
            {loading === "more" && (
              <Spinner aria-label={t("security.audit.more")} />
            )}
            {t("security.audit.more")}
          </Button>
        </div>
      )}
    </SecuritySection>
  );
}
