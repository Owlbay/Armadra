import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Gitea / GitLab 那一面（契约 §29.4、§29.6）单独渲染：项目的合并方式与变基、
 * 流水线通过后合并与合并列车、CI 汇总徽标、检出与合并后清理。经抽屉认平台
 * 的那几条在 `GithubDrawer.test.tsx`。
 */

const store = vi.hoisted(() => ({
  panels: { github: "drawer" as "drawer" | "closed" },
  workspace: { id: "workspace-1", rootPath: "/tmp" },
  document: { nodes: [] as unknown[] },
  setPanel: vi.fn(),
}));

const toasts = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  message: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: toasts }));

vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

const forgeApi = vi.hoisted(() => ({
  forgeIssues: vi.fn(),
  forgePulls: vi.fn(),
  forgePull: vi.fn(),
  forgePullFiles: vi.fn(),
  forgePullChecks: vi.fn(),
  mergeForgePull: vi.fn(),
  forgeMergeOptions: vi.fn(),
  autoMergeForgePull: vi.fn(),
  cancelAutoMergeForgePull: vi.fn(),
  deleteForgeBranch: vi.fn(),
}));

vi.mock("../../api/forge", async (original) => ({
  ...(await original<typeof import("../../api/forge")>()),
  ...forgeApi,
}));

vi.mock("@/api/client", () => ({
  runtimeApi: {
    gitRepositoryBranches: vi.fn(async () => ({
      repositoryId: "repo",
      repositoryPath: ".",
      head: { headOid: "a".repeat(40), branch: "main" },
      branches: [],
      remotes: ["origin"],
      observedAt: "2026-09-06T00:00:00Z",
    })),
    gitRepositoryOperate: vi.fn(async () => ({ id: "operation-1" })),
    gitRepositoryWorktrees: vi.fn(async () => []),
  },
}));

import { RuntimeRequestError } from "@/api/request";
import type { ForgePull } from "../../api/forge";
import { usePreferencesStore } from "../../app/preferences-store";
import { ForgeHosted } from "./ForgeHosted";

const MR_SHA = "d".repeat(40);

const forgePull = (number: number, title: string): ForgePull => ({
  number,
  title,
  body: "",
  state: "open",
  draft: false,
  author: "alice",
  baseRef: "main",
  headRef: "feature/login",
  headSha: MR_SHA,
  mergeable: "mergeable",
  url: `https://git.example.test/acme/app/-/merge_requests/${number}`,
  createdAtMs: 1_788_557_900_000,
  updatedAtMs: 1_788_557_900_000,
  mergedAtMs: null,
  autoMerge: false,
  fromFork: false,
});

const DETECTION = {
  repository: { host: "git.example.test", owner: "acme", name: "app" },
  forge: "gitlab" as const,
  source: "config" as const,
  configKey: "git.example.test",
  apiBase: "https://git.example.test/api/v4",
  webUrl: "https://git.example.test/acme/app",
  credential: true,
  accountLogin: "bot",
};

function renderHosted() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ForgeHosted
        detection={DETECTION}
        locale="zh-CN"
        canWrite
        open
        workspaceId="workspace-1"
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  for (const fn of Object.values(forgeApi)) fn.mockReset();
  for (const fn of Object.values(toasts)) fn.mockClear();
});
afterEach(cleanup);

