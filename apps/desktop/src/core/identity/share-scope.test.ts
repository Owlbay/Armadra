import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { Router, emptyRequest } from "../http/router";
import type { AuthorizationSubject } from "./authorize";
import { runAs } from "./gate";
import {
  type GrantTargetKind,
  HOST_WORKSPACE,
  type ShareRole,
  grantScopes,
  hostRoleScopes,
  roleScopes,
  sessionViewerScopes,
} from "./roles";
import { createRouteGuard } from "./route-access";
import {
  decodeScopes,
  encodeScopes,
  normalizeScopes,
  permits,
  scope,
} from "./scopes";

/**
 * 契约 §60 的授权矩阵：授予指向整台 / 工作空间 / 会话三种目标，编译成 scope 后
 * 走同一条 `permits`。会话查看者只读得到那一条终端 / ACP，画布、文件、别的会话与
 * 一切写入都是 403；只读的工作空间分享（viewer）同样写不进去。
 */

describe("scope 的资源维度", () => {
  it("受限的授权不满足不带资源的请求，不限的授权满足带资源的请求", () => {
    const session = [scope("terminal:read", "w1", "", "t1")];
    const workspace = [scope("terminal:read", "w1")];
    expect(permits(session, [scope("terminal:read", "w1", "", "t1")])).toBe(
      true,
    );
    expect(permits(session, [scope("terminal:read", "w1", "", "t2")])).toBe(
      false,
    );
    expect(permits(session, [scope("terminal:read", "w1")])).toBe(false);
    expect(permits(session, [scope("terminal:read", "w2", "", "t1")])).toBe(
      false,
    );
    expect(permits(workspace, [scope("terminal:read", "w1", "", "t1")])).toBe(
      true,
    );
  });

  it("库里的字节：不带资源的与旧版逐字相同，带资源的解得回来", () => {
    expect(encodeScopes([scope("canvas:read", "w1")]).toString("utf8")).toBe(
      '[{"Permission":"canvas:read","WorkspaceID":"w1","ExecutionHostID":""}]',
    );
    const wire = encodeScopes([scope("terminal:read", "w1", "", "t1")]);
    expect(decodeScopes(wire)).toEqual([
      scope("terminal:read", "w1", "", "t1"),
    ]);
  });

  it("资源要有工作空间；身份授权不能带资源", () => {
    expect(() =>
      normalizeScopes([scope("terminal:read", "", "", "t1")]),
    ).toThrow();
    expect(() =>
      normalizeScopes([scope("identity:read", "", "", "t1")]),
    ).toThrow();
  });
});

describe("授予按目标编译", () => {
  it("整台 = 不带工作空间的同一串角色权限，不含本机管理", () => {
    const host = hostRoleScopes("editor");
    expect(host.map((value) => value.Permission)).toEqual(
      roleScopes("editor", "w1").map((value) => value.Permission),
    );
    expect(host.every((value) => value.WorkspaceID === "")).toBe(true);
    expect(permits(host, [scope("canvas:write", "w9")])).toBe(true);
    expect(permits(host, [scope("settings:read")])).toBe(false);
    expect(permits(host, [scope("workspace:share", "w1")])).toBe(false);
  });

  it("会话授予无论记的角色是什么都只读那一条", () => {
    const compiled = grantScopes({
      targetKind: "session",
      workspaceId: "w1",
      targetId: "t1",
      role: "driver",
    });
    expect(compiled).toEqual(sessionViewerScopes("w1", "t1"));
    expect(permits(compiled, [scope("canvas:read", "w1")])).toBe(false);
    expect(permits(compiled, [scope("terminal:write", "w1", "", "t1")])).toBe(
      false,
    );
  });
});

/* ------------------------------ 路由门矩阵 ------------------------------ */

interface Grant {
  readonly targetKind: GrantTargetKind;
  readonly workspaceId: string;
  readonly targetId: string;
  readonly role: ShareRole;
}

const GRANTS: Record<string, readonly Grant[]> = {
  "host-editor": [
    {
      targetKind: "host",
      workspaceId: HOST_WORKSPACE,
      targetId: "",
      role: "editor",
    },
  ],
  "host-viewer": [
    {
      targetKind: "host",
      workspaceId: HOST_WORKSPACE,
      targetId: "",
      role: "viewer",
    },
  ],
  "ws-viewer": [
    {
      targetKind: "workspace",
      workspaceId: "w1",
      targetId: "",
      role: "viewer",
    },
  ],
  "sess-viewer": [
    {
      targetKind: "session",
      workspaceId: "w1",
      targetId: "t1",
      role: "viewer",
    },
  ],
};
const PEOPLE = ["host-editor", "host-viewer", "ws-viewer", "sess-viewer"];

