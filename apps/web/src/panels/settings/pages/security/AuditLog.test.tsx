import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePreferencesStore } from "../../../../app/preferences-store";
import { installDomPolyfills } from "../../../../app/test-harness";
import { AuditLog, auditFailed, auditQuery } from "./AuditLog";

installDomPolyfills();

const NOW = Date.UTC(2026, 9, 3, 12);
const DAY = 24 * 3_600_000;
const ALICE = "a".repeat(32);

const entry = (id: number, action: string) => ({
  id,
  atMs: NOW - id * 1000,
  principalId: ALICE,
  deviceId: "",
  action,
  target: `t${id}`,
  workspaceId: "",
  detail: { ip: "192.0.2.1" },
});

beforeEach(() => usePreferencesStore.setState({ locale: "zh-CN" }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Radix Select：点开触发器再点选项。 */
function choose(trigger: string, option: string) {
  fireEvent.pointerDown(screen.getByRole("combobox", { name: trigger }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(screen.getByRole("option", { name: option }));
}

describe("AuditLog", () => {
  it("缺省 7 天；改筛选重查第一页，加载更多带游标", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({
        entries: [
          entry(1, "identity.login"),
          entry(2, "identity.login.failed"),
        ],
        nextBeforeId: 2,
      })
      .mockResolvedValueOnce({
        entries: [entry(3, "share.grant.set")],
        nextBeforeId: 0,
      })
      .mockResolvedValue({ entries: [], nextBeforeId: 0 });
    render(
      <AuditLog
        members={[{ principalId: ALICE, displayName: "爱丽丝" }]}
        load={load}
        exportCsv={vi.fn()}
        now={NOW}
      />,
    );
    expect(await screen.findByText("登录失败")).toBeTruthy();
    expect(load).toHaveBeenNthCalledWith(1, {
      sinceMs: NOW - 7 * DAY,
      limit: 50,
    });
    expect(screen.getAllByText("失败")).toHaveLength(1);
    expect(screen.getAllByText("爱丽丝").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("共享")).toBeTruthy();
    expect(load).toHaveBeenNthCalledWith(2, {
      sinceMs: NOW - 7 * DAY,
      beforeId: 2,
      limit: 50,
    });
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();

    choose("类型", "两步验证");
    await waitFor(() =>
      expect(load).toHaveBeenLastCalledWith({
        action: ["identity.mfa"],
        sinceMs: NOW - 7 * DAY,
        limit: 50,
      }),
    );
    expect(await screen.findByText("这段时间没有记录")).toBeTruthy();

    choose("时间范围", "全部时间");
    choose("成员", "爱丽丝");
    await waitFor(() =>
      expect(load).toHaveBeenLastCalledWith({
        principalId: ALICE,
        action: ["identity.mfa"],
        limit: 50,
      }),
    );
  });

  it("行展开看详情 JSON", async () => {
    render(
      <AuditLog
        members={[]}
        load={vi.fn()}
        now={NOW}
        initial={{
          entries: [entry(5, "identity.passkey.add")],
          nextBeforeId: 0,
        }}
      />,
    );
    expect(screen.queryByText(/192\.0\.2\.1/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    expect(screen.getByText(/192\.0\.2\.1/)).toBeTruthy();
  });

  it("导出用同样的筛选，存成 CSV 文件", async () => {
    const exportCsv = vi.fn().mockResolvedValue("id,time\r\n");
    const created: Blob[] = [];
    const original = {
      create: URL.createObjectURL,
      revoke: URL.revokeObjectURL,
    };
    URL.createObjectURL = (blob: Blob) => {
      created.push(blob);
      return "blob:audit";
    };
    URL.revokeObjectURL = () => undefined;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    render(
      <AuditLog
        members={[]}
        load={vi.fn().mockResolvedValue({ entries: [], nextBeforeId: 0 })}
        exportCsv={exportCsv}
        now={NOW}
        initial={{ entries: [], nextBeforeId: 0 }}
      />,
    );
    choose("类型", "登录");
    const button = screen.getByRole("button", { name: "导出 CSV" });
    await waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(button);
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(exportCsv).toHaveBeenCalledWith({
      action: ["identity.login"],
      sinceMs: NOW - 7 * DAY,
    });
    expect(created[0]?.type).toBe("text/csv");
    click.mockRestore();
    URL.createObjectURL = original.create;
    URL.revokeObjectURL = original.revoke;
  });

  it("结果由动作名推出；筛选拼查询", () => {
    expect(auditFailed("identity.login.failed")).toBe(true);
    expect(auditFailed("identity.lockout")).toBe(true);
    expect(auditFailed("identity.lockout.clear")).toBe(false);
    expect(
      auditQuery({ range: "day", principalId: "", type: "session" }, NOW),
    ).toEqual({
      action: ["identity.session", "identity.device"],
      sinceMs: NOW - DAY,
    });
  });
});
