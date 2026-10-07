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
  it("改名在名称格里内联：Enter 保存，成功后收起；Esc 取消", async () => {
    const onRename = vi.fn(async () => true);
    render(
      <PasskeyList
        list={LIST}
        supported
        busy={null}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onRename={onRename}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "给 Chrome · macOS 改名" }),
    );
    const input = screen.getByLabelText("给 Chrome · macOS 改名");
    expect((input as HTMLInputElement).value).toBe("Chrome · macOS");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onRename).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "给 Chrome · macOS 改名" }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "  工作笔记本  " },
    });
    fireEvent.submit(screen.getByRole("textbox").closest("form")!);
    await waitFor(() =>
      expect(onRename).toHaveBeenCalledWith(LIST.passkeys[0], "工作笔记本"),
    );
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });

  it("改名失败时输入框留着；空名保存不了；没给 onRename 时没有入口", async () => {
    const onRename = vi.fn(async () => false);
    const { rerender } = render(
      <PasskeyList
        list={LIST}
        supported
        busy={null}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onRename={onRename}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "给 Chrome · macOS 改名" }),
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: " " } });
    expect(
      (screen.getByRole("button", { name: "保存" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "新" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onRename).toHaveBeenCalled());
    expect(screen.getByRole("textbox")).toBeTruthy();
    rerender(
      <PasskeyList
        list={LIST}
        supported
        busy={null}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "给 Chrome · macOS 改名" }),
    ).toBeNull();
  });

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
