import * as React from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, ExternalLink } from "lucide-react";

import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { Textarea } from "@/ui/textarea";
import { useT } from "@/app/preferences-store";
import { openExternal } from "@/platform";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Check, Field } from "../git/forms";
import { CheckoutWorktree } from "./CheckoutWorktree";
import { MergeCleanupView } from "./MergeCleanup";
import {
  autoMergeForgePull,
  cancelAutoMergeForgePull,
  deleteForgeBranch,
  type ForgeDetection,
  type ForgeIssue,
  type ForgeListState,
  type ForgeMergeMethod,
  type ForgePull,
  type ForgeRepo,
  createForgePull,
  forgeFailureKey,
  forgeIssue,
  forgeFailure,
  forgeIssues,
  forgeMergeOptions,
  forgePull,
  forgePullChecks,
  forgePullFiles,
  forgePulls,
  mergeForgePull,
  mergeMethods,
  setForgeIssueState,
} from "../../api/forge";

/**
 * Git 托管面板里 Gitea / GitLab 的那一面（契约 §29.4、§29.6）。
 *
 * GitHub 仓库仍是 {@link GithubDrawer} 原来那一面（状态映射、评审…）；这里是
 * 两个平台共有的那层：issue 列表与开关，PR / MR 列表、详情、文件、检查（CI
 * 汇总映射成一枚徽标）、合并与新建，以及与 GitHub 共用的检出到 worktree 和
 * 合并后清理。合并带着页面上显示的 head，远端动过就被拒绝。
 */

export type ForgeTab = "issues" | "pulls";

function repoKey(repo: ForgeRepo): string {
  return `${repo.host}/${repo.owner}/${repo.name}`;
}

export const forgeKeys = {
  all: ["forge"] as const,
  issues: (repo: ForgeRepo, state: ForgeListState) =>
    ["forge", "issues", repoKey(repo), state] as const,
  issue: (repo: ForgeRepo, number: number) =>
    ["forge", "issue", repoKey(repo), number] as const,
  pulls: (repo: ForgeRepo, state: ForgeListState) =>
    ["forge", "pulls", repoKey(repo), state] as const,
  pull: (repo: ForgeRepo, number: number) =>
    ["forge", "pull", repoKey(repo), number] as const,
  files: (repo: ForgeRepo, number: number) =>
    ["forge", "files", repoKey(repo), number] as const,
  checks: (repo: ForgeRepo, number: number) =>
    ["forge", "checks", repoKey(repo), number] as const,
  mergeOptions: (repo: ForgeRepo) =>
    ["forge", "merge-options", repoKey(repo)] as const,
};

function when(ms: number | null, locale: string): string {
  if (!ms || ms <= 0) return "";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}

function shortSha(sha: string): string {
  return sha ? sha.slice(0, 12) : "";
}

function OpenRemote({ url }: { url: string }) {
  const t = useT();
  if (!url) return null;
  return (
    <IconButton
      label={t("forge.openRemote")}
      onClick={() => void openExternal(url)}
    >
      <ExternalLink />
    </IconButton>
  );
}

function Failure({ error }: { error: unknown }) {
  const t = useT();
  return (
    <p
      role="status"
      data-slot="forge-failure"
      className="px-3 py-2 text-[12px] text-destructive"
    >
      {t(forgeFailureKey(error))}
    </p>
  );
}

export interface ForgeHostedProps {
  detection: ForgeDetection;
  locale: string;
  canWrite: boolean;
  /** 关着的面板不轮询也不发请求。 */
  open: boolean;
  /** 检出与清理作用于这个工作空间的根仓库；没有工作空间时不给这两样。 */
  workspaceId?: string | null;
  /**
   * 要直接打开的条目（画布上的连接徽标点进来）。`reveal` 每点一次加一，同一条
   * 点两次也会再定位过去。
   */
  focus?: {
    readonly tab: ForgeTab;
    readonly number: number;
    readonly reveal: number;
  } | null;
}

