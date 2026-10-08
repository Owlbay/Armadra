import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  GithubCredentialSource,
  GithubSecretStore,
  githubCredentialStatus,
} from "../../../api/github";

const store = vi.hoisted(() => ({
  workspace: { id: "workspace-1", rootPath: "/tmp" },
}));

const session = vi.hoisted(() => ({
  state: { status: "idle" } as Record<string, unknown>,
  client: null as unknown,
  connect: vi.fn(async () => {}),
  reset: vi.fn(),
}));

vi.mock("../../../store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

vi.mock("../../../host/github-session", () => {
  const useGithubSession = <T,>(selector: (state: typeof session) => T) =>
    selector(session);
  useGithubSession.getState = () => session;
  return { useGithubSession };
});

/** Gitea / GitLab 的配置面（契约 §29.3）。缺省一行 GitLab 主机配置。 */
const forgeApi = vi.hoisted(() => ({
  forgeConfigs: vi.fn(),
  putForgeConfig: vi.fn(),
  deleteForgeConfig: vi.fn(),
}));

vi.mock("../../../api/forge", async (original) => ({
  ...(await original<typeof import("../../../api/forge")>()),
  ...forgeApi,
}));

import { ForgePage } from "./ForgePage";

const gitlabRow = {
  repoKey: "gitlab.example.test",
  forge: "gitlab" as const,
  apiBase: "https://gitlab.example.test/api/v4",
  credential: true,
  accountLogin: "bot",
  revision: 2,
  createdAtMs: 1,
  updatedAtMs: 1,
};

/** A status that would echo a token back if the page ever trusted one. */
const status = githubCredentialStatus({
  source: GithubCredentialSource.TOKEN_REF,
  store: GithubSecretStore.FILE_FALLBACK,
  available: true,
  apiBase: "https://api.github.com",
  accountLogin: "octocat",
  tokenScopes: ["repo", "read:org"],
  revision: 3n,
  checkedAtUnixMs: 1_788_557_900_000n,
});

function client(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "workspace-1",
    getCredential: vi.fn(async () => status),
    configureCredential: vi.fn(async () => status),
    revokeCredential: vi.fn(async () =>
      githubCredentialStatus({
        source: GithubCredentialSource.NONE,
        store: GithubSecretStore.NONE,
        available: false,
        apiBase: "https://api.github.com",
        reasonCode: "NO_CREDENTIAL",
        revision: 4n,
      }),
    ),
    ...overrides,
  };
}

function renderPage(api: ReturnType<typeof client>) {
  session.state = { status: "blocked", reason: "noCredential" };
  session.client = api;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ForgePage />
    </QueryClientProvider>,
  );
}

function tokenField(): HTMLInputElement {
  return document.querySelector(
    "[data-slot='github-token']",
  ) as HTMLInputElement;
}

beforeEach(() => {
  for (const fn of Object.values(forgeApi)) fn.mockReset();
  forgeApi.forgeConfigs.mockResolvedValue([gitlabRow]);
  forgeApi.putForgeConfig.mockImplementation(async (repoKey, input) => ({
    ...gitlabRow,
    repoKey,
    forge: input.forge,
    revision: input.expectedRevision + 1,
  }));
  forgeApi.deleteForgeConfig.mockResolvedValue(undefined);
  session.connect.mockClear();
  session.state = { status: "idle" };
  session.client = null;
});
afterEach(cleanup);

