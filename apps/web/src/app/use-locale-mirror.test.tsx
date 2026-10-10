import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

const fetchSettings = vi.fn();
const patchSettings = vi.fn();
vi.mock("../api/client", () => ({
  runtimeApi: {
    settings: () => fetchSettings(),
    updateSettings: (patch: unknown) => patchSettings(patch),
  },
}));

import { installDomPolyfills, TestProviders } from "./test-harness";
import { usePreferencesStore } from "./preferences-store";
import { useLocaleMirror } from "./use-locale-mirror";

installDomPolyfills();
afterEach(cleanup);

function Harness() {
  useLocaleMirror();
  return null;
}

/** 界面语言抄一份给 core 的 `ui.locale`（契约 §57.6），只在不一致时写。 */
describe("useLocaleMirror", () => {
  beforeEach(() => {
    fetchSettings.mockReset();
    patchSettings
      .mockReset()
      .mockImplementation(async (patch: { ui: { locale: string } }) => ({
        ui: patch.ui,
      }));
  });

  it("writes the page's language when the core has none, then follows a switch", async () => {
    usePreferencesStore.setState({ locale: "zh-CN" });
    fetchSettings.mockResolvedValue({});
    render(
      <TestProviders>
        <Harness />
      </TestProviders>,
    );
    await waitFor(() =>
      expect(patchSettings).toHaveBeenCalledWith({ ui: { locale: "zh-CN" } }),
    );
    act(() => usePreferencesStore.getState().setLocale("en"));
    await waitFor(() =>
      expect(patchSettings).toHaveBeenLastCalledWith({ ui: { locale: "en" } }),
    );
    expect(patchSettings).toHaveBeenCalledTimes(2);
  });

  it("writes nothing when the core already has it", async () => {
    usePreferencesStore.setState({ locale: "en" });
    fetchSettings.mockResolvedValue({ ui: { locale: "en" } });
    render(
      <TestProviders>
        <Harness />
      </TestProviders>,
    );
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 20));
    expect(patchSettings).not.toHaveBeenCalled();
  });
});
