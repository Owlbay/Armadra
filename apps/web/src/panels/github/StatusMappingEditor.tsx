import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";

import { Button } from "@/ui/button";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@/panels/ResponsiveDialog";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { useT } from "@/app/preferences-store";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Field } from "../git/forms";

/** Radix 的选项值不能是空串，「无」用这个占位值换算回空串。 */
const NONE = "__none__";
import { failureKey } from "./model";
import {
  MAPPING_REASONS,
  MAX_STATUS_GROUPS,
  draftFromMapping,
  draftProblems,
  emptyGroup,
  mappingFromDraft,
  mappingReasonKey,
  statusSourceKey,
  type StatusGroupDraft,
  type StatusMappingDraft,
} from "./mapping";
import { githubKeys } from "./queries";
import {
  GithubApi,
  GithubApiError,
  GithubIssueState,
  GithubRepositoryRef,
  GithubStatusMapping,
  GithubStatusSource,
} from "../../api/github";

export interface StatusMappingEditorProps {
  client: GithubApi;
  repository: GithubRepositoryRef;
  /** The mapping that was read; its revision is what the save is made against. */
  mapping: GithubStatusMapping | undefined;
  canWrite: boolean;
}

/**
 * Configuring how one repository's Issues are grouped (Git/GitHub design §7.2).
 *
 * A repository has exactly one primary source, so the source is a choice, not a
 * set of checkboxes: switching it hides the fields that belong to the other one
 * rather than sending both. The save carries the revision that was read, so a
 * configuration changed elsewhere is refused instead of silently overwritten.
 *
 * A read-only device sees the whole configuration and no save control — the
 * Host would refuse the write, and a button that always fails is worse than
 * saying plainly that this device cannot write.
 */
