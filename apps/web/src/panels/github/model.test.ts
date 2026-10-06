import { describe, expect, it } from "vitest";

import {
  MAX_POLL_MS,
  MIN_POLL_MS,
  failureKey,
  groupIssues,
  mergeReasonKey,
  pollInterval,
  remoteForRepository,
  suggestedHeadRef,
} from "./model";
import {
  GithubApiError,
  githubIssue,
  githubPullRequest,
  githubStatusGroup,
  githubStatusMapping,
} from "../../api/github";

const repository = {
  owner: "armadra",
  name: "armadra",
  apiBase: "https://api.github.com",
  host: "github.com",
};

function issue(number: number, statusGroupId = "") {
  return githubIssue({
    repository,
    number: BigInt(number),
    title: `issue ${number}`,
    statusGroupId,
    updatedAtUnixMs: 1_788_000_000_000n,
  });
}

const mapping = githubStatusMapping({
  repository,
  revision: 4n,
  groups: [
    githubStatusGroup({ id: "todo", title: "Todo" }),
    githubStatusGroup({ id: "done", title: "Done" }),
  ],
});

describe("status groups", () => {
  it("keeps the configured order and pushes the rest into one unmapped pile", () => {
    const groups = groupIssues(
      [issue(1, "done"), issue(2), issue(3, "todo"), issue(4, "gone")],
      mapping,
    );
    expect(groups.map((group) => group.id)).toEqual(["todo", "done", ""]);
    expect(groups[2]!.issues.map((item) => Number(item.number))).toEqual([
      2, 4,
    ]);
  });

  it("shows no unmapped section when every issue has a configured group", () => {
    const groups = groupIssues([issue(1, "todo")], mapping);
    expect(groups.map((group) => group.id)).toEqual(["todo", "done"]);
  });

  it("puts everything under unmapped when no mapping is configured", () => {
    const groups = groupIssues([issue(1, "todo")], undefined);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.group).toBeNull();
  });
});

describe("polling", () => {
  it("uses the Host's interval, clamped on both ends", () => {
    expect(pollInterval(60_000n)).toBe(60_000);
    expect(pollInterval(10n)).toBe(MIN_POLL_MS);
    expect(pollInterval(0n)).toBe(MIN_POLL_MS);
    expect(pollInterval(undefined)).toBe(MIN_POLL_MS);
    expect(pollInterval(9_999_999n)).toBe(MAX_POLL_MS);
  });
});

describe("local checkout naming", () => {
  const pull = (fromFork: boolean, headRef: string) =>
    githubPullRequest({
      repository,
      number: 42n,
      headRef,
      fromFork,
    });

  it("keeps a same-repository head ref", () => {
    expect(suggestedHeadRef(pull(false, "feature/x"))).toBe("feature/x");
  });

  it("never suggests a fork's ref name, so a local branch is not taken over", () => {
    expect(suggestedHeadRef(pull(true, "main"))).toBe("pr-42");
  });
});

describe("failures and reason codes", () => {
  it("names the repair for each client failure", () => {
    expect(failureKey(new GithubApiError("conflict"))).toBe(
      "github.error.conflict",
    );
    expect(failureKey(new Error("boom"))).toBe("github.error.network");
  });

  it("never tells the user to just retry a write whose result is unknown", () => {
    expect(failureKey(new GithubApiError("network", true))).toBe(
      "github.error.unknownOutcome",
    );
  });

  it("explains only the merge codes the Host documents", () => {
    expect(mergeReasonKey("HEAD_MOVED")).toBe("github.mergeReason.HEAD_MOVED");
    expect(mergeReasonKey("SOMETHING_ELSE")).toBeNull();
  });
});

describe("remoteForRepository", () => {
  const repo = { host: "git.example.test", owner: "acme", name: "app" };
  const remote = (name: string, fetchUrl: string) => ({ name, fetchUrl });

  it("picks the remote whose address is the base repository, whatever its name", () => {
    expect(
      remoteForRepository(
        [
          remote("origin", "git@git.example.test:me/app.git"),
          remote("upstream", "https://git.example.test/acme/app.git"),
        ],
        repo,
      ),
    ).toBe("upstream");
    expect(
      remoteForRepository(
        [
          remote("fork", "https://git.example.test/me/app"),
          remote("base", "ssh://git@GIT.example.test:2222/Acme/App.git"),
        ],
        repo,
      ),
    ).toBe("base");
  });

  it("matches a GitLab subgroup and a site prefix, preferring the exact path", () => {
    const nested = {
      host: "git.example.test",
      owner: "group/sub",
      name: "app",
    };
    expect(
      remoteForRepository(
        [
          remote(
            "prefixed",
            "https://git.example.test/gitlab/group/sub/app.git",
          ),
          remote("exact", "git@git.example.test:group/sub/app.git"),
        ],
        nested,
      ),
    ).toBe("exact");
    expect(
      remoteForRepository(
        [remote("prefixed", "https://git.example.test/gitlab/group/sub/app")],
        nested,
      ),
    ).toBe("prefixed");
  });

  it("answers null for another host, another path or an unreadable address", () => {
    expect(
      remoteForRepository(
        [
          remote("a", "https://other.example.test/acme/app.git"),
          remote("b", "git@git.example.test:acme/other.git"),
          remote("c", "not a url"),
          remote("d", "https://git.example.test/%E0%A4%A"),
          // 非 http(s) 地址不认站点前缀。
          remote("e", "ssh://git@git.example.test/x/acme/app.git"),
        ],
        repo,
      ),
    ).toBeNull();
  });
});
