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
  it("访客加入：accept → cloud/login 带邀请令牌 → 本机源指到中继，打开链接的工作空间", async () => {
    const net = routedFetch({
      [`GET /v1/links/${LINK_ID}`]: info,
      [`POST /v1/links/${LINK_ID}/accept`]: (init) => {
        expect(JSON.parse(String(init.body))).toMatchObject({
          secret: SECRET,
          device: { platform: "browser" },
        });
        return {
          body: {
            sourceId: HOST,
            relayOrigin: ISSUER,
            relayBaseUrl: `${ISSUER}/s/${HOST}`,
            assertion: "jws.guest",
            relayToken: "relay.guest",
            guestSession: {
              accessToken: "guest-access",
              refreshToken: "guest-refresh",
              accessExpiresAtMs: Date.now() + 900_000,
            },
          },
        };
      },
      [`POST /s/${HOST}/api/identity/cloud/login`]: (init) => {
        expect(JSON.parse(String(init.body))).toEqual({
          assertion: "jws.guest",
          invitationToken: INVITE,
        });
        expect(
          (init.headers as Record<string, string>)["Armadra-Relay-Token"],
        ).toBe("relay.guest");
        return {
          body: {
            session: {
              hostId: HOST,
              expiresAtUnixMs: Date.now() + 900_000,
              native: { accessToken: "core-access", refreshToken: "core-r" },
            },
          },
        };
      },
    });
    const enter = vi.fn();
    const onJoined = vi.fn();
    render(
      <JoinPage
        href={HREF}
        cloud={{ fetch: net.fetch }}
        enter={enter}
        onJoined={onJoined}
      />,
    );
    expect(await screen.findByText("studio")).toBeTruthy();
    expect(screen.getByText(/执行/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "加入" }));
    await waitFor(() => expect(onJoined).toHaveBeenCalledOnce());
    expect(enter).toHaveBeenCalledWith(
      expect.objectContaining({
        issuer: ISSUER,
        accepted: expect.objectContaining({ sourceId: HOST }),
        core: expect.objectContaining({ hostId: HOST }),
      }),
    );
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

  it("过期、撤销：按码说明，不进画布", async () => {
    for (const [status, codeName, text] of [
      [410, "link_expired", "链接已过期"],
      [404, "link_invalid", "链接已停用或不存在"],
    ] as const) {
      const net = routedFetch({
        [`GET /v1/links/${LINK_ID}`]: info,
        [`POST /v1/links/${LINK_ID}/accept`]: () => ({
          status,
          body: { code: codeName, message: "server words" },
        }),
      });
      const onJoined = vi.fn();
      const { unmount } = render(
        <JoinPage
          href={HREF}
          cloud={{ fetch: net.fetch }}
          enter={vi.fn()}
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

  it("邀请被拒（经中继 cloud/login）同样按码说明", async () => {
    const net = routedFetch({
      [`GET /v1/links/${LINK_ID}`]: info,
      [`POST /v1/links/${LINK_ID}/accept`]: () => ({
        body: {
          sourceId: HOST,
          relayBaseUrl: `${ISSUER}/s/${HOST}`,
          assertion: "jws.guest",
          relayToken: "relay.guest",
          guestSession: { accessToken: "g", accessExpiresAtMs: 1 },
        },
      }),
      [`POST /s/${HOST}/api/identity/cloud/login`]: () => ({
        status: 401,
        body: { code: "invitation_invalid", message: "" },
      }),
    });
    render(
      <JoinPage
        href={HREF}
        cloud={{ fetch: net.fetch }}
        enter={vi.fn()}
        onJoined={vi.fn()}
      />,
    );
    await screen.findByText("studio");
    fireEvent.click(screen.getByRole("button", { name: "加入" }));
    expect(await screen.findByText("邀请无效或已用完")).toBeTruthy();
  });

  it("没有片段的链接：说明链接不完整，不发请求", () => {
    const net = routedFetch({});
    render(
      <JoinPage
        href={`${ISSUER}/j/${LINK_ID}`}
        cloud={{ fetch: net.fetch }}
        enter={vi.fn()}
        onJoined={vi.fn()}
      />,
    );
    expect(screen.getByText("这不是一条完整的分享链接")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "加入" })).toBeNull();
    expect(net.calls).toHaveLength(0);
  });
});
