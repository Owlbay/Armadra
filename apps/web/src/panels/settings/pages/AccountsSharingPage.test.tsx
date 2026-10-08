import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resume: vi.fn(),
  takeToken: vi.fn(() => ""),
  redeem: vi.fn(),
  issue: vi.fn(),
  putGrant: vi.fn(),
  groupRole: vi.fn(() => "member"),
  setPassword: vi.fn(),
  issueReset: vi.fn(),
  resetMfa: vi.fn(),
  mailConfigured: vi.fn(async () => false),
  mailReset: vi.fn(),
  extraMembers: vi.fn(
    (): { principalId: string; role: string; joinedAtMs: number }[] => [],
  ),
}));

vi.mock("../../../api/security", async (original) => {
  const actual = await original<typeof import("../../../api/security")>();
  return {
    ...actual,
    issuePasswordReset: (...args: never[]) => mocks.issueReset(...args),
    resetMfa: (...args: never[]) => mocks.resetMfa(...args),
  };
});

vi.mock("../../../api/mail", async (original) => {
  const actual = await original<typeof import("../../../api/mail")>();
  return {
    ...actual,
    mailConfigured: () => mocks.mailConfigured(),
    mailPasswordReset: (...args: never[]) => mocks.mailReset(...args),
  };
});

vi.mock("../../../api/identity", async (original) => {
  const actual = await original<typeof import("../../../api/identity")>();
  return {
    ...actual,
    resumeIdentity: (...args: never[]) => mocks.resume(...args),
  };
});

vi.mock("../../../api/accounts", async (original) => {
  const actual = await original<typeof import("../../../api/accounts")>();
  return {
    ...actual,
    takeInvitationToken: () => mocks.takeToken(),
    redeemInvitation: (...args: never[]) => mocks.redeem(...args),
    issueInvitation: (...args: never[]) => mocks.issue(...args),
    putGrant: (...args: never[]) => mocks.putGrant(...args),
    setPassword: (...args: never[]) => mocks.setPassword(...args),
    listPrincipals: async () => [
      {
        principalId: OWNER,
        kind: "owner",
        displayName: "",
        createdAtMs: 1,
        disabledAtMs: 0,
        hasPassword: true,
      },
      {
        principalId: MEMBER,
        kind: "member",
        displayName: "同事",
        createdAtMs: 2,
        disabledAtMs: 0,
        hasPassword: true,
      },
    ],
    listGroups: async () => [
      {
        groupId: GROUP,
        name: "前端组",
        ownerPrincipalId: OWNER,
        createdAtMs: 1,
        members: [
          { principalId: MEMBER, role: mocks.groupRole(), joinedAtMs: 1 },
          ...mocks.extraMembers(),
        ],
      },
    ],
    listInvitations: async () => [],
    listGrants: async () => [
      {
        grantId: "g1",
        subjectKind: "principal",
        subjectId: MEMBER,
        workspaceId: WORKSPACE,
        role: "editor",
        grantedBy: OWNER,
        createdAtMs: 1,
        permissions: [],
      },
    ],
  };
});

vi.mock("../../../app/workspaces-query", () => ({
  useWorkspacesQuery: () => ({
    data: [{ id: WORKSPACE, name: "画布一" }],
  }),
}));

import {
  IdentityRequestError,
  type IdentitySession,
} from "../../../api/identity";
import { invitationLink } from "../../../api/accounts";
import { usePreferencesStore } from "../../../app/preferences-store";
import { visibleSettingsSections } from "../nav";
import { AccountsSharingPage } from "./AccountsSharingPage";

const OWNER = "a".repeat(32);
const MEMBER = "b".repeat(32);
const GROUP = "c".repeat(32);
const WORKSPACE = "11111111-1111-4111-8111-111111111111";

