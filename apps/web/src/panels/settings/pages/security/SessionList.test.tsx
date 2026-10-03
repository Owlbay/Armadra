import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePreferencesStore } from "../../../../app/preferences-store";
import { installDomPolyfills } from "../../../../app/test-harness";
import { LockoutList, SessionList, platformIcon } from "./SessionList";

installDomPolyfills();
beforeEach(() => usePreferencesStore.setState({ locale: "zh-CN" }));
afterEach(cleanup);

const row = (id: string, current: boolean, name: string) => ({
  sessionId: id,
  principalId: "p".repeat(32),
  deviceId: `d-${id}`,
  deviceName: name,
  createdAtMs: 1_000,
  lastSeenAtMs: current ? 3_000 : 2_000,
  expiresAtMs: 9_000,
  remoteIp: "192.0.2.4",
  userAgent: current ? "Macintosh" : "iPhone",
  current,
});

describe("SessionList", () => {
  it("第一次取数时是标题加 Skeleton，取不到时整块不出现", () => {
    const props = {
      sessions: undefined,
      everyone: false,
      canSeeEveryone: false,
      busy: null,
      onEveryone: vi.fn(),
      onRevoke: vi.fn(),
      onRevokeOthers: vi.fn(),
    };
    const { container, rerender } = render(<SessionList {...props} loading />);
    expect(screen.getByText("会话与设备")).toBeTruthy();
    expect(
      container.querySelector('[data-slot="security-loading"]'),
    ).toBeTruthy();
    rerender(<SessionList {...props} />);
    expect(container.textContent).toBe("");
  });

  it("当前设备排第一、带徽标、没有退出钮；其余可退出，「退出其他全部」先确认", () => {
    const onRevoke = vi.fn();
    const onRevokeOthers = vi.fn();
    render(
      <SessionList
        sessions={[row("b", false, "Phone"), row("a", true, "Laptop")]}
        everyone={false}
        canSeeEveryone={false}
        busy={null}
        onEveryone={vi.fn()}
        onRevoke={onRevoke}
        onRevokeOthers={onRevokeOthers}
      />,
    );
    const rows = screen.getAllByRole("row");
    expect(rows[1]?.textContent).toContain("Laptop");
    expect(rows[1]?.textContent).toContain("当前");
    expect(screen.queryByRole("button", { name: "退出 Laptop" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "退出 Phone" }));
    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    expect(onRevoke).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "b" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "退出其他全部" }));
    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    expect(onRevokeOthers).toHaveBeenCalled();
  });

  it("owner 能切到所有人，多一列成员", () => {
    const onEveryone = vi.fn();
    const { rerender } = render(
      <SessionList
        sessions={[row("a", true, "Laptop")]}
        everyone={false}
        canSeeEveryone
        busy={null}
        onEveryone={onEveryone}
        onRevoke={vi.fn()}
        onRevokeOthers={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "所有成员" }));
    expect(onEveryone).toHaveBeenCalledWith(true);
    rerender(
      <SessionList
        sessions={[row("a", true, "Laptop")]}
        everyone
        canSeeEveryone
        names={new Map([["p".repeat(32), "小王"]])}
        busy={null}
        onEveryone={onEveryone}
        onRevoke={vi.fn()}
        onRevokeOthers={vi.fn()}
      />,
    );
    expect(screen.getByText("小王")).toBeTruthy();
  });

  it("平台图标按 UA 猜", () => {
    expect(platformIcon("iPhone").displayName).toBe(
      platformIcon("Android Mobile").displayName,
    );
    expect(platformIcon("curl/8")).not.toBe(platformIcon("Windows NT"));
  });
});

describe("LockoutList", () => {
  it("没有锁着的就不出现；有的可以解锁", () => {
    const { container } = render(
      <LockoutList lockouts={[]} busy={null} onUnlock={vi.fn()} />,
    );
    expect(container.textContent).toBe("");
    const onUnlock = vi.fn();
    const lockout = {
      key: "principal:x",
      principalId: "x".repeat(32),
      failures: 6,
      lockedUntilMs: 5_000,
    };
    render(
      <LockoutList lockouts={[lockout]} busy={null} onUnlock={onUnlock} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "解锁" }));
    expect(onUnlock).toHaveBeenCalledWith(lockout);
  });
});
