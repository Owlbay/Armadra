import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CredentialList } from "@armadra/shared";

import { usePreferencesStore } from "@/app/preferences-store";
import { AgentCredentials } from "./AgentCredentials";

const list = vi.fn<() => Promise<CredentialList>>();
const create = vi.fn();
vi.mock("@/api/credentials", () => ({
  CREDENTIALS_QUERY_KEY: ["credentials"],
  credentialsApi: {
    list: () => list(),
    create: (value: unknown) => create(value),
    remove: vi.fn(),
  },
}));

const kinds = [
  { providerId: "claude", kind: "oauth-token", enabled: true },
  { providerId: "codex", kind: "api-key", enabled: false },
];

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AgentCredentials />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "en" });
  list.mockReset();
  create.mockReset();
});
afterEach(cleanup);

describe("AgentCredentials", () => {
  it("lists only the name and the kind of each entry", async () => {
    list.mockResolvedValue({
      backend: "keychain",
      available: true,
      kinds,
      entries: [
        {
          ref: "aaaa0000aaaa0000",
          providerId: "claude",
          kind: "oauth-token",
          label: "Work",
          isSet: false,
        },
      ],
    });
    mount();
    expect(await screen.findByText("Work")).toBeTruthy();
    expect(screen.getByText(/oauth-token/)).toBeTruthy();
    expect(screen.getByText("Not set")).toBeTruthy();
    expect(document.body.textContent).not.toContain("aaaa0000");
  });

  it("says why when this host cannot hold credentials, and offers no form", async () => {
    list.mockResolvedValue({
      backend: "file",
      available: false,
      reason: "credential_backend_insecure",
      kinds,
      entries: [],
    });
    mount();
    expect(
      await screen.findByText(
        "This host stores secrets in a plain file, so credentials cannot be saved",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Add credential")).toBeNull();
  });

  it("creates an entry with the first enabled kind and sends the value once", async () => {
    list.mockResolvedValue({
      backend: "keychain",
      available: true,
      kinds,
      entries: [],
    });
    create.mockResolvedValue({
      ref: "bbbb0000bbbb0000",
      providerId: "claude",
      kind: "oauth-token",
      label: "Personal",
      isSet: true,
    });
    mount();
    fireEvent.click(await screen.findByText("Add credential"));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Personal" },
    });
    fireEvent.change(screen.getByLabelText("Value"), {
      target: { value: "token-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        providerId: "claude",
        kind: "oauth-token",
        label: "Personal",
        value: "token-value",
      }),
    );
  });
});
