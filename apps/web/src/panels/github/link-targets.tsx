import { useQuery } from "@tanstack/react-query";

import { gitGateway } from "@/git/gateway";
import { useGitTarget } from "@/git/target";
import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { sk } from "../../sources/scope";
import {
  GithubApi,
  GithubApiError,
  GithubReferenceKind,
  GithubReferenceTargetKind,
  GithubRepositoryRef,
  githubExternalReference,
} from "../../api/github";

/**
 * What an Issue or pull request can be linked to (Git/GitHub design §7.1).
 *
 * Sessions come from the board this page belongs to, branches and worktrees
 * from the Runtime listings the Git panel already reads — there is no second
 * worktree listing here. A target is only ever what the user picked from those
 * lists: nothing is linked implicitly, and a link never changes either side.
 */

export interface LinkTarget {
  kind: GithubReferenceTargetKind;
  id: string;
}

/** `session:<node id>` / `branch:<name>` / `worktree:<path>`. */
export function parseTarget(value: string): LinkTarget | null {
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const id = value.slice(separator + 1);
  if (!id.trim()) return null;
  switch (value.slice(0, separator)) {
    case "session":
      return { kind: GithubReferenceTargetKind.SESSION, id };
    case "branch":
      return { kind: GithubReferenceTargetKind.BRANCH, id };
    case "worktree":
      return { kind: GithubReferenceTargetKind.WORKTREE, id };
    default:
      return null;
  }
}

export function targetKindKey(kind: GithubReferenceTargetKind): string {
  switch (kind) {
    case GithubReferenceTargetKind.SESSION:
      return "github.link.session";
    case GithubReferenceTargetKind.BRANCH:
      return "github.link.branch";
    case GithubReferenceTargetKind.WORKTREE:
      return "github.link.worktree";
    default:
      return "github.link.unknownTarget";
  }
}

export interface TargetOption {
  value: string;
  label: string;
}

export interface LinkTargets {
  sessions: TargetOption[];
  branches: TargetOption[];
  worktrees: TargetOption[];
  empty: boolean;
}

/**
 * The targets this workspace offers right now.
 *
 * A listing that cannot be read contributes nothing rather than an entry the
 * link would fail on; the select simply has one group fewer.
 */
export function useLinkTargets(workspaceId: string): LinkTargets {
  const nodes = useCanvasStore((state) => state.document?.nodes);
  const target = useGitTarget(workspaceId, ".");
  const branches = useQuery({
    queryKey: sk("git-repository-branches", workspaceId),
    queryFn: ({ signal }) => gitGateway.branches(target, signal),
    enabled: workspaceId.length > 0,
    retry: false,
  });
  const worktrees = useQuery({
    queryKey: sk("git-repository-worktrees", workspaceId),
    queryFn: ({ signal }) => gitGateway.worktrees(target, signal),
    enabled: workspaceId.length > 0,
    retry: false,
  });
  const sessions = (nodes ?? [])
    .filter((node) => node.type === "terminal")
    .map((node) => ({ value: `session:${node.id}`, label: node.title }));
  const branchOptions = (branches.data?.branches ?? [])
    .filter((branch) => !branch.remote)
    .map((branch) => ({ value: `branch:${branch.name}`, label: branch.name }));
  const worktreeOptions = (worktrees.data ?? []).map((worktree) => ({
    value: `worktree:${worktree.path}`,
    label: worktree.branch
      ? `${worktree.path} · ${worktree.branch}`
      : worktree.path,
  }));
  return {
    sessions,
    branches: branchOptions,
    worktrees: worktreeOptions,
    empty:
      sessions.length + branchOptions.length + worktreeOptions.length === 0,
  };
}

/** Radix 的选项值不能是空串，「未选」用这个占位值换算回空串。 */
const NONE = "__none__";

/** One select over every target kind; the empty value means "nothing chosen". */
export function TargetSelect({
  value,
  targets,
  disabled,
  onChange,
}: {
  value: string;
  targets: LinkTargets;
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  const t = useT();
  return (
    <Select
      value={value === "" ? NONE : value}
      disabled={disabled}
      onValueChange={(next) => onChange(next === NONE ? "" : next)}
    >
      <SelectTrigger
        className="h-9 w-full min-w-0"
        aria-label={t("github.link.target")}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="z-[var(--z-dialog)]">
        <SelectItem value={NONE}>{t("github.link.choose")}</SelectItem>
        {(
          [
            ["github.link.sessions", targets.sessions],
            ["github.link.branches", targets.branches],
            ["github.link.worktrees", targets.worktrees],
          ] as const
        ).map(([key, options]) =>
          options.length === 0 ? null : (
            <SelectGroup key={key}>
              <SelectLabel>{t(key)}</SelectLabel>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ),
        )}
      </SelectContent>
    </Select>
  );
}

/**
 * Records one link, reporting an existing one as such.
 *
 * The Host derives a reference's identity from what the link means, so linking
 * the same pair twice is the same record and comes back as a conflict. That is
 * not a mistake to repair — the link the user asked for already exists — so it
 * is reported as "already linked" rather than as a failure.
 */
export async function linkReferenceTo(
  client: GithubApi,
  input: {
    repository: GithubRepositoryRef;
    kind: GithubReferenceKind;
    number: bigint;
    /** The remote title, so the badge reads correctly offline. */
    title: string;
    target: LinkTarget;
  },
): Promise<"linked" | "already"> {
  try {
    await client.linkReference({
      reference: githubExternalReference({
        repository: input.repository,
        kind: input.kind,
        number: input.number,
        targetKind: input.target.kind,
        targetId: input.target.id,
        title: input.title,
      }),
      expectedRevision: 0n,
    });
    return "linked";
  } catch (error) {
    if (error instanceof GithubApiError && error.failure === "conflict")
      return "already";
    throw error;
  }
}
