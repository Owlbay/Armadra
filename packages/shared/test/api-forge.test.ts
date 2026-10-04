import { describe, expect, it } from "vitest";
import {
  forgeChecksSchema,
  forgeConfigListSchema,
  forgeDetectionSchema,
  forgeFilesSchema,
  forgeIssuePageSchema,
  forgeMergedSchema,
  forgePullSchema,
  mergeForgePullSchema,
  putForgeConfigSchema,
} from "../src/index.js";

/** Shapes the core answers on `/api/forge/*` (contract §29). */
describe("forge API", () => {
  it("parses a detection for a configured Gitea host and for an unknown one", () => {
    expect(
      forgeDetectionSchema.parse({
        repository: { host: "git.example.test", owner: "acme", name: "app" },
        forge: "gitea",
        source: "config",
        configKey: "git.example.test",
        apiBase: "https://git.example.test/api/v1",
        webUrl: "https://git.example.test/acme/app",
        credential: true,
        accountLogin: "bot",
      }).forge,
    ).toBe("gitea");
    expect(
      forgeDetectionSchema.parse({
        repository: { host: "x.test", owner: "a", name: "b" },
        forge: null,
        source: null,
        configKey: null,
        apiBase: null,
        webUrl: null,
        credential: false,
        accountLogin: null,
      }).credential,
    ).toBe(false);
  });

  it("config rows never carry a token; the put body may", () => {
    const listed = forgeConfigListSchema.parse({
      configs: [
        {
          repoKey: "git.example.test",
          forge: "gitea",
          apiBase: "https://git.example.test/api/v1",
          credential: true,
          accountLogin: null,
          revision: 1,
          createdAtMs: 1,
          updatedAtMs: 1,
          token: "leak",
        },
      ],
    });
    expect("token" in listed.configs[0]!).toBe(false);
    // G5-15 起 GitLab 也能配；GitHub 仍只走 §5 的凭据面。
    expect(
      putForgeConfigSchema.safeParse({ forge: "gitlab", apiBase: "https://x" })
        .success,
    ).toBe(true);
    expect(
      putForgeConfigSchema.safeParse({ forge: "github", apiBase: "https://x" })
        .success,
    ).toBe(false);
    expect(
      putForgeConfigSchema.parse({
        forge: "gitea",
        apiBase: "https://x",
        token: "",
      }).token,
    ).toBe("");
  });

  it("parses issues, pulls, files, checks and a merge", () => {
    expect(
      forgeIssuePageSchema.parse({
        items: [
          {
            number: 1,
            title: "t",
            body: "",
            state: "open",
            author: null,
            labels: ["bug"],
            commentCount: 0,
            url: "",
            createdAtMs: 1,
            updatedAtMs: 2,
            closedAtMs: null,
          },
        ],
        nextCursor: "2",
      }).items,
    ).toHaveLength(1);
    expect(
      forgePullSchema.parse({
        number: 3,
        title: "p",
        body: "",
        state: "merged",
        draft: false,
        author: "bob",
        baseRef: "main",
        headRef: "topic",
        headSha: "a".repeat(40),
        mergeable: "unknown",
        url: "",
        createdAtMs: 1,
        updatedAtMs: 2,
        mergedAtMs: 3,
      }).state,
    ).toBe("merged");
    expect(
      forgeFilesSchema.parse({
        files: [
          {
            path: "a",
            previousPath: null,
            status: "added",
            additions: 1,
            deletions: 0,
            patch: null,
          },
        ],
      }).files,
    ).toHaveLength(1);
    expect(
      forgeChecksSchema.parse({ headSha: "", rollup: "none", checks: [] })
        .rollup,
    ).toBe("none");
    expect(forgeMergedSchema.parse({ merged: true, sha: null }).merged).toBe(
      true,
    );
    expect(mergeForgePullSchema.safeParse({ headSha: "abc" }).success).toBe(
      false,
    );
  });
});
