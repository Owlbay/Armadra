import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "../identity/scopes";
import { routeScope, selfGuarded, workspaceOf } from "./route-scopes";
import { Router } from "./router";
import { ROUTES } from "./routes";

/**
 * 路由的 scope 声明（设计 §4.1）。
 *
 * 最重要的一条不是某条路由要什么权限，而是**没有一条已实现的路由是漏掉的**：
 * 漏掉一条，等到有第二个 principal 时它就是一个默认放行的洞。
 */
describe("路由要求的 scope", () => {
  it("每条已实现的运行时路由都声明了权限", () => {
    const router = new Router();
    const missing: string[] = [];
    for (const entry of ROUTES) {
      if (entry.surface !== "runtime" || entry.implemented !== true) continue;
      for (const method of entry.methods) {
        // 健康检查与 Hello 先于任何身份存在：前者答「core 起来了」，后者答
        // 「这台 core 是谁、支持什么」，两者都要在一次配对之前就说得出来。
        if (entry.path.endsWith("/health")) continue;
        if (entry.path === "/api/identity/hello") continue;
        // 配对短码换票同理：手机还没有身份，短码就是凭据（契约 §24）。
        if (entry.path === "/api/gateway/pairing-code/exchange") continue;
        // 云登录同理：断言就是凭据，用它换的正是第一个会话（契约 §31）。
        if (entry.path === "/api/identity/cloud/login") continue;
        if (router.requiredScope(method, entry.path) === undefined) {
          missing.push(`${method} ${entry.path}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("声明出来的权限名都在授权词汇表里", () => {
    const router = new Router();
    for (const entry of ROUTES) {
      if (entry.surface !== "runtime") continue;
      for (const method of entry.methods) {
        const required = router.requiredScope(method, entry.path);
        if (required === undefined) continue;
        expect(PERMISSIONS as readonly string[]).toContain(required.permission);
      }
    }
  });

  it("读与写分开，终端的开与写也分开", () => {
    expect(
      routeScope("GET", "/api/workspaces/{workspaceId}/git/status"),
    ).toEqual({ permission: "git:read", workspaceId: "" });
    expect(
      routeScope("POST", "/api/workspaces/{workspaceId}/git/commit"),
    ).toEqual({ permission: "git:write", workspaceId: "" });
    // 只读、旧路径却是 POST 的两条按读算；同族的批量状态仍是写。
    for (const path of ["git/log", "git/repository/worktree-binding"]) {
      expect(
        routeScope("POST", `/api/workspaces/{workspaceId}/${path}`)?.permission,
        path,
      ).toBe("git:read");
    }
    expect(
      routeScope(
        "POST",
        "/api/workspaces/{workspaceId}/git/repository/status-batch",
      )?.permission,
    ).toBe("git:write");
    expect(
      routeScope("POST", "/api/workspaces/{workspaceId}/git/log/extra")
        ?.permission,
    ).toBe("git:write");
    expect(routeScope("POST", "/api/terminals")?.permission).toBe(
      "terminal:create",
    );
    expect(routeScope("POST", "/api/terminals/abc/paste")?.permission).toBe(
      "terminal:write",
    );
    expect(routeScope("GET", "/api/terminals/abc/ws")?.permission).toBe(
      "terminal:read",
    );
    expect(routeScope("POST", "/api/approvals/p1/answer")?.permission).toBe(
      "approval:answer",
    );
    // 「在访达中显示」会拉起一个程序，和开终端同一档，不是读文件那一档。
    expect(
      routeScope("POST", "/api/workspaces/{workspaceId}/reveal")?.permission,
    ).toBe("terminal:create");
  });

  it("健康检查不要求任何权限", () => {
    expect(routeScope("GET", "/health")).toBeUndefined();
    expect(routeScope("GET", "/api/health")).toBeUndefined();
  });

  it("真实路径上的授权绑在那个工作空间上", () => {
    const router = new Router();
    // 表里没有的路径也照样算得出要求：路由表回 404 之前，判定入口已经知道
    // 这条路径属于哪块画布。
    expect(
      router.requiredScope("GET", "/api/workspaces/w-7/canvas-missing"),
    ).toEqual({ permission: "canvas:read", workspaceId: "w-7" });
    expect(
      router.requiredScope("GET", "/api/workspaces/w-7/git/status"),
    ).toEqual({ permission: "git:read", workspaceId: "w-7" });
    expect(workspaceOf("/api/workspaces/{workspaceId}/git/status")).toBe("");
    expect(workspaceOf("/api/workspaces/w%201/git/status")).toBe("w 1");
  });

  it("登记时就地声明的权限盖过表", () => {
    const router = new Router();
    router.handle(
      "GET",
      "/api/workspaces/{workspaceId}/git/status",
      () => ({ status: 200 }),
      { scope: "identity:manage" },
    );
    expect(
      router.requiredScope("GET", "/api/workspaces/w-7/git/status"),
    ).toEqual({ permission: "identity:manage", workspaceId: "w-7" });
    // 没声明的方法仍然按表来。
    expect(
      router.requiredScope("POST", "/api/workspaces/w-7/git/status"),
    ).toEqual({ permission: "git:write", workspaceId: "w-7" });
  });
});

/**
 * 补全计划的新面（G0-3）：路由还没写，权限先按前缀声明好，后面的包只登记
 * 路由、不再改这张表。
 */
describe("补全计划新面的 scope", () => {
  const permission = (method: string, path: string) =>
    routeScope(method, path)?.permission;

  it("ACP：看会话同看终端，开会话同开终端", () => {
    expect(permission("GET", "/api/acp/sessions")).toBe("terminal:read");
    expect(permission("GET", "/api/acp/sessions/s1")).toBe("terminal:read");
    expect(permission("POST", "/api/acp/sessions")).toBe("terminal:create");
    expect(permission("PUT", "/api/acp/nodes/n1/driver")).toBe(
      "terminal:create",
    );
  });

  it("工作流：读是看画布，写要 operator 那一档", () => {
    expect(permission("GET", "/api/workflows/templates")).toBe("canvas:read");
    expect(permission("POST", "/api/workflows/runs")).toBe("agent:launch");
    expect(permission("POST", "/api/workflows/drafts/d1/confirm")).toBe(
      "agent:launch",
    );
  });

  it("实时同步与评论：读 canvas:read，写 canvas:write，且先于看板那一档", () => {
    expect(routeScope("GET", "/api/workspaces/w-1/boards/b-1/sync")).toEqual({
      permission: "canvas:read",
      workspaceId: "w-1",
    });
    expect(
      permission("POST", "/api/workspaces/{workspaceId}/boards/{boardId}/sync"),
    ).toBe("canvas:write");
    expect(permission("GET", "/api/workspaces/w-1/boards/b-1/comments")).toBe(
      "canvas:read",
    );
    expect(
      routeScope("DELETE", "/api/workspaces/w-1/boards/b-1/comments/c-1"),
    ).toEqual({ permission: "canvas:write", workspaceId: "w-1" });
  });

  it("Gateway 与节点凭据只有 owner：全局的设置那一档", () => {
    for (const path of ["/api/gateway", "/api/gateway/pairing"]) {
      expect(routeScope("GET", path)).toEqual({
        permission: "settings:read",
        workspaceId: "",
      });
      expect(routeScope("POST", path)?.permission).toBe("settings:write");
    }
    expect(permission("GET", "/api/credentials")).toBe("settings:read");
    expect(permission("DELETE", "/api/credentials/c1")).toBe("settings:write");
  });

  it("推送与身份域自己认身份，路由门不判", () => {
    expect(selfGuarded("/api/push/devices")).toBe(true);
    expect(selfGuarded("/api/identity/passkey/register/options")).toBe(true);
    expect(selfGuarded("/health")).toBe(true);
    expect(selfGuarded("/api/gateway")).toBe(false);
    expect(selfGuarded("/api/pushy")).toBe(false);
    expect(selfGuarded("/api/acp/sessions")).toBe(false);
  });

  it("身份扩展按 §18 分别声明：登录那几步不要求权限", () => {
    expect(
      routeScope("POST", "/api/identity/passkey/login/options"),
    ).toBeUndefined();
    expect(
      routeScope("POST", "/api/identity/passkey/login/verify"),
    ).toBeUndefined();
    expect(routeScope("POST", "/api/identity/mfa/verify")).toBeUndefined();
    expect(routeScope("GET", "/api/identity/oauth/dex/start")).toBeUndefined();
    expect(
      routeScope("GET", "/api/identity/oauth/dex/callback"),
    ).toBeUndefined();
    expect(permission("POST", "/api/identity/passkey/register/options")).toBe(
      "identity:manage",
    );
    expect(permission("GET", "/api/identity/passkey")).toBe("identity:read");
    expect(permission("POST", "/api/identity/mfa/totp")).toBe(
      "identity:manage",
    );
    expect(permission("DELETE", "/api/identity/oauth/bindings/b1")).toBe(
      "identity:manage",
    );
    expect(permission("GET", "/api/identity/sessions")).toBe("identity:read");
    expect(permission("DELETE", "/api/identity/sessions/s1")).toBe(
      "identity:manage",
    );
    expect(permission("GET", "/api/identity/audit")).toBe("identity:read");
  });

  it("新声明的权限名都在授权词汇表里", () => {
    const paths = [
      "/api/acp/sessions",
      "/api/workflows/runs",
      "/api/workspaces/w/boards/b/sync",
      "/api/workspaces/w/boards/b/comments",
      "/api/gateway",
      "/api/credentials",
      "/api/push/devices",
      "/api/identity/passkey",
      "/api/identity/mfa/totp",
      "/api/identity/oauth/bindings",
      "/api/identity/sessions",
      "/api/identity/audit",
      "/api/identity/principals/p1/password-reset",
      "/api/forge/repos/r1",
      "/api/mail/status",
      "/api/diagnostics/client-error",
    ];
    for (const path of paths) {
      for (const method of ["GET", "POST"]) {
        const required = routeScope(method, path);
        expect(required, `${method} ${path}`).toBeDefined();
        expect(PERMISSIONS as readonly string[]).toContain(
          required?.permission,
        );
      }
    }
  });

  it("G5 预登记的新前缀：先于身份的两条不要求权限，其余各归一档", () => {
    // 先于任何身份存在：令牌 / 短码本身就是凭据。
    expect(
      routeScope("GET", "/api/identity/password-reset/tok"),
    ).toBeUndefined();
    expect(
      routeScope("POST", "/api/identity/password-reset/tok"),
    ).toBeUndefined();
    expect(
      routeScope("POST", "/api/gateway/pairing-code/exchange"),
    ).toBeUndefined();
    expect(selfGuarded("/api/gateway/pairing-code/exchange")).toBe(true);
    // 签发短码以外的 Gateway 面仍只有 owner。
    expect(selfGuarded("/api/gateway/pairing-code")).toBe(false);
    expect(permission("POST", "/api/gateway/pairing-code")).toBe(
      "settings:write",
    );
    expect(
      permission("POST", "/api/identity/principals/p1/password-reset"),
    ).toBe("identity:manage");
    // 托管平台与 GitHub 同一档，路由门要判。
    expect(selfGuarded("/api/forge/repos/r1")).toBe(false);
    expect(permission("GET", "/api/forge/repos/r1")).toBe("github:read");
    expect(permission("POST", "/api/forge/repos/r1/pulls")).toBe(
      "github:write",
    );
    // 邮件与页面错误上报自己认身份。
    expect(selfGuarded("/api/mail/status")).toBe(true);
    expect(selfGuarded("/api/mail/password-reset")).toBe(true);
    expect(selfGuarded("/api/diagnostics/client-error")).toBe(true);
    expect(selfGuarded("/api/diagnostics/runtime")).toBe(true);
    expect(routeScope("GET", "/api/diagnostics/runtime")).toBeDefined();
    expect(selfGuarded("/api/diagnostics/client-error/x")).toBe(false);
    expect(permission("POST", "/api/mail/invitation")).toBe("identity:manage");
  });
});
