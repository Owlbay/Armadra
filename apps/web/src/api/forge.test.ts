import { describe, expect, it } from "vitest";

import { configPath, repoPath } from "./forge";

describe("托管平台面的路径（契约 §29.3、§29.6）", () => {
  it("多级子组的 owner 整条编码成一段", () => {
    expect(
      repoPath({
        host: "gitlab.example.test",
        owner: "platform/web",
        name: "app",
      }),
    ).toBe("/api/forge/repos/gitlab.example.test/platform%2Fweb/app");
    expect(
      repoPath({ host: "git.example.test", owner: "acme", name: "app" }),
    ).toBe("/api/forge/repos/git.example.test/acme/app");
  });

  it("配置键：主机、两段仓库、多级子组的仓库", () => {
    expect(configPath("gitlab.example.test")).toBe(
      "/api/forge/configs/gitlab.example.test",
    );
    expect(configPath("git.example.test/acme/app")).toBe(
      "/api/forge/configs/git.example.test/acme/app",
    );
    expect(configPath("gitlab.example.test/platform/web/app")).toBe(
      "/api/forge/configs/gitlab.example.test/platform%2Fweb/app",
    );
  });
});
