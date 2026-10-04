import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { usePreferencesStore } from "../../../../app/preferences-store";
import { CaInstallGuide, defaultPlatform, PageCaGuide } from "./CaInstallGuide";
import { countdown, groupFingerprint, PairingCard } from "./PairingCard";

const FP = "ab".repeat(32);
const EXPIRES = Date.UTC(2026, 9, 3, 8, 2);
const pairing = {
  origin: "https://192.168.1.20:8443",
  ticket: "t.k",
  fingerprint: FP,
  expiresAt: new Date(EXPIRES).toISOString(),
  webUrl: `https://192.168.1.20:8443/#pair=t.k&fp=${FP}`,
  deepLink: `armadra://pair?host=192.168.1.20%3A8443&ticket=t.k&fp=${FP}`,
};

beforeEach(() => usePreferencesStore.setState({ locale: "zh-CN" }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PairingCard", () => {
  it("counts down, and once expired dims the code and promotes the new-code button", () => {
    const onNewPairing = vi.fn();
    const props = {
      pairing,
      busy: false,
      origins: [pairing.origin],
      fingerprint: FP,
      caHref: null,
      onNewPairing,
    };
    const { rerender } = render(
      <PairingCard {...props} now={EXPIRES - 61_000} />,
    );
    expect(screen.getByText("1:01 后过期")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "新配对码" }).dataset.variant,
    ).toBe("outline");

    rerender(<PairingCard {...props} now={EXPIRES + 1} />);
    expect(screen.getByText("已过期")).toBeTruthy();
    const renew = screen.getByRole("button", { name: "新配对码" });
    expect(renew.dataset.variant).toBe("default");
    expect(
      (screen.getByRole("button", { name: "复制链接" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(renew);
    expect(onNewPairing).toHaveBeenCalledWith(pairing.origin);
    // 没有 CA 可发时不给下载。
    expect(screen.queryByRole("link", { name: "下载 CA" })).toBeNull();
  });

  it("私网档位上画「配对码 XXXX-XXXX 倒计时」，过期时收起配对码", () => {
    const props = {
      pairing: { ...pairing, code: "3F7K-9Q2M" },
      busy: false,
      origins: [pairing.origin],
      fingerprint: FP,
      caHref: null,
      onNewPairing: vi.fn(),
    };
    const { rerender } = render(
      <PairingCard {...props} now={EXPIRES - 179_000} />,
    );
    expect(screen.getByText("配对码")).toBeTruthy();
    expect(screen.getByText("3F7K-9Q2M").tagName).toBe("KBD");
    expect(screen.getByText("2:59")).toBeTruthy();
    rerender(<PairingCard {...props} now={EXPIRES + 1} />);
    expect(screen.queryByText("3F7K-9Q2M")).toBeNull();
    expect(screen.getByText("已过期")).toBeTruthy();
  });

  it("formats the clock and the fingerprint the way certificate dialogs do", () => {
    expect(countdown(120_000)).toBe("2:00");
    expect(countdown(59_001)).toBe("1:00");
    expect(countdown(-5)).toBe("0:00");
    expect(groupFingerprint("ab01")).toBe("AB:01");
  });
});

describe("CaInstallGuide", () => {
  it("opens to steps for both platforms and a download of /ca.crt", () => {
    render(
      <CaInstallGuide
        href="https://192.168.1.20:8443/ca.crt"
        platform="android"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "安装证书" }));
    expect(screen.getByText(/CA 证书」，选中刚下载的文件/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "下载 CA" }).getAttribute("href"),
    ).toBe("https://192.168.1.20:8443/ca.crt");
    expect(screen.getByRole("tab", { name: "iOS" })).toBeTruthy();
  });

  it("guesses the platform from the user agent", () => {
    expect(defaultPlatform("Mozilla/5.0 (Linux; Android 15)")).toBe("android");
    expect(defaultPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0)")).toBe(
      "ios",
    );
  });

  it("draws nothing on a page that did not come through a gateway", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { container } = render(<PageCaGuide served />);
    // jsdom 的页面是 http：不是经 Gateway 打开的，连问都不问。
    expect(container.textContent).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });
});
