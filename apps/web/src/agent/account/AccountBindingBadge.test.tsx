import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CredentialList, TerminalAgent } from "@armadra/shared";
import type { ReactNode } from "react";

import { usePreferencesStore } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { AccountBindingBadge } from "./AccountBindingBadge";

const list = vi.fn<() => Promise<CredentialList>>();
vi.mock("@/api/credentials", () => ({
  CREDENTIALS_QUERY_KEY: ["credentials"],
  credentialsApi: { list: () => list() },
}));

const NODE = "00000000-0000-4000-8000-000000000001";

const available: CredentialList = {
  backend: "keychain",
  available: true,
  kinds: [],
  entries: [
    {
      ref: "aaaa0000aaaa0000",
      providerId: "claude",
      kind: "oauth-token",
      label: "Work",
      isSet: true,
    },
    {
      ref: "bbbb0000bbbb0000",
      providerId: "copilot",
      kind: "github-token",
      label: "Bot",
      isSet: true,
    },
  ],
};

function wrap(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  );
}

const updateNodeData = vi.fn();
beforeEach(() => {
  usePreferencesStore.setState({ locale: "en" });
  useCanvasStore.setState({ updateNodeData } as never);
  list.mockReset();
  updateNodeData.mockReset();
});
afterEach(cleanup);

function open(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
}

describe("AccountBindingBadge", () => {
  it("takes no space without a binding and without a credential to choose", async () => {
    list.mockResolvedValue({ ...available, entries: [] });
    const { container } = wrap(
      <AccountBindingBadge agent={{ id: "claude" }} nodeId={NODE} />,
    );
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("shows the bound credential's name, never its reference", () => {
    wrap(
      <AccountBindingBadge
        agent={{
          id: "claude",
          account: {
            accountId: "default",
            providerId: "claude",
            label: "Work",
            credentialRef: "aaaa0000aaaa0000",
          },
        }}
      />,
    );
    expect(screen.getByText("Work")).toBeTruthy();
    expect(document.body.textContent).not.toContain("aaaa0000");
  });

  it("offers the default login and this CLI's credentials, and writes the choice into the node", async () => {
    list.mockResolvedValue(available);
    const agent: TerminalAgent = { id: "claude", model: "opus" };
    wrap(<AccountBindingBadge agent={agent} nodeId={NODE} />);
    const trigger = await screen.findByRole("button", {
      name: "Account: Default login",
    });
    open(trigger);
    expect(await screen.findByText("Default login")).toBeTruthy();
    // 别家 CLI 的条目不在菜单里。
    expect(screen.queryByText("Bot")).toBeNull();
    fireEvent.click(screen.getByText("Work"));
    expect(updateNodeData).toHaveBeenCalledWith(NODE, {
      agent: {
        id: "claude",
        model: "opus",
        account: {
          accountId: "default",
          providerId: "claude",
          label: "Work",
          credentialRef: "aaaa0000aaaa0000",
        },
      },
    });
  });

  it("goes back to the default login by dropping the binding", async () => {
    list.mockResolvedValue(available);
    wrap(
      <AccountBindingBadge
        agent={{
          id: "claude",
          account: {
            accountId: "default",
            providerId: "claude",
            label: "Work",
            credentialRef: "aaaa0000aaaa0000",
          },
        }}
        nodeId={NODE}
      />,
    );
    const trigger = await screen.findByRole("button", {
      name: "Account: Work",
    });
    open(trigger);
    fireEvent.click(await screen.findByText("Default login"));
    expect(updateNodeData).toHaveBeenCalledWith(NODE, {
      agent: { id: "claude" },
    });
  });

  it("offers nothing on a host that cannot hold credentials", async () => {
    list.mockResolvedValue({
      ...available,
      available: false,
      reason: "credential_backend_insecure",
    });
    const { container } = wrap(
      <AccountBindingBadge agent={{ id: "claude" }} nodeId={NODE} />,
    );
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
