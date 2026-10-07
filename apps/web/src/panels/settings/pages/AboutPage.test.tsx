import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { runtimeApi } from "../../../api/client";
import { AboutPage, loadThirdPartyNotices } from "./AboutPage";

/**
 * 设置 → 关于的「开源许可」（外部服务 §11.3）：显示的是仓库根生成的
 * THIRD_PARTY_NOTICES.md 全文，不是一张手写的短表。
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("设置 → 关于", () => {
  it("第三方声明是生成文件的全文，带 Electron/Chromium 的随包声明", async () => {
    const text = await loadThirdPartyNotices();
    expect(text.startsWith("# Third-party notices\n")).toBe(true);
    expect(text).toContain("LICENSES.chromium.html");
    expect(text).toContain("### react@");
  });

  it("打开许可对话框才加载并显示声明正文", async () => {
    vi.spyOn(runtimeApi, "health").mockResolvedValue({
      version: "0.1.0",
    } as Awaited<ReturnType<typeof runtimeApi.health>>);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <AboutPage />
      </QueryClientProvider>,
    );
    expect(client.getQueryState(["third-party-notices"])?.status).not.toBe(
      "success",
    );
    fireEvent.click(screen.getByRole("button", { name: /查看|View/ }));
    await waitFor(() =>
      expect(screen.getByText(/# Third-party notices/)).toBeTruthy(),
    );
  });
});
