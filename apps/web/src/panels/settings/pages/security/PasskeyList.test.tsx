import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePreferencesStore } from "../../../../app/preferences-store";
import { installDomPolyfills } from "../../../../app/test-harness";
import { PasskeyList } from "./PasskeyList";

installDomPolyfills();
beforeEach(() => usePreferencesStore.setState({ locale: "zh-CN" }));
afterEach(cleanup);

const LIST = {
  available: true,
  rpId: "armadra.example.com",
  reason: "",
  passkeys: [
    {
      credentialId: "c".repeat(32),
      label: "Chrome · macOS",
      aaguid: "",
      transports: ["internal"],
      createdAtMs: Date.UTC(2026, 9, 1),
    },
  ],
};

describe("PasskeyList", () => {
  it("列出、添加，删除先确认", () => {
    const onAdd = vi.fn();
    const onRemove = vi.fn();
    render(
      <PasskeyList
        list={LIST}
        supported
        busy={null}
        onAdd={onAdd}
        onRemove={onRemove}
      />,
    );
    expect(screen.getByText("Chrome · macOS")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "添加通行密钥" }));
    expect(onAdd).toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "删除 Chrome · macOS" }),
    );
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(onRemove).toHaveBeenCalledWith(LIST.passkeys[0]);
  });

  it("IP 主机上只说原因，不摆添加按钮", () => {
    render(
      <PasskeyList
        list={{
          ...LIST,
          available: false,
          rpId: "",
          reason: "passkey_unavailable_on_ip_host",
          passkeys: [],
        }}
        supported
        busy={null}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(
      screen.getByText("用 IP 地址访问时无法使用通行密钥，请改用域名"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "添加通行密钥" })).toBeNull();
  });

  it("浏览器不支持时同样只说原因", () => {
    render(
      <PasskeyList
        list={{ ...LIST, passkeys: [] }}
        supported={false}
        busy={null}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText("这个浏览器不支持通行密钥")).toBeTruthy();
  });
});
