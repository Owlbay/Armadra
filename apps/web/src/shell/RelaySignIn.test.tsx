import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { usePreferencesStore } from "../app/preferences-store";
import { CloudError, type CloudSource } from "../sources/cloud-client";
import { SourceError } from "../sources/types";
import { RelaySignIn } from "./RelaySignIn";

const ISSUER = "https://relay.example:8102";
const A = "a".repeat(32);
const B = "b".repeat(32);

const host = (sourceId: string, name: string, online = true): CloudSource => ({
  sourceId,
  name,
  online,
  owner: true,
  via: "owner",
});

function relay(sources: CloudSource[]) {
  return {
    issuer: ISSUER,
    signIn: vi.fn(async (_account: string, password: string) => {
      if (password !== "pw") throw new CloudError(401, "credentials_invalid");
      return sources;
    }),
    enter: vi.fn(async (_source: Pick<CloudSource, "sourceId" | "name">) => {}),
  };
}

function signIn(password = "pw") {
  fireEvent.change(screen.getByLabelText("账号"), {
    target: { value: "dev" },
  });
  fireEvent.change(screen.getByLabelText("口令"), {
    target: { value: password },
  });
  fireEvent.click(screen.getByRole("button", { name: "登录" }));
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
});
afterEach(cleanup);

describe("中继托管页面的登录", () => {
  it("地址是中转自己，不显示地址栏；口令不对给原因", async () => {
    const target = relay([host(A, "laptop")]);
    render(<RelaySignIn relay={target} onEntered={vi.fn()} />);
    expect(screen.getByText("relay.example:8102")).toBeTruthy();
    expect(screen.queryByLabelText("地址")).toBeNull();
    signIn("nope");
    await waitFor(() =>
      expect(screen.getByText("账号或口令不对")).toBeTruthy(),
    );
    expect(target.signIn).toHaveBeenCalledWith("dev", "nope");
  });

  it("只有一台在线的主机：登录后直接进", async () => {
    const target = relay([host(A, "laptop")]);
    const onEntered = vi.fn();
    render(<RelaySignIn relay={target} onEntered={onEntered} />);
    signIn();
    await waitFor(() => expect(onEntered).toHaveBeenCalled());
    expect(target.enter).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: A }),
    );
  });

  it("几台：挑一台进；离线的不能点；进不去留在列表上给原因", async () => {
    const target = relay([host(A, "laptop"), host(B, "nas", false)]);
    target.enter.mockRejectedValueOnce(new SourceError("source_offline"));
    const onEntered = vi.fn();
    render(<RelaySignIn relay={target} onEntered={onEntered} />);
    signIn();
    await waitFor(() => expect(screen.getByText("选择主机")).toBeTruthy());
    const nas = screen.getByText("nas").closest("button");
    expect(nas?.disabled).toBe(true);
    expect(screen.getByText("离线")).toBeTruthy();
    fireEvent.click(screen.getByText("laptop"));
    await waitFor(() =>
      expect(screen.getByText("这台主机不在线")).toBeTruthy(),
    );
    // 失败挂在那一行下面。
    expect(
      document.querySelector(`[data-service-failure="${A}"]`)?.textContent,
    ).toContain("这台主机不在线");
    expect(onEntered).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("laptop"));
    await waitFor(() => expect(onEntered).toHaveBeenCalled());
  });

  it("目录是空的：没有可连接的主机", async () => {
    render(<RelaySignIn relay={relay([])} onEntered={vi.fn()} />);
    signIn();
    await waitFor(() =>
      expect(screen.getByText("没有可连接的主机")).toBeTruthy(),
    );
  });
});

describe("刷新页面之后", () => {
  it("续上了：不出表单，直接进画布", async () => {
    const target = {
      ...relay([host(A, "laptop")]),
      resume: vi.fn(async () => ({ kind: "entered" as const })),
    };
    const onEntered = vi.fn();
    render(<RelaySignIn relay={target} onEntered={onEntered} />);
    expect(screen.queryByLabelText("口令")).toBeNull();
    expect(screen.getByLabelText("连接中")).toBeTruthy();
    await waitFor(() => expect(onEntered).toHaveBeenCalledTimes(1));
    expect(target.resume).toHaveBeenCalledTimes(1);
    expect(target.signIn).not.toHaveBeenCalled();
  });

  it("续不上（没记下、令牌被拒）：回到登录表单", async () => {
    const target = {
      ...relay([host(A, "laptop")]),
      resume: vi.fn(async () => null),
    };
    render(<RelaySignIn relay={target} onEntered={vi.fn()} />);
    expect(await screen.findByLabelText("口令")).toBeTruthy();
  });

  it("登录还在、那台主机进不去：列出目录与原因，可以再挑", async () => {
    const target = {
      ...relay([host(A, "laptop")]),
      resume: vi.fn(async () => ({
        kind: "signedIn" as const,
        hosts: [host(A, "laptop", false), host(B, "desktop")],
        failure: "offline" as const,
      })),
    };
    const onEntered = vi.fn();
    render(<RelaySignIn relay={target} onEntered={onEntered} />);
    fireEvent.click(await screen.findByRole("button", { name: /desktop/ }));
    await waitFor(() => expect(onEntered).toHaveBeenCalled());
    expect(target.enter).toHaveBeenCalledWith(host(B, "desktop"));
  });
});