export function ForgeHosted({
  detection,
  locale,
  canWrite,
  open,
  workspaceId = null,
  focus = null,
}: ForgeHostedProps) {
  const t = useT();
  const forge = detection.forge ?? "gitea";
  const repo = detection.repository;
  const [tab, setTab] = React.useState<ForgeTab>(focus?.tab ?? "pulls");
  const [state, setState] = React.useState<ForgeListState>("open");
  const [selected, setSelected] = React.useState<number | null>(
    focus?.number ?? null,
  );
  const reveal = focus?.reveal ?? 0;
  const focusTab = focus?.tab;
  const focusNumber = focus?.number;
  React.useEffect(() => {
    if (reveal === 0 || focusTab === undefined || focusNumber === undefined)
      return;
    setTab(focusTab);
    setSelected(focusNumber);
  }, [reveal, focusTab, focusNumber]);

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        setTab(value as ForgeTab);
        setSelected(null);
      }}
      className="min-w-0 gap-0"
      data-slot="forge-hosted"
      data-forge={forge}
    >
      <TabsList
        className="h-10 w-full shrink-0 rounded-none border-b border-border"
        variant="line"
      >
        <TabsTrigger value="issues" className="min-w-0 text-xs">
          {t("forge.tab.issues")}
        </TabsTrigger>
        <TabsTrigger value="pulls" className="min-w-0 text-xs">
          {t(`forge.tab.pulls.${forge === "gitlab" ? "gitlab" : "gitea"}`)}
        </TabsTrigger>
      </TabsList>
      {selected === null && (
        <div className="flex min-w-0 items-end gap-2 border-b border-border p-3">
          <Field label={t("forge.filter.state")}>
            <Select
              value={state}
              onValueChange={(next) => setState(next as ForgeListState)}
            >
              <SelectTrigger className="h-9 w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
                {(["open", "closed", "all"] as const).map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`forge.state.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      )}
      <TabsContent
        value="issues"
        className="mt-0 min-w-0 data-[state=inactive]:hidden"
      >
        {selected !== null && tab === "issues" ? (
          <IssueDetail
            repo={repo}
            number={selected}
            locale={locale}
            canWrite={canWrite}
            onBack={() => setSelected(null)}
          />
        ) : (
          <IssueList
            repo={repo}
            state={state}
            locale={locale}
            enabled={open && tab === "issues"}
            onOpen={setSelected}
          />
        )}
      </TabsContent>
      <TabsContent
        value="pulls"
        className="mt-0 min-w-0 data-[state=inactive]:hidden"
      >
        {selected !== null && tab === "pulls" ? (
          <PullDetail
            forge={forge}
            repo={repo}
            number={selected}
            locale={locale}
            canWrite={canWrite}
            workspaceId={workspaceId}
            onBack={() => setSelected(null)}
          />
        ) : (
          <>
            <PullList
              repo={repo}
              state={state}
              locale={locale}
              enabled={open && tab === "pulls"}
              onOpen={setSelected}
            />
            {canWrite && <CreatePull repo={repo} onCreated={setSelected} />}
          </>
        )}
      </TabsContent>
    </Tabs>
  );
}

/* --------------------------------- issue --------------------------------- */

function IssueList({
  repo,
  state,
  locale,
  enabled,
  onOpen,
}: {
  repo: ForgeRepo;
  state: ForgeListState;
  locale: string;
  enabled: boolean;
  onOpen: (number: number) => void;
}) {
  const t = useT();
  const issues = useInfiniteQuery({
    queryKey: forgeKeys.issues(repo, state),
    queryFn: ({ pageParam }) => forgeIssues(repo, state, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled,
    retry: false,
  });
  if (issues.isError) return <Failure error={issues.error} />;
  const items = issues.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="min-w-0 space-y-2 p-3">
      {issues.data && items.length === 0 && (
        <p className="text-[12px] text-muted-foreground">{t("forge.empty")}</p>
      )}
      {items.map((issue) => (
        <Row
          key={issue.number}
          slot="forge-issue"
          number={issue.number}
          title={issue.title}
          badges={[t(`forge.state.${issue.state}`)]}
          meta={`${issue.author ?? ""} · ${when(issue.updatedAtMs, locale)}`}
          onOpen={() => onOpen(issue.number)}
        />
      ))}
      {issues.hasNextPage && (
        <Button
          size="sm"
          variant="ghost"
          className="min-h-10"
          disabled={issues.isFetchingNextPage}
          onClick={() => void issues.fetchNextPage()}
        >
          {t("forge.more")}
        </Button>
      )}
    </div>
  );
}

function Row({
  slot,
  number,
  title,
  badges,
  meta,
  onOpen,
}: {
  slot: string;
  number: number;
  title: string;
  badges: string[];
  meta: string;
  onOpen: () => void;
}) {
  return (
    <article
      data-slot={slot}
      data-number={number}
      className="min-w-0 rounded-lg border border-border"
    >
      <Button
        variant="ghost"
        className="h-auto min-h-10 w-full min-w-0 flex-col items-stretch gap-1 px-3 py-2 text-left"
        onClick={onOpen}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 tabular-nums text-muted-foreground">
            #{number}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
            {title}
          </span>
          {badges.map((badge) => (
            <Badge key={badge} variant="secondary">
              {badge}
            </Badge>
          ))}
        </span>
        <span className="min-w-0 truncate text-[12px] font-normal text-muted-foreground">
          {meta}
        </span>
      </Button>
    </article>
  );
}

function IssueDetail({
  repo,
  number,
  locale,
  canWrite,
  onBack,
}: {
  repo: ForgeRepo;
  number: number;
  locale: string;
  canWrite: boolean;
  onBack: () => void;
}) {
  const t = useT();
  const client = useQueryClient();
  const issue = useQuery({
    queryKey: forgeKeys.issue(repo, number),
    queryFn: () => forgeIssue(repo, number),
    retry: false,
  });
  const toggle = useMutation({
    mutationFn: (next: "open" | "closed") =>
      setForgeIssueState(repo, number, next),
    onSuccess: (updated) => {
      client.setQueryData(forgeKeys.issue(repo, number), updated);
      void client.invalidateQueries({ queryKey: ["forge", "issues"] });
    },
    onError: (error) => toast.error(t(forgeFailureKey(error))),
  });
  return (
    <div className="min-w-0 space-y-3 p-3" data-slot="forge-issue-detail">
      <Back onBack={onBack} url={issue.data?.url ?? ""} />
      {issue.isError && <Failure error={issue.error} />}
      {issue.data && (
        <IssueBody
          issue={issue.data}
          locale={locale}
          action={
            canWrite && (
              <Button
                size="sm"
                variant="secondary"
                className="min-h-10"
                disabled={toggle.isPending}
                onClick={() =>
                  toggle.mutate(issue.data.state === "open" ? "closed" : "open")
                }
              >
                {t(
                  issue.data.state === "open"
                    ? "forge.issue.close"
                    : "forge.issue.reopen",
                )}
              </Button>
            )
          }
        />
      )}
    </div>
  );
}

function Back({ onBack, url }: { onBack: () => void; url: string }) {
  const t = useT();
  return (
    <div className="flex min-w-0 items-center gap-1">
      <IconButton label={t("forge.back")} onClick={onBack}>
        <ArrowLeft />
      </IconButton>
      <div className="flex-1" />
      <OpenRemote url={url} />
    </div>
  );
}

function IssueBody({
  issue,
  locale,
  action,
}: {
  issue: ForgeIssue;
  locale: string;
  action: React.ReactNode;
}) {
  const t = useT();
  return (
    <>
      <h3 className="min-w-0 text-[14px] font-semibold break-words">
        <span className="mr-2 tabular-nums text-muted-foreground">
          #{issue.number}
        </span>
        {issue.title}
      </h3>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant="secondary">{t(`forge.state.${issue.state}`)}</Badge>
        {issue.labels.map((label) => (
          <Badge key={label} variant="outline">
            {label}
          </Badge>
        ))}
      </div>
      <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
        <dt className="text-muted-foreground">{t("forge.author")}</dt>
        <dd className="min-w-0 truncate">{issue.author}</dd>
        <dt className="text-muted-foreground">{t("forge.updatedAt")}</dt>
        <dd className="min-w-0 truncate">{when(issue.updatedAtMs, locale)}</dd>
        <dt className="text-muted-foreground">{t("forge.comments")}</dt>
        <dd className="tabular-nums">{issue.commentCount}</dd>
      </dl>
      {issue.body && (
        <p className="min-w-0 text-[13px] leading-5 break-words whitespace-pre-wrap select-text">
          {issue.body}
        </p>
      )}
      {action}
    </>
  );
}

/* ------------------------------ pull / MR ------------------------------- */

function PullList({
  repo,
  state,
  locale,
  enabled,
  onOpen,
}: {
  repo: ForgeRepo;
  state: ForgeListState;
  locale: string;
  enabled: boolean;
  onOpen: (number: number) => void;
}) {
  const t = useT();
  const pulls = useInfiniteQuery({
    queryKey: forgeKeys.pulls(repo, state),
    queryFn: ({ pageParam }) => forgePulls(repo, state, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled,
    retry: false,
  });
  if (pulls.isError) return <Failure error={pulls.error} />;
  const items = pulls.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="min-w-0 space-y-2 p-3">
      {pulls.data && items.length === 0 && (
        <p className="text-[12px] text-muted-foreground">{t("forge.empty")}</p>
      )}
      {items.map((pull) => (
        <Row
          key={pull.number}
          slot="forge-pull"
          number={pull.number}
          title={pull.title}
          badges={[
            t(`forge.state.${pull.state}`),
            ...(pull.draft ? [t("forge.draft")] : []),
          ]}
          meta={`${pull.headRef} → ${pull.baseRef} · ${when(pull.updatedAtMs, locale)}`}
          onOpen={() => onOpen(pull.number)}
        />
      ))}
      {pulls.hasNextPage && (
        <Button
          size="sm"
          variant="ghost"
          className="min-h-10"
          disabled={pulls.isFetchingNextPage}
          onClick={() => void pulls.fetchNextPage()}
        >
          {t("forge.more")}
        </Button>
      )}
    </div>
  );
}

function PullDetail({
  forge,
  repo,
  number,
  locale,
  canWrite,
  workspaceId,
  onBack,
}: {
  forge: string;
  repo: ForgeRepo;
  number: number;
  locale: string;
  canWrite: boolean;
  workspaceId: string | null;
  onBack: () => void;
}) {
  const t = useT();
  const pull = useQuery({
    queryKey: forgeKeys.pull(repo, number),
    queryFn: () => forgePull(repo, number),
    retry: false,
  });
  return (
    <div className="min-w-0 space-y-3 p-3" data-slot="forge-pull-detail">
      <Back onBack={onBack} url={pull.data?.url ?? ""} />
      {pull.isError && <Failure error={pull.error} />}
      {pull.data && (
        <PullBody
          forge={forge}
          repo={repo}
          pull={pull.data}
          locale={locale}
          canWrite={canWrite}
          workspaceId={workspaceId}
        />
      )}
    </div>
  );
}

export function PullBody({
  forge,
  repo,
  pull,
  locale,
  canWrite,
  workspaceId = null,
}: {
  forge: string;
  repo: ForgeRepo;
  pull: ForgePull;
  locale: string;
  canWrite: boolean;
  workspaceId?: string | null;
}) {
  const t = useT();
  const client = useQueryClient();
  const options = useQuery({
    queryKey: forgeKeys.mergeOptions(repo),
    queryFn: () => forgeMergeOptions(repo),
    enabled: canWrite && pull.state === "open",
    retry: false,
    staleTime: 60_000,
  });
  // GitLab 按项目设置给（只快进的项目只有 rebase）；问不到时退回平台缺省。
  const methods =
    options.data && options.data.methods.length > 0
      ? options.data.methods
      : mergeMethods(forge);
  const [picked, setPicked] = React.useState<ForgeMergeMethod>("merge");
  const method = methods.includes(picked) ? picked : (methods[0] ?? "merge");
  const setMethod = setPicked;
  /** 确认框问的是哪一种：直接合并，或流水线通过后合并。 */
  const [confirm, setConfirm] = React.useState<"merge" | "auto" | null>(null);
  const train = options.data?.mergeTrain === true;
  // GitLab 等流水线，Gitea 等提交状态检查：同一个动作，叫法不同。
  const autoKey =
    forge === "gitea" ? "forge.autoMergeChecks" : "forge.autoMerge";
  const canAutoMerge =
    options.data?.autoMerge === true && !pull.autoMerge && !pull.draft;
  const files = useQuery({
    queryKey: forgeKeys.files(repo, pull.number),
    queryFn: () => forgePullFiles(repo, pull.number),
    retry: false,
  });
  const checks = useQuery({
    queryKey: forgeKeys.checks(repo, pull.number),
    queryFn: () => forgePullChecks(repo, pull.number),
    retry: false,
  });
  const autoMerge = useMutation({
    mutationFn: () =>
      autoMergeForgePull(repo, pull.number, { method, headSha: pull.headSha }),
    onSuccess: (result) => {
      toast.success(
        t(
          result.merged
            ? "forge.merge.done"
            : result.train
              ? "forge.autoMerge.trainDone"
              : `${autoKey}.done`,
        ),
      );
      void client.invalidateQueries({ queryKey: forgeKeys.all });
    },
    onError: (error) => toast.error(t(forgeFailureKey(error))),
  });
  const cancelAutoMerge = useMutation({
    mutationFn: () => cancelAutoMergeForgePull(repo, pull.number),
    onSuccess: () => {
      toast.success(t("forge.autoMerge.cancelled"));
      void client.invalidateQueries({ queryKey: forgeKeys.all });
    },
    onError: (error) => toast.error(t(forgeFailureKey(error))),
  });
  const merge = useMutation({
    mutationFn: () =>
      mergeForgePull(repo, pull.number, { method, headSha: pull.headSha }),
    onSuccess: () => {
      toast.success(t("forge.merge.done"));
      void client.invalidateQueries({ queryKey: forgeKeys.all });
    },
    onError: (error) => {
      // 变基已发出：不是失败，等新的 head 出来、核对后再合。
      if (forgeFailure(error) === "rebaseStarted") {
        toast.message(t(forgeFailureKey(error)));
        void client.invalidateQueries({ queryKey: forgeKeys.all });
        return;
      }
      toast.error(t(forgeFailureKey(error)));
    },
  });

  return (
    <>
      <h3 className="min-w-0 text-[14px] font-semibold break-words">
        <span className="mr-2 tabular-nums text-muted-foreground">
          #{pull.number}
        </span>
        {pull.title}
      </h3>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant="secondary">{t(`forge.state.${pull.state}`)}</Badge>
        {pull.draft && <Badge variant="outline">{t("forge.draft")}</Badge>}
        {pull.autoMerge && (
          <Badge variant="outline">{t("forge.autoMerge.set")}</Badge>
        )}
        {checks.data && checks.data.rollup !== "none" && (
          <Badge
            data-slot="forge-rollup"
            data-rollup={checks.data.rollup}
            variant={
              checks.data.rollup === "failure" ? "destructive" : "outline"
            }
          >
            {t(`forge.rollup.${checks.data.rollup}`)}
          </Badge>
        )}
        {pull.state === "open" && (
          <Badge
            variant={
              pull.mergeable === "conflicting" ? "destructive" : "outline"
            }
          >
            {t(`forge.mergeable.${pull.mergeable}`)}
          </Badge>
        )}
      </div>
      <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
        <dt className="text-muted-foreground">{t("forge.pull.base")}</dt>
        <dd className="min-w-0 truncate">{pull.baseRef}</dd>
        <dt className="text-muted-foreground">{t("forge.pull.head")}</dt>
        <dd className="min-w-0 truncate">{pull.headRef}</dd>
        <dt className="text-muted-foreground">{t("forge.pull.headSha")}</dt>
        <dd className="min-w-0 truncate font-mono" title={pull.headSha}>
          {shortSha(pull.headSha)}
        </dd>
        <dt className="text-muted-foreground">{t("forge.author")}</dt>
        <dd className="min-w-0 truncate">{pull.author}</dd>
        <dt className="text-muted-foreground">{t("forge.updatedAt")}</dt>
        <dd className="min-w-0 truncate">{when(pull.updatedAtMs, locale)}</dd>
      </dl>
      {pull.body && (
        <p className="min-w-0 text-[13px] leading-5 break-words whitespace-pre-wrap select-text">
          {pull.body}
        </p>
      )}

      <section className="min-w-0 space-y-2" data-slot="forge-checks">
        <h4 className="text-[12px] font-semibold">{t("forge.checks")}</h4>
        {checks.isError && <Failure error={checks.error} />}
        {checks.data && checks.data.checks.length === 0 && (
          <p className="text-[12px] text-muted-foreground">
            {t("forge.checks.none")}
          </p>
        )}
        {checks.data?.checks.map((check) => (
          <div
            key={check.name}
            className="flex min-w-0 items-center gap-2 text-[12px]"
          >
            <span className="min-w-0 flex-1 truncate">{check.name}</span>
            <Badge
              variant={check.state === "failure" ? "destructive" : "outline"}
            >
              {t(`forge.check.${check.state}`)}
            </Badge>
            {check.url && <OpenRemote url={check.url} />}
          </div>
        ))}
      </section>

      <section className="min-w-0 space-y-2" data-slot="forge-files">
        <h4 className="text-[12px] font-semibold">{t("forge.files")}</h4>
        {files.isError && <Failure error={files.error} />}
        {files.data?.map((file) => (
          <details
            key={`${file.previousPath ?? ""}>${file.path}`}
            className="min-w-0 rounded-md border border-border"
          >
            <summary className="flex min-h-9 min-w-0 cursor-pointer items-center gap-2 px-2 text-[12px]">
              <span className="min-w-0 flex-1 truncate font-mono">
                {file.previousPath
                  ? `${file.previousPath} → ${file.path}`
                  : file.path}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                +{file.additions} −{file.deletions}
              </span>
            </summary>
            {file.patch ? (
              <pre className="max-h-80 overflow-auto border-t border-border p-2 font-mono text-[11px] leading-4 select-text">
                {file.patch}
              </pre>
            ) : (
              <p className="border-t border-border p-2 text-[12px] text-muted-foreground">
                {t("forge.files.binary")}
              </p>
            )}
          </details>
        ))}
      </section>

      {canWrite && pull.state === "open" && (
        <section
          className="flex min-w-0 flex-wrap items-end gap-2"
          data-slot="forge-merge"
        >
          <Field label={t("forge.merge.method")}>
            <Select
              value={method}
              onValueChange={(next) => setMethod(next as ForgeMergeMethod)}
            >
              <SelectTrigger className="h-9 w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
                {methods.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`forge.merge.method.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Button
            size="sm"
            className="min-h-10"
            disabled={merge.isPending || autoMerge.isPending || !pull.headSha}
            onClick={() => setConfirm("merge")}
          >
            {t("forge.merge")} · {shortSha(pull.headSha)}
          </Button>
          {canAutoMerge && (
            <Button
              size="sm"
              variant="secondary"
              className="min-h-10"
              disabled={merge.isPending || autoMerge.isPending || !pull.headSha}
              onClick={() => setConfirm("auto")}
            >
              {t(train ? "forge.autoMerge.train" : autoKey)}
            </Button>
          )}
          {pull.autoMerge && (
            <Button
              size="sm"
              variant="ghost"
              className="min-h-10"
              disabled={cancelAutoMerge.isPending}
              onClick={() => cancelAutoMerge.mutate()}
            >
              {t("forge.autoMerge.cancel")}
            </Button>
          )}
        </section>
      )}

      {workspaceId && (
        <CheckoutWorktree
          workspaceId={workspaceId}
          pull={{
            ...pull,
            forge: forge === "gitlab" ? "gitlab" : "gitea",
            baseRepository: repo,
          }}
          busy={merge.isPending}
        />
      )}

      {workspaceId && (
        <MergeCleanupView
          workspaceId={workspaceId}
          pull={{
            headRef: pull.headRef,
            headSha: pull.headSha,
            fromFork: pull.fromFork,
            merged: pull.state === "merged",
          }}
          canWrite={canWrite}
          busy={false}
          failureKey={forgeFailureKey}
          deleteBranch={() =>
            deleteForgeBranch(repo, pull.number, pull.headSha)
          }
          onBranchDeleted={() =>
            void client.invalidateQueries({ queryKey: forgeKeys.all })
          }
        />
      )}

      <ResponsiveAlertDialog
        open={confirm !== null}
        onOpenChange={(next) => {
          if (!next) setConfirm(null);
        }}
      >
        <ResponsiveAlertDialogContent className="z-[var(--z-dialog)]">
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t(
                confirm === "auto"
                  ? train
                    ? "forge.autoMerge.confirmTrain"
                    : `${autoKey}.confirm`
                  : "forge.merge.confirm",
              )}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
            <dt className="text-muted-foreground">{t("forge.pull.base")}</dt>
            <dd className="min-w-0 truncate">{pull.baseRef}</dd>
            <dt className="text-muted-foreground">{t("forge.pull.headSha")}</dt>
            <dd className="min-w-0 break-all font-mono select-text">
              {pull.headSha}
            </dd>
            <dt className="text-muted-foreground">{t("forge.merge.method")}</dt>
            <dd>{t(`forge.merge.method.${method}`)}</dd>
          </dl>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel className="min-h-10">
              {t("forge.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              className="min-h-10"
              disabled={merge.isPending || autoMerge.isPending}
              onClick={() => {
                const which = confirm;
                setConfirm(null);
                if (which === "auto") autoMerge.mutate();
                else merge.mutate();
              }}
            >
              {t(
                confirm === "auto"
                  ? train
                    ? "forge.autoMerge.train"
                    : autoKey
                  : "forge.merge",
              )}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </>
  );
}