export function StatusMappingEditor({
  client,
  repository,
  mapping,
  canWrite,
}: StatusMappingEditorProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<StatusMappingDraft>(() =>
    draftFromMapping(mapping),
  );
  const [problems, setProblems] = React.useState<string[]>([]);
  const [refused, setRefused] = React.useState(false);

  // The dialog always opens on what the Host last said, never on a half-edited
  // draft from a previous visit.
  function reset(next: boolean) {
    setOpen(next);
    if (next) {
      setDraft(draftFromMapping(mapping));
      setProblems([]);
      setRefused(false);
    }
  }

  const save = useMutation({
    mutationFn: () =>
      client.putStatusMapping({
        mapping: mappingFromDraft(draft, repository),
        expectedRevision: mapping?.revision ?? 0n,
      }),
    onSuccess: () => {
      toast.success(t("github.mapping.saved"));
      void queryClient.invalidateQueries({ queryKey: githubKeys.all });
      setOpen(false);
    },
    onError: (error: unknown) => {
      // The reason codes belong to a refused configuration only. A network or
      // permission failure is not a configuration mistake, so the list stays
      // out of the way rather than sending the reader hunting for a typo.
      setRefused(
        error instanceof GithubApiError && error.failure === "invalid",
      );
      toast.error(t(failureKey(error)));
    },
  });

  const patchGroup = (index: number, patch: Partial<StatusGroupDraft>) =>
    setDraft((current) => ({
      ...current,
      groups: current.groups.map((group, position) =>
        position === index ? { ...group, ...patch } : group,
      ),
    }));

  const label = draft.source === GithubStatusSource.LABEL;
  const project = draft.source === GithubStatusSource.PROJECT_FIELD;
  const none = draft.source === GithubStatusSource.NONE;

  return (
    <ResponsiveDialog open={open} onOpenChange={reset}>
      <ResponsiveDialogTrigger asChild>
        <Button size="sm" variant="outline" className="min-h-10">
          {t("github.mapping.configure")}
        </Button>
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent className="z-[var(--z-dialog)] max-h-[85dvh] max-w-[560px] overflow-y-auto">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t("github.mapping.title")}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {t("github.mapping.note")}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        {!canWrite && (
          <p role="status" className="text-[12px] text-muted-foreground">
            {t("github.mapping.readOnly")}
          </p>
        )}

        <form
          className="min-w-0 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canWrite || save.isPending) return;
            const found = draftProblems(draft);
            setProblems(found);
            setRefused(false);
            if (found.length > 0) return;
            save.mutate();
          }}
        >
          <Field label={t("github.mapping.source")}>
            <Select
              value={String(draft.source)}
              disabled={!canWrite}
              onValueChange={(next) =>
                setDraft((current) => ({
                  ...current,
                  source: next as GithubStatusSource,
                }))
              }
            >
              <SelectTrigger className="h-9 w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
                {[
                  GithubStatusSource.NONE,
                  GithubStatusSource.LABEL,
                  GithubStatusSource.PROJECT_FIELD,
                ].map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    {t(statusSourceKey(value))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {project && (
            <>
              <Field label={t("github.mapping.projectId")}>
                <Input
                  value={draft.projectId}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!canWrite}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      projectId: event.target.value,
                    }))
                  }
                  className="h-9 min-w-0"
                />
              </Field>
              <Field label={t("github.mapping.projectFieldId")}>
                <Input
                  value={draft.projectFieldId}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!canWrite}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      projectFieldId: event.target.value,
                    }))
                  }
                  className="h-9 min-w-0"
                />
              </Field>
            </>
          )}

          {none ? (
            <p className="text-[12px] text-muted-foreground">
              {t("github.mapping.noneNote")}
            </p>
          ) : (
            <section className="min-w-0 space-y-2">
              <h4 className="text-[12px] font-medium text-muted-foreground">
                {t("github.mapping.groups")}
              </h4>
              {draft.groups.length === 0 && (
                <p className="text-[12px] text-muted-foreground">
                  {t("github.mapping.noGroups")}
                </p>
              )}
              {draft.groups.map((group, index) => (
                <fieldset
                  key={index}
                  data-slot="github-mapping-group"
                  className="min-w-0 space-y-2 rounded-md border border-border p-3"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="flex-1 text-[12px] text-muted-foreground">
                      {group.title || group.id}
                    </span>
                    {canWrite && (
                      <IconButton
                        type="button"
                        label={t("github.mapping.removeGroup")}
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            groups: current.groups.filter(
                              (_, position) => position !== index,
                            ),
                          }))
                        }
                      >
                        <Trash2 />
                      </IconButton>
                    )}
                  </div>
                  <Field label={t("github.mapping.groupId")}>
                    <Input
                      value={group.id}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={!canWrite}
                      onChange={(event) =>
                        patchGroup(index, { id: event.target.value })
                      }
                      className="h-9 min-w-0"
                    />
                  </Field>
                  <Field label={t("github.mapping.groupTitle")}>
                    <Input
                      value={group.title}
                      disabled={!canWrite}
                      onChange={(event) =>
                        patchGroup(index, { title: event.target.value })
                      }
                      className="h-9 min-w-0"
                    />
                  </Field>
                  {label && (
                    <Field label={t("github.mapping.groupLabel")}>
                      <Input
                        value={group.label}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={!canWrite}
                        onChange={(event) =>
                          patchGroup(index, { label: event.target.value })
                        }
                        className="h-9 min-w-0"
                      />
                    </Field>
                  )}
                  {project && (
                    <Field label={t("github.mapping.groupOption")}>
                      <Input
                        value={group.optionId}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={!canWrite}
                        onChange={(event) =>
                          patchGroup(index, { optionId: event.target.value })
                        }
                        className="h-9 min-w-0"
                      />
                    </Field>
                  )}
                  <Field label={t("github.mapping.couplesState")}>
                    <Select
                      value={String(group.couplesState)}
                      disabled={!canWrite}
                      onValueChange={(next) =>
                        patchGroup(index, {
                          couplesState: next as GithubIssueState,
                        })
                      }
                    >
                      <SelectTrigger className="h-9 w-full min-w-0">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="z-[var(--z-dialog)]">
                        <SelectItem
                          value={String(GithubIssueState.UNSPECIFIED)}
                        >
                          {t("github.mapping.stateNone")}
                        </SelectItem>
                        <SelectItem value={String(GithubIssueState.OPEN)}>
                          {t("github.issueState.open")}
                        </SelectItem>
                        <SelectItem value={String(GithubIssueState.CLOSED)}>
                          {t("github.issueState.closed")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </fieldset>
              ))}
              {canWrite && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-10"
                  disabled={draft.groups.length >= MAX_STATUS_GROUPS}
                  title={
                    draft.groups.length >= MAX_STATUS_GROUPS
                      ? t("github.mapping.limit")
                      : undefined
                  }
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      groups: [
                        ...current.groups,
                        emptyGroup(current.groups.length + 1),
                      ],
                    }))
                  }
                >
                  {t("github.mapping.addGroup")}
                </Button>
              )}
            </section>
          )}

          {!none && (
            <section className="min-w-0 space-y-2">
              <h4 className="text-[12px] font-medium text-muted-foreground">
                {t("github.mapping.stateGroups")}
              </h4>
              <p className="text-[11px] text-muted-foreground">
                {t("github.mapping.stateGroupsNote")}
              </p>
              {(
                [
                  ["github.mapping.stateOpen", "openGroupId"],
                  ["github.mapping.stateClosed", "closedGroupId"],
                ] as const
              ).map(([key, field]) => (
                <Field key={field} label={t(key)}>
                  <Select
                    value={draft[field] === "" ? NONE : draft[field]}
                    disabled={!canWrite}
                    onValueChange={(next) =>
                      setDraft((current) => ({
                        ...current,
                        [field]: next === NONE ? "" : next,
                      }))
                    }
                  >
                    <SelectTrigger className="h-9 w-full min-w-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="z-[var(--z-dialog)]">
                      <SelectItem value={NONE}>
                        {t("github.mapping.groupNone")}
                      </SelectItem>
                      {draft.groups.map((group) => (
                        <SelectItem key={group.id} value={group.id}>
                          {group.title || group.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ))}
            </section>
          )}

          {problems.length > 0 && (
            <ul role="alert" className="space-y-1 text-[12px] text-destructive">
              {problems.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
          )}

          {refused && (
            <section role="status" className="min-w-0 space-y-1">
              <p className="text-[12px] text-destructive">
                {t("github.mapping.refused")}
              </p>
              <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
                {MAPPING_REASONS.map((code) => (
                  <React.Fragment key={code}>
                    <dt className="font-mono text-muted-foreground select-text">
                      {code}
                    </dt>
                    <dd className="min-w-0 break-words">
                      {t(mappingReasonKey(code))}
                    </dd>
                  </React.Fragment>
                ))}
              </dl>
            </section>
          )}

          <ResponsiveDialogFooter>
            {canWrite && (
              <Button
                type="submit"
                size="sm"
                className="min-h-10"
                disabled={save.isPending}
              >
                {t("github.mapping.save")}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-10"
              onClick={() => setOpen(false)}
            >
              {t("github.cancel")}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