describe("GitLab merge request detail (§29.6)", () => {
  it("GitLab: offers the project's own merge methods; a started rebase is not a failure", async () => {
    forgeApi.forgePulls.mockResolvedValue({
      items: [forgePull(12, "Login rework")],
      nextCursor: null,
    });
    forgeApi.forgePull.mockResolvedValue(forgePull(12, "Login rework"));
    forgeApi.forgePullFiles.mockResolvedValue([]);
    forgeApi.forgePullChecks.mockResolvedValue({
      headSha: MR_SHA,
      rollup: "none",
      checks: [],
    });
    forgeApi.forgeMergeOptions.mockResolvedValue({
      methods: ["rebase"],
      autoMerge: false,
      mergeTrain: false,
    });
    forgeApi.mergeForgePull.mockRejectedValue(
      new RuntimeRequestError(409, "已开始变基", "rebase_started"),
    );
    renderHosted();
    fireEvent.click(await screen.findByText("Login rework"));
    await waitFor(() => {
      const select = document.querySelector(
        "[data-slot=forge-merge] select",
      ) as HTMLSelectElement | null;
      expect(
        [...(select?.options ?? [])].map((option) => option.value),
      ).toEqual(["rebase"]);
    });
    fireEvent.click(screen.getByText(/^合并 · /));
    fireEvent.click(await screen.findByRole("button", { name: "合并" }));
    await waitFor(() =>
      expect(forgeApi.mergeForgePull).toHaveBeenCalledWith(
        { host: "git.example.test", owner: "acme", name: "app" },
        12,
        { method: "rebase", headSha: MR_SHA },
      ),
    );
    await waitFor(() =>
      expect(toasts.message).toHaveBeenCalledWith(
        "已开始变基，没有合并；等新的 head 出来再核对",
      ),
    );
    expect(toasts.error).not.toHaveBeenCalled();
  });

  async function openGitlabPull(
    options: { autoMerge: boolean; mergeTrain: boolean },
    pull = forgePull(12, "Login rework"),
  ) {
    forgeApi.forgePulls.mockResolvedValue({ items: [pull], nextCursor: null });
    forgeApi.forgePull.mockResolvedValue(pull);
    forgeApi.forgePullFiles.mockResolvedValue([]);
    forgeApi.forgePullChecks.mockResolvedValue({
      headSha: MR_SHA,
      rollup: "pending",
      checks: [{ name: "build", state: "pending", url: null }],
    });
    forgeApi.forgeMergeOptions.mockResolvedValue({
      methods: ["merge", "squash"],
      ...options,
    });
    renderHosted();
    fireEvent.click(await screen.findByText(pull.title));
  }

  it("GitLab: merge when the pipeline succeeds, against the head on screen", async () => {
    forgeApi.autoMergeForgePull.mockResolvedValue({
      merged: false,
      sha: null,
      train: false,
    });
    await openGitlabPull({ autoMerge: true, mergeTrain: false });
    fireEvent.click(
      await screen.findByRole("button", { name: "流水线通过后合并" }),
    );
    expect(await screen.findByText("流水线通过后合并这个请求？")).toBeTruthy();
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(
      [...dialog.querySelectorAll("button")].find(
        (button) => button.textContent === "流水线通过后合并",
      )!,
    );
    await waitFor(() =>
      expect(forgeApi.autoMergeForgePull).toHaveBeenCalledWith(
        { host: "git.example.test", owner: "acme", name: "app" },
        12,
        { method: "merge", headSha: MR_SHA },
      ),
    );
    expect(forgeApi.mergeForgePull).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith("已设为流水线通过后合并"),
    );
  });

  it("GitLab: a merge train project says so; a queued request offers cancel instead", async () => {
    await openGitlabPull({ autoMerge: true, mergeTrain: true });
    expect(
      await screen.findByRole("button", { name: "加入合并列车" }),
    ).toBeTruthy();
    cleanup();

    forgeApi.cancelAutoMergeForgePull.mockResolvedValue(undefined);
    await openGitlabPull(
      { autoMerge: true, mergeTrain: false },
      { ...forgePull(13, "Queued change"), autoMerge: true },
    );
    expect(await screen.findByText("已设自动合并")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "流水线通过后合并" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消自动合并" }));
    await waitFor(() =>
      expect(forgeApi.cancelAutoMergeForgePull).toHaveBeenCalledWith(
        { host: "git.example.test", owner: "acme", name: "app" },
        13,
      ),
    );
  });

  it("Gitea / GitLab: maps the CI rollup to a badge and offers a checkout", async () => {
    await openGitlabPull({ autoMerge: false, mergeTrain: false });
    const rollup = await screen.findByText("CI 进行中");
    expect(rollup.getAttribute("data-rollup")).toBe("pending");
    expect(await screen.findByText("检出到 worktree")).toBeTruthy();
    const branch = screen.getByLabelText("本地分支") as HTMLInputElement;
    expect(branch.value).toBe("feature/login");
    // 还没合并：没有清理。
    expect(document.querySelector('[data-slot="github-cleanup"]')).toBeNull();
  });

  it("Gitea / GitLab: deletes the merged branch under the head on screen, after a confirmation", async () => {
    forgeApi.deleteForgeBranch.mockResolvedValueOnce({
      deleted: false,
      reasonCode: "BRANCH_MOVED",
    });
    forgeApi.deleteForgeBranch.mockResolvedValueOnce({
      deleted: true,
      reasonCode: "",
    });
    await openGitlabPull(
      { autoMerge: true, mergeTrain: false },
      {
        ...forgePull(14, "Merged change"),
        state: "merged" as const,
        mergedAtMs: 1_788_557_900_000,
      },
    );
    // 已合并：没有合并与自动合并的按钮。
    expect(
      screen.queryByRole("button", { name: "流水线通过后合并" }),
    ).toBeNull();
    fireEvent.click(await screen.findByText("删除远端分支 · feature/login"));
    expect(await screen.findByText("删除远端分支？")).toBeTruthy();
    expect(forgeApi.deleteForgeBranch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("确认"));
    await waitFor(() =>
      expect(forgeApi.deleteForgeBranch).toHaveBeenCalledWith(
        { host: "git.example.test", owner: "acme", name: "app" },
        14,
        MR_SHA,
      ),
    );
    expect(await screen.findByText(/BRANCH_MOVED/)).toBeTruthy();
    fireEvent.click(screen.getByText("删除远端分支 · feature/login"));
    fireEvent.click(await screen.findByText("确认"));
    expect(await screen.findByText("远端分支已删除")).toBeTruthy();
  });

  it("Gitea / GitLab: a fork's branch is never offered for deletion", async () => {
    await openGitlabPull(
      { autoMerge: false, mergeTrain: false },
      {
        ...forgePull(15, "Fork change"),
        state: "merged" as const,
        fromFork: true,
      },
    );
    expect(
      await screen.findByText("head 分支在 fork 仓库里，这里不提供删除。"),
    ).toBeTruthy();
    expect(screen.queryByText(/^删除远端分支 · /)).toBeNull();
    // fork 的 head 名不沿用为本地分支名。
    expect((screen.getByLabelText("本地分支") as HTMLInputElement).value).toBe(
      "pr-15",
    );
  });
});