function CreatePull({
  repo,
  onCreated,
}: {
  repo: ForgeRepo;
  onCreated: (number: number) => void;
}) {
  const t = useT();
  const client = useQueryClient();
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [head, setHead] = React.useState("");
  const [base, setBase] = React.useState("");
  const [draft, setDraft] = React.useState(false);
  const create = useMutation({
    mutationFn: () =>
      createForgePull(repo, {
        title: title.trim(),
        body,
        head: head.trim(),
        base: base.trim(),
        draft,
      }),
    onSuccess: (pull) => {
      toast.success(t("forge.created"));
      setTitle("");
      setBody("");
      void client.invalidateQueries({ queryKey: ["forge", "pulls"] });
      onCreated(pull.number);
    },
    onError: (error) => toast.error(t(forgeFailureKey(error))),
  });
  const ready = title.trim() && head.trim() && base.trim();
  return (
    <details
      className="min-w-0 border-t border-border"
      data-slot="forge-create"
    >
      <summary className="flex min-h-10 cursor-pointer items-center px-3 text-[12px] font-medium">
        {t("forge.create")}
      </summary>
      <form
        className="flex min-w-0 flex-col gap-2 p-3 pt-0"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !create.isPending) create.mutate();
        }}
      >
        <Field label={t("forge.create.title")}>
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="h-9 min-w-0"
          />
        </Field>
        <div className="grid min-w-0 grid-cols-2 gap-2">
          <Field label={t("forge.pull.head")}>
            <Input
              value={head}
              spellCheck={false}
              onChange={(event) => setHead(event.target.value)}
              className="h-9 min-w-0 font-mono"
            />
          </Field>
          <Field label={t("forge.pull.base")}>
            <Input
              value={base}
              spellCheck={false}
              onChange={(event) => setBase(event.target.value)}
              className="h-9 min-w-0 font-mono"
            />
          </Field>
        </div>
        <Field label={t("forge.create.body")}>
          <Textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className="min-h-20 min-w-0"
          />
        </Field>
        <Check label={t("forge.draft")} checked={draft} onChange={setDraft} />
        <Button
          type="submit"
          size="sm"
          className="min-h-10 self-start"
          disabled={!ready || create.isPending}
        >
          {t("forge.create.submit")}
        </Button>
      </form>
    </details>
  );
}
