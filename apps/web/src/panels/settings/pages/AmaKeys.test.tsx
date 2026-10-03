import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const amaCredentials = vi.fn();
const setAmaCredential = vi.fn();
const clearAmaCredential = vi.fn();
vi.mock("../../../api/client", () => ({
  runtimeApi: {
    amaCredentials: () => amaCredentials(),
    setAmaCredential: (provider: string, key: string) =>
      setAmaCredential(provider, key),
    clearAmaCredential: (provider: string) => clearAmaCredential(provider),
  },
}));

import { TestProviders, installDomPolyfills } from "../../../app/test-harness";
import { usePreferencesStore } from "../../../app/preferences-store";
import { AmaKeys } from "./AmaKeys";

installDomPolyfills();
afterEach(cleanup);

const status = (set: string[] = []) => ({
  backend: "keychain",
  providers: ["anthropic", "openai", "deepseek"].map((id) => ({
    id,
    isSet: set.includes(id),
  })),
});

describe("Armadra Agent model keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePreferencesStore.setState({ locale: "zh-CN" });
    amaCredentials.mockResolvedValue(status());
  });

  it("saves a key for the chosen provider and never shows it again", async () => {
    setAmaCredential.mockResolvedValue(status(["anthropic"]));
    render(
      <TestProviders>
        <AmaKeys />
      </TestProviders>,
    );
    const input = (await screen.findByLabelText("API Key")) as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "sk-test-not-real" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(setAmaCredential).toHaveBeenCalledWith(
        "anthropic",
        "sk-test-not-real",
      ),
    );
    await screen.findByText("已设置");
    expect(input.value).toBe("");
    expect(document.body.textContent).not.toContain("sk-test-not-real");
  });

  it("clears a provider that is set", async () => {
    amaCredentials.mockResolvedValue(status(["openai"]));
    clearAmaCredential.mockResolvedValue(status());
    render(
      <TestProviders>
        <AmaKeys />
      </TestProviders>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "清除" }));
    await waitFor(() =>
      expect(clearAmaCredential).toHaveBeenCalledWith("openai"),
    );
    await waitFor(() => expect(screen.queryByText("已设置")).toBeNull());
  });

  it("draws nothing against a core without the route", async () => {
    amaCredentials.mockRejectedValue(new Error("404"));
    const { container } = render(
      <TestProviders>
        <AmaKeys />
      </TestProviders>,
    );
    await waitFor(() => expect(amaCredentials).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});