function session(
  principalId: string,
  role: string,
  permissions: string[],
): IdentitySession {
  return {
    hostId: "h".repeat(32),
    device: {
      deviceId: "d".repeat(32),
      principalId,
      displayName: "浏览器",
      role,
      createdAtUnixMs: 1,
      revision: 1,
    },
    scopes: permissions.map((permission) => ({
      permission,
      workspaceId: "",
      executionHostId: "",
    })),
    expiresAtUnixMs: 0,
  };
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AccountsSharingPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  mocks.takeToken.mockReturnValue("");
  mocks.groupRole.mockReturnValue("member");
  mocks.extraMembers.mockReturnValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("设置 → 账号与共享", () => {
  it("只在服务器壳托管的页面上出现", () => {
    const ids = (server: boolean) =>
      visibleSettingsSections(server).map((section) => section.id);
    expect(ids(false)).not.toContain("accounts");
    expect(ids(true)).toContain("accounts");
  });

  it("成员看不到本机管理的那几页", () => {
    const ids = (member: boolean) =>
      visibleSettingsSections(true, member).map((section) => section.id);
    for (const id of [
      "agents",
      "customAgents",
      "sessions",
      "credentials",
      "usage",
      "workspace",
      "machines",
      "forge",
      "remoteAccess",
    ]) {
      expect(ids(false)).toContain(id);
      expect(ids(true)).not.toContain(id);
    }
    // 只动本机偏好与自己账号的几页照旧；快捷键的本设备层对成员开放。
    expect(ids(true)).toEqual(
      expect.arrayContaining([
        "defaults",
        "general",
        "notifications",
        "whiteboard",
        "terminalLook",
        "keybindings",
        "devices",
        "security",
        "accounts",
        "about",
      ]),
    );
  });

  it("组管理员只看得到自己管的组，不能建组删组，邀请只能指向组", async () => {
    mocks.groupRole.mockReturnValue("admin");
    mocks.resume.mockResolvedValue(
      session(MEMBER, "member", ["identity:read"]),
    );
    mount();
    expect(await screen.findByText("前端组")).toBeTruthy();
    expect(screen.queryByText("新建组")).toBeNull();
    expect(screen.queryByText("共享")).toBeNull();
    fireEvent.click(screen.getByText("前端组"));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.queryByText("删除组")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    fireEvent.click(await screen.findByText("生成邀请"));
    // 对话框里选的是组，不是工作空间与角色。
    expect(await screen.findByRole("combobox", { name: "组" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "工作空间" })).toBeNull();
  });

  it("管理员看得到成员、组、邀请与共享", async () => {
    mocks.resume.mockResolvedValue(
      session(OWNER, "owner", ["identity:manage", "identity:read"]),
    );
    mount();
    expect(await screen.findByText("成员")).toBeTruthy();
    expect(screen.getByText("组")).toBeTruthy();
    expect(screen.getByText("邀请")).toBeTruthy();
    expect(screen.getByText("共享")).toBeTruthy();
    expect(await screen.findByText("前端组")).toBeTruthy();
    expect(screen.getByText("1 人")).toBeTruthy();
    // owner 没有显示名时叫「管理员」，同事按名字。
    expect(screen.getByText("管理员")).toBeTruthy();
    expect((await screen.findAllByText("同事")).length).toBeGreaterThan(0);
  });

  it("生成邀请之后给出落在页面根片段上的链接", async () => {
    mocks.resume.mockResolvedValue(
      session(OWNER, "owner", ["identity:manage", "identity:read"]),
    );
    mocks.issue.mockResolvedValue({
      invitationId: "e".repeat(32),
      token: `${"e".repeat(32)}.secret`,
      expiresAtMs: Date.now() + 1000,
      role: "viewer",
      targetGroupId: "",
      targetWorkspaceId: WORKSPACE,
    });
    mount();
    fireEvent.click(await screen.findByText("生成邀请"));
    // 工作空间没选时「生成」点不动。
    const generate = await screen.findByRole("button", { name: "生成" });
    expect((generate as HTMLButtonElement).disabled).toBe(true);
    expect(invitationLink("tok", "https://example.test")).toBe(
      "https://example.test/#invite=tok",
    );
  });

  it("成员只看得到自己的账号", async () => {
    mocks.resume.mockResolvedValue(
      session(MEMBER, "member", ["identity:read"]),
    );
    mount();
    expect(await screen.findByText("我的账号")).toBeTruthy();
    expect(screen.getByText(MEMBER)).toBeTruthy();
    expect(screen.queryByText("成员")).toBeNull();
    expect(screen.queryByText("共享")).toBeNull();
  });

  it("没有会话时给登录表单", async () => {
    mocks.resume.mockResolvedValue(null);
    mount();
    // 登录分两步（设计系统 §5.9）：先账号「继续」，再口令。
    expect(await screen.findByRole("heading", { name: "登录" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "继续" })).toBeTruthy();
    expect(screen.getByLabelText("账号标识")).toBeTruthy();
  });

  it("地址栏带着邀请时弹出兑换对话框，兑换后进入自己的账号", async () => {
    mocks.resume.mockResolvedValue(null);
    mocks.takeToken.mockReturnValue(`${"e".repeat(32)}.secret`);
    mocks.redeem.mockResolvedValue(
      session(MEMBER, "member", ["identity:read"]),
    );
    mount();
    expect(await screen.findByText("接受邀请")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("名字"), {
      target: { value: "新同事" },
    });
    fireEvent.change(screen.getByLabelText("口令"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.click(screen.getByRole("button", { name: "加入" }));
    await waitFor(() =>
      expect(mocks.redeem).toHaveBeenCalledWith({
        token: `${"e".repeat(32)}.secret`,
        displayName: "新同事",
        password: "correct horse battery",
      }),
    );
    expect(await screen.findByText("我的账号")).toBeTruthy();
  });

  it("成员行菜单：签发重置链接给出 #reset= 链接与二维码，配了邮件时能发", async () => {
    mocks.resume.mockResolvedValue(
      session(OWNER, "owner", ["identity:manage", "identity:read"]),
    );
    const token = `${"f".repeat(32)}.${"R".repeat(43)}`;
    mocks.issueReset.mockResolvedValue({
      token,
      expiresAtMs: Date.UTC(2026, 9, 5, 12),
    });
    mocks.mailConfigured.mockResolvedValue(true);
    mocks.mailReset.mockResolvedValue(undefined);
    mount();
    const menu = await screen.findByRole("button", { name: "同事 的操作" });
    // owner 自己那一行没有菜单。
    expect(screen.queryByRole("button", { name: "管理员 的操作" })).toBeNull();
    openMenu(menu);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "签发重置链接" }),
    );
    await waitFor(() => expect(mocks.issueReset).toHaveBeenCalledWith(MEMBER));
    const link = (await screen.findByLabelText("重置链接")) as HTMLInputElement;
    expect(link.value).toBe(`${location.origin}/#reset=${token}`);
    expect(screen.getByRole("img", { name: "重置链接二维码" })).toBeTruthy();
    fireEvent.change(await screen.findByLabelText("邮箱地址"), {
      target: { value: "colleague@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送邮件" }));
    await waitFor(() =>
      expect(mocks.mailReset).toHaveBeenCalledWith({
        principalId: MEMBER,
        token,
        to: "colleague@example.com",
        locale: "zh",
      }),
    );
  });

  it("没配邮件时重置对话框里没有「发送邮件」", async () => {
    mocks.resume.mockResolvedValue(
      session(OWNER, "owner", ["identity:manage", "identity:read"]),
    );
    mocks.issueReset.mockResolvedValue({
      token: `${"f".repeat(32)}.${"R".repeat(43)}`,
      expiresAtMs: Date.now() + 1000,
    });
    mocks.mailConfigured.mockResolvedValue(false);
    mount();
    openMenu(await screen.findByRole("button", { name: "同事 的操作" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "签发重置链接" }),
    );
    expect(await screen.findByLabelText("重置链接")).toBeTruthy();
    await waitFor(() => expect(mocks.mailConfigured).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "发送邮件" })).toBeNull();
  });

  it("成员行菜单：重置两步验证先确认", async () => {
    mocks.resume.mockResolvedValue(
      session(OWNER, "owner", ["identity:manage", "identity:read"]),
    );
    mocks.resetMfa.mockResolvedValue(true);
    mount();
    openMenu(await screen.findByRole("button", { name: "同事 的操作" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "重置两步验证" }),
    );
    expect(await screen.findByText("重置「同事」的两步验证？")).toBeTruthy();
    expect(mocks.resetMfa).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重置两步验证" }));
    await waitFor(() => expect(mocks.resetMfa).toHaveBeenCalledWith(MEMBER));
  });

  it("设口令：策略拒绝按 code 显示在对话框里；warn 档命中时页顶提示", async () => {
    mocks.resume.mockResolvedValue(
      session(MEMBER, "member", ["identity:read"]),
    );
    mocks.setPassword.mockRejectedValueOnce(
      new IdentityRequestError(400, "password_too_common", "common"),
    );
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "设置口令" }));
    fireEvent.change(await screen.findByLabelText("新口令"), {
      target: { value: "password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("这个口令太常见")).toBeTruthy();
    // 对话框还开着，换一个就能设上。
    mocks.setPassword.mockResolvedValueOnce({
      revokedSessions: 0,
      passwordBreached: true,
    });
    fireEvent.change(screen.getByLabelText("新口令"), {
      target: { value: "Tr0ub4dor&3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("这个口令出现在已知泄露里")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("组管理员能替本组角色是 member 的人签重置链接", async () => {
    mocks.groupRole.mockReturnValue("admin");
    mocks.extraMembers.mockReturnValue([
      { principalId: "9".repeat(32), role: "member", joinedAtMs: 2 },
    ]);
    mocks.resume.mockResolvedValue(
      session(MEMBER, "member", ["identity:read"]),
    );
    mocks.issueReset.mockResolvedValue({
      token: `${"f".repeat(32)}.${"R".repeat(43)}`,
      expiresAtMs: Date.now() + 1000,
    });
    mount();
    fireEvent.click(await screen.findByText("前端组"));
    // 只有 member 那一行有；自己（组 admin）那一行没有。
    const buttons = await screen.findAllByRole("button", {
      name: "签发重置链接",
    });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    await waitFor(() =>
      expect(mocks.issueReset).toHaveBeenCalledWith("9".repeat(32)),
    );
    expect(await screen.findByLabelText("重置链接")).toBeTruthy();
  });
});

/** Radix 的菜单在 pointerdown 上开；jsdom 里用键盘开。 */
function openMenu(trigger: HTMLElement) {
  fireEvent.keyDown(trigger, { key: "Enter" });
}