function granted(principalId: string) {
  return (GRANTS[principalId] ?? []).flatMap((grant) => [
    ...grantScopes(grant),
  ]);
}

function subject(name: string): AuthorizationSubject {
  return {
    principalId: name,
    kind: "member",
    scopes: [scope("identity:read")],
  };
}

const WORKSPACE_OF: Record<string, string> = { t1: "w1", t2: "w1", t3: "w2" };

function harness() {
  const router = new Router();
  const guard = createRouteGuard({
    database: {} as DatabaseSync,
    permits: (who, required) =>
      permits([...who.scopes, ...granted(who.principalId)], required),
    effectiveScopes: (who) => [...who.scopes, ...granted(who.principalId)],
    lookups: {
      sessionWorkspace: (id) => WORKSPACE_OF[id] ?? "",
      sessionCreator: () => "",
      recordCreator: () => undefined,
      inheritedCreator: () => null,
      nodeSession: () => "",
      nodeOwner: () => "",
      nodeWorkspace: () => "",
      approvalWorkspace: () => "",
      approvalCreator: () => "",
      boardWorkspace: (id) => (id === "b1" ? "w1" : ""),
      workflowDraftWorkspace: () => "",
      workflowRunWorkspace: () => "",
      workflowTaskWorkspace: () => "",
      confirmWorkspace: () => "",
    },
  });
  return (method: string, path: string, body?: unknown) =>
    PEOPLE.filter((who) => {
      const request = {
        ...emptyRequest(method, path),
        json: <T>() => body as T,
      };
      return runAs({ subject: subject(who) }, () =>
        guard(request, router.requiredScope(method, path)),
      ).allowed;
    }).join(",");
}

describe("§60 路由门：整台 / 工作空间 / 会话", () => {
  it("读：会话查看者只读得到那一条终端与 ACP", () => {
    const allowed = harness();
    expect(allowed("GET", "/api/terminals/t1/capture")).toBe(
      "host-editor,host-viewer,ws-viewer,sess-viewer",
    );
    expect(allowed("GET", "/api/acp/sessions/t1/log")).toBe(
      "host-editor,host-viewer,ws-viewer,sess-viewer",
    );
    // 同一工作空间的另一条会话、另一个工作空间的会话：会话查看者都读不到。
    expect(allowed("GET", "/api/terminals/t2/capture")).toBe(
      "host-editor,host-viewer,ws-viewer",
    );
    expect(allowed("GET", "/api/acp/sessions/t2/log")).toBe(
      "host-editor,host-viewer,ws-viewer",
    );
    expect(allowed("GET", "/api/terminals/t3/capture")).toBe(
      "host-editor,host-viewer",
    );
  });

  it("画布：会话查看者 403，整台授予覆盖每一块画布", () => {
    const allowed = harness();
    expect(allowed("GET", "/api/workspaces/w1/boards")).toBe(
      "host-editor,host-viewer,ws-viewer",
    );
    expect(allowed("GET", "/api/workspaces/w2/boards")).toBe(
      "host-editor,host-viewer",
    );
    expect(allowed("GET", "/api/workspaces/w1/events")).toBe(
      "host-editor,host-viewer,ws-viewer,sess-viewer",
    );
  });

  it("只读不能写：终端输入、画布修改、文件写入都被拒", () => {
    const allowed = harness();
    for (const [method, path, body] of [
      ["POST", "/api/terminals/t1/paste", { text: "y\n" }],
      ["POST", "/api/terminals", { workspaceId: "w1", cwd: "/" }],
      ["GET", "/api/terminals/t1/ws"],
      ["POST", "/api/acp/sessions/t1/prompt", { text: "hi" }],
    ] as const) {
      expect(allowed(method, path, body), `${method} ${path}`).toBe("");
    }
    // 画布与文件写：只有整台 editor 过得去。
    expect(allowed("POST", "/api/workspaces/w1/boards")).toBe("host-editor");
    expect(allowed("PUT", "/api/workspaces/w1/boards/b1")).toBe("host-editor");
    expect(allowed("POST", "/api/workspaces/w1/boards/b1/comments")).toBe(
      "host-editor",
    );
    expect(allowed("POST", "/api/workspaces/w1/file")).toBe("");
    expect(allowed("GET", "/api/workspaces/w1/file")).toBe("");
  });

  it("本机管理：整台授予也拿不到设置、工作空间增删与分享", () => {
    const allowed = harness();
    expect(allowed("GET", "/api/settings")).toBe("");
    expect(allowed("POST", "/api/workspaces")).toBe("");
    expect(allowed("PATCH", "/api/workspaces/w1")).toBe("");
  });
});