describe("GitHub credential settings", () => {
  it("shows what the stored credential can do, including the degraded store", async () => {
    renderPage(client());
    expect(await screen.findByText("octocat")).toBeTruthy();
    expect(screen.getByText("现在可以取得令牌")).toBeTruthy();
    // The 0600 file fallback is named as a fallback, not as "stored securely".
    expect(screen.getByText("0600 文件（降级）")).toBeTruthy();
    expect(screen.getByText(/系统钥匙串不可用/)).toBeTruthy();
    expect(screen.getByText("repo, read:org")).toBeTruthy();
  });

  it("shows the machine reason code when no token can be produced", async () => {
    renderPage(
      client({
        getCredential: vi.fn(async () =>
          githubCredentialStatus({
            source: GithubCredentialSource.NONE,
            store: GithubSecretStore.NONE,
            available: false,
            apiBase: "https://api.github.com",
            reasonCode: "GH_CLI_NOT_LOGGED_IN",
            revision: 2n,
          }),
        ),
      }),
    );
    expect(await screen.findByText("GH_CLI_NOT_LOGGED_IN")).toBeTruthy();
    expect(screen.getByText("现在取不到令牌")).toBeTruthy();
  });

  it("keeps the token field a never-refilled password box", async () => {
    const api = client();
    renderPage(api);
    await screen.findByText("octocat");
    // The stored source is TOKEN_REF, but nothing pre-fills the field.
    fireEvent.change(document.querySelector("select") as HTMLSelectElement, {
      target: { value: GithubCredentialSource.TOKEN_REF },
    });
    const field = tokenField();
    expect(field.type).toBe("password");
    expect(field.value).toBe("");

    fireEvent.change(field, { target: { value: "ghp_secret" } });
    fireEvent.click(screen.getByText("保存"));
    await waitFor(() =>
      expect(api.configureCredential).toHaveBeenCalledWith({
        source: GithubCredentialSource.TOKEN_REF,
        token: "ghp_secret",
        apiBase: undefined,
        expectedRevision: 3n,
      }),
    );
    // Cleared the moment the Host accepted it, and never read back from the
    // status response.
    await waitFor(() => expect(tokenField().value).toBe(""));
  });

  it("revokes against the revision it displayed", async () => {
    const api = client();
    renderPage(api);
    await screen.findByText("octocat");
    fireEvent.click(screen.getByText("撤销凭据"));
    await waitFor(() =>
      expect(api.revokeCredential).toHaveBeenCalledWith({
        expectedRevision: 3n,
      }),
    );
  });
});

describe("Gitea / GitLab per host or repository (§29.3)", () => {
  function forgeToken(): HTMLInputElement {
    return document.querySelector(
      "[data-slot='forge-token']",
    ) as HTMLInputElement;
  }
  function inForm(selector: string): HTMLInputElement {
    return document.querySelector(
      `[data-slot='forge-config-form'] ${selector}`,
    ) as HTMLInputElement;
  }

  it("lists each config with its platform and account, never a token", async () => {
    renderPage(client());
    expect(await screen.findByText("gitlab.example.test")).toBeTruthy();
    expect(screen.getByText("GitLab")).toBeTruthy();
    expect(screen.getByText("bot")).toBeTruthy();
    expect(screen.getByText("其他平台")).toBeTruthy();
  });

  it("adds a GitLab repository and drops the token once the Host took it", async () => {
    renderPage(client());
    await screen.findByText("gitlab.example.test");
    fireEvent.click(screen.getByText("添加"));
    fireEvent.change(inForm("input"), {
      target: { value: "Git.Example.test/acme/app" },
    });
    fireEvent.change(inForm("select"), { target: { value: "gitlab" } });
    fireEvent.change(inForm("input[type='url']"), {
      target: { value: "https://git.example.test" },
    });
    expect(forgeToken().type).toBe("password");
    fireEvent.change(forgeToken(), { target: { value: "glpat-secret" } });
    fireEvent.click(inForm("button[type='submit']"));
    await waitFor(() =>
      expect(forgeApi.putForgeConfig).toHaveBeenCalledWith(
        "git.example.test/acme/app",
        {
          forge: "gitlab",
          apiBase: "https://git.example.test",
          token: "glpat-secret",
          expectedRevision: 0,
        },
      ),
    );
    await waitFor(() => expect(forgeToken()).toBeNull());
  });

  it("edits against the revision it read, keeping the token unless one is typed or cleared", async () => {
    renderPage(client());
    await screen.findByText("gitlab.example.test");
    fireEvent.click(screen.getByText("编辑"));
    // 令牌框从不回填；地址回填成站点根。
    expect(forgeToken().value).toBe("");
    expect(inForm("input[type='url']").value).toBe(
      "https://gitlab.example.test",
    );
    fireEvent.click(inForm("button[type='submit']"));
    await waitFor(() =>
      expect(forgeApi.putForgeConfig).toHaveBeenLastCalledWith(
        "gitlab.example.test",
        {
          forge: "gitlab",
          apiBase: "https://gitlab.example.test",
          expectedRevision: 2,
        },
      ),
    );
    fireEvent.click(await screen.findByText("编辑"));
    fireEvent.click(screen.getByText("清除令牌"));
    await waitFor(() =>
      expect(forgeApi.putForgeConfig).toHaveBeenLastCalledWith(
        "gitlab.example.test",
        expect.objectContaining({ token: "", expectedRevision: 2 }),
      ),
    );
  });

  it("deletes against the revision it displayed", async () => {
    renderPage(client());
    await screen.findByText("gitlab.example.test");
    fireEvent.click(screen.getByText("删除"));
    await waitFor(() =>
      expect(forgeApi.deleteForgeConfig).toHaveBeenCalledWith(
        "gitlab.example.test",
        2,
      ),
    );
  });
});
