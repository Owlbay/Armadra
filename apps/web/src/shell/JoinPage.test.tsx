import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePreferencesStore } from "../app/preferences-store";
import { routedFetch } from "../mobile/testing";
import { CloudError } from "../sources/cloud-client";
import { JoinPage } from "./JoinPage";

/**
 * 分享链接落地页（客户端包 §6.1，个人中转）：访客直接加入、失败按码说明、
 * 认不出的链接。远程服务与经中继的 core 都是假的 `fetch`。
 */

const ISSUER = "https://relay.example.com";
const LINK_ID = "0123456789abcdef";
const SECRET = "S".repeat(43);
const INVITE = `${"c".repeat(32)}.${"D".repeat(43)}`;
const HREF = `${ISSUER}/j/${LINK_ID}#${SECRET}.${INVITE}`;
const HOST = "a".repeat(32);

const info = () => ({
  body: {
    kind: "source_invite",
    label: "",
    role: "operator",
    sourceName: "studio",
    expiresAtMs: Date.UTC(2026, 9, 13),
    exhausted: false,
    requiresAccount: false,
  },
});

beforeEach(() => {
  usePreferencesStore.getState().setLocale("zh-CN");
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("JoinPage", () => {
  it("显示源、权限与有效期；「加入」按链接以访客加入，地址换成 /app/，记下打开工作空间", async () => {
    const net = routedFetch({ [`GET /v1/links/${LINK_ID}`]: info });
    const join = vi.fn(async () => HOST);
    const onJoined = vi.fn();
    render(
      <JoinPage
        href={HREF}
        cloud={{ fetch: net.fetch }}
        join={join}
        onJoined={onJoined}
      />,
    );
    expect(await screen.findByText("studio")).toBeTruthy();
    expect(screen.getByText(/执行/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "加入" }));
    await waitFor(() => expect(onJoined).toHaveBeenCalledOnce());
    expect(join).toHaveBeenCalledWith({
      issuer: ISSUER,
      linkId: LINK_ID,
      secret: SECRET,
      invitationToken: INVITE,
    });
    expect(sessionStorage.getItem("armadra.sources.openAfterJoin")).toBe(
      "local",
    );
    expect(window.location.pathname).toBe("/app/");
    // 「在 Armadra 中打开」是同一条链接的深链。
    expect(
      screen
        .getByRole("link", { name: "在 Armadra 中打开" })
        .getAttribute("href"),
    ).toMatch(/^armadra:\/\/join\?link=0123456789abcdef&issuer=/);
  });

  it("过期、撤销、邀请被拒：按码说明，不展示对端原话，不进画布", async () => {
    for (const [status, code, text] of [
      [410, "link_expired", "链接已过期"],
      [404, "link_invalid", "链接已停用或不存在"],
      [401, "invitation_invalid", "邀请无效或已用完"],
    ] as const) {
      const net = routedFetch({ [`GET /v1/links/${LINK_ID}`]: info });
      const onJoined = vi.fn();
      const { unmount } = render(
        <JoinPage
          href={HREF}
          cloud={{ fetch: net.fetch }}
          join={async () => {
            throw new CloudError(status, code, "server words");
          }}
          onJoined={onJoined}
        />,
      );
      await screen.findByText("studio");
      fireEvent.click(screen.getByRole("button", { name: "加入" }));
      expect(await screen.findByText(text)).toBeTruthy();
      expect(screen.queryByText("server words")).toBeNull();
      expect(onJoined).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("撤销的链接：一打开 links.get 就说明", async () => {
    const net = routedFetch({
      [`GET /v1/links/${LINK_ID}`]: () => ({
        status: 404,
        body: { code: "link_invalid", message: "" },
      }),
    });
    render(
      <JoinPage
        href={HREF}
        cloud={{ fetch: net.fetch }}
        join={vi.fn()}
        onJoined={vi.fn()}
      />,
    );
    expect(await screen.findByText("链接已停用或不存在")).toBeTruthy();
  });

  it("没有片段的链接：说明链接不完整，不发请求", () => {
    const net = routedFetch({});
    render(
      <JoinPage
        href={`${ISSUER}/j/${LINK_ID}`}
        cloud={{ fetch: net.fetch }}
        join={vi.fn()}
        onJoined={vi.fn()}
      />,
    );
    expect(screen.getByText("这不是一条完整的分享链接")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "加入" })).toBeNull();
    expect(net.calls).toHaveLength(0);
  });
});
