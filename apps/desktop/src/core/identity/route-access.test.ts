import type { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/open";
import { Router, emptyRequest } from "../http/router";
import { tempDir } from "../testing/temp-dir";
import type { AuthorizationSubject } from "./authorize";
import { runAs } from "./gate";
import { anonymousLoopbackOwner, setLoopbackAnonymousOwner } from "./http";
import { type ShareRole, roleScopes } from "./roles";
import { createRouteGuard } from "./route-access";
import { type Scope, permits, scope } from "./scopes";

/**
 * 路由门的矩阵：同一组请求，owner / driver / operator / editor / viewer /
 * 非成员各得到什么。授予在这里是一张表（成员 → 工作空间 → 角色），判定照真的
 * 那条走：角色编译成 scope，再进 `permits`。
 */

const GRANTS: Record<string, Record<string, ShareRole>> = {
  driver: { w1: "driver" },
  operator: { w1: "operator" },
  editor: { w1: "editor" },
  viewer: { w1: "viewer" },
  outsider: { w2: "driver" },
};

function subject(name: string): AuthorizationSubject {
  return name === "owner"
    ? { principalId: "", kind: "owner", scopes: [] }
    : { principalId: name, kind: "member", scopes: [scope("identity:read")] };
}

function granted(principalId: string): Scope[] {
  return Object.entries(GRANTS[principalId] ?? {}).flatMap(
    ([workspaceId, role]) => [...roleScopes(role, workspaceId)],
  );
}

/**
 * 对象 → 工作空间：终端 `t1`、节点 `n1`、审批 `p1`、关闭确认 `c1` 都在 w1 上，
 * 别的都不认识。创建者记在一张表里，像库里那一列一样跨「重启」（重建路由门）。
 *
 * 契约 §23 的几种来历各有一个终端（都在 w1 上）：`t-op` 是 operator 自己从页面
 * 起的，`t-drv` 是 driver 起的，`t-auto` 是自动化冷启动起的（owner，空串），
 * `t-ama` 是 operator 起的协调者经 ama runner（`open-agent`）建的成员——继承
 * 协调者的创建者。每个终端上挂一条待答的审批，节点 `n-<来历>` 跑着那个终端。
 */
const STATIC_CREATORS: Record<string, string> = {
  "t-op": "operator",
  "t-drv": "driver",
  "t-auto": "",
  "t-ama": "operator",
};
const APPROVAL_SESSIONS: Record<string, string> = {
  p1: "t1",
  "p-op": "t-op",
  "p-drv": "t-drv",
  "p-auto": "t-auto",
  "p-ama": "t-ama",
};
const creators = new Map<string, string>();
/** 节点记下的触发者（迁移 0035）。 */
const nodeCreators = new Map<string, string>();
const sessionCreatorOf = (id: string) =>
  creators.get(id) ?? STATIC_CREATORS[id] ?? "";
const nodeSessionOf = (id: string) =>
  id === "n1" ? "t1" : id.startsWith("n-") ? `t-${id.slice(2)}` : "";
const lookups = {
  sessionWorkspace: (id: string) =>
    id === "t1" || id in STATIC_CREATORS ? "w1" : "",
  sessionCreator: sessionCreatorOf,
  recordCreator: (id: string, principalId: string) => {
    creators.set(id, principalId);
  },
  inheritedCreator: (id: string) => nodeCreators.get(id) ?? null,
  nodeSession: nodeSessionOf,
  nodeOwner: (id: string) => {
    const session = nodeSessionOf(id);
    return session !== "" && (session === "t1" || session in STATIC_CREATORS)
      ? sessionCreatorOf(session)
      : (nodeCreators.get(id) ?? "");
  },
  nodeWorkspace: (id: string) =>
    id === "n1" || id.startsWith("n-") ? "w1" : "",
  approvalWorkspace: (id: string) => (id in APPROVAL_SESSIONS ? "w1" : ""),
  approvalCreator: (id: string) =>
    sessionCreatorOf(APPROVAL_SESSIONS[id] ?? ""),
  boardWorkspace: (id: string) => (id === "b1" ? "w1" : ""),
  workflowDraftWorkspace: (id: string) => (id === "d1" ? "w1" : ""),
  workflowRunWorkspace: (id: string) => (id === "r1" ? "w1" : ""),
  workflowTaskWorkspace: (id: string) => (id === "k1" ? "w1" : ""),
  confirmWorkspace: (id: string) => (id === "c1" ? "w1" : ""),
};

function harness() {
  const router = new Router();
  const guard = createRouteGuard({
    database: {} as DatabaseSync,
    permits: (who, required) =>
      permits([...who.scopes, ...granted(who.principalId)], required),
    effectiveScopes: (who) => [...who.scopes, ...granted(who.principalId)],
    lookups,
  });
  const decide = (
    who: string | undefined,
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ) => {
    const request = {
      ...emptyRequest(method, path),
      query: new URLSearchParams(query ?? {}),
      json: <T>() => body as T,
    };
    const run = () => guard(request, router.requiredScope(method, path));
    return who === undefined ? run() : runAs({ subject: subject(who) }, run);
  };
  return { guard, decide };
}

const PEOPLE = [
  "owner",
  "driver",
  "operator",
  "editor",
  "viewer",
  "outsider",
] as const;

function row(
  decide: ReturnType<typeof harness>["decide"],
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
): string {
  return PEOPLE.filter(
    (who) => decide(who, method, path, body, query).allowed,
  ).join(",");
}

describe("路由门的矩阵", () => {
  afterEach(() => setLoopbackAnonymousOwner(false));

  it("没有请求身份（桌面壳）时一律放行", () => {
    const { decide } = harness();
    expect(decide(undefined, "DELETE", "/api/workspaces/w1").allowed).toBe(
      true,
    );
    expect(decide(undefined, "GET", "/api/settings").allowed).toBe(true);
  });

  // 安全审查 L9：路由门对「没有请求身份」放行，GitHub 与自动化两面自己认人。
  // 回环匿名不再被当成本机主人：两面按 401 回答（`github/http.test.ts`、
  // `schedule/api.test.ts` 端到端测那一句），只有裸 core 显式打开时例外。
  it("回环匿名：路由门不替两面认人，缺省 401", () => {
    const { decide } = harness();
    expect(
      decide(undefined, "POST", "/api/github/get-credential").allowed,
    ).toBe(true);
    expect(decide(undefined, "GET", "/api/automations/plans").allowed).toBe(
      true,
    );
    const anonymous = {
      ...emptyRequest("GET", "/api/automations/plans"),
      headers: { origin: "http://127.0.0.1:1420" },
      raw: { socket: {} },
    } as unknown as Parameters<typeof anonymousLoopbackOwner>[0];
    expect(anonymousLoopbackOwner(anonymous, "")).toBe(false);
    setLoopbackAnonymousOwner(true);
    expect(anonymousLoopbackOwner(anonymous, "")).toBe(true);
  });

  it("画布读写按角色链收窄，非成员一律不放", () => {
    const { decide } = harness();
    expect(row(decide, "GET", "/api/workspaces/w1/boards")).toBe(
      "owner,driver,operator,editor,viewer",
    );
    expect(row(decide, "POST", "/api/workspaces/w1/boards")).toBe(
      "owner,driver,operator,editor",
    );
    // `open` 只是记最近打开时间，看得见就能做。
    expect(row(decide, "POST", "/api/workspaces/w1/open")).toBe(
      "owner,driver,operator,editor,viewer",
    );
    expect(row(decide, "GET", "/api/workspaces/w1/git/status")).toBe(
      "owner,driver,operator",
    );
    expect(row(decide, "GET", "/api/workspaces/w1/events")).toBe(
      "owner,driver,operator,editor,viewer",
    );
  });

  it("工作空间本身、全局设置与表外路由只有 owner", () => {
    const { decide } = harness();
    expect(row(decide, "PATCH", "/api/workspaces/w1")).toBe("owner");
    expect(row(decide, "DELETE", "/api/workspaces/w1")).toBe("owner");
    expect(row(decide, "GET", "/api/settings")).toBe("owner");
    expect(row(decide, "POST", "/api/workspaces")).toBe("owner");
    expect(row(decide, "GET", "/api/not-in-the-table")).toBe("owner");
  });

  it("身份域自己判，不经路由门", () => {
    const { decide } = harness();
    expect(row(decide, "GET", "/api/identity/groups")).toBe(PEOPLE.join(","));
    // 口令重置（契约 §25）：打开链接与设新口令先于身份，签发由身份域判
    // （owner、`identity:manage` 或组 admin 对本组成员）——路由门都不拦。
    expect(row(decide, "GET", "/api/identity/password-reset/tok")).toBe(
      PEOPLE.join(","),
    );
    expect(row(decide, "POST", "/api/identity/password-reset/tok")).toBe(
      PEOPLE.join(","),
    );
    expect(
      row(decide, "POST", "/api/identity/principals/p1/password-reset"),
    ).toBe(PEOPLE.join(","));
    expect(row(decide, "PATCH", "/api/identity/passkey/k1")).toBe(
      PEOPLE.join(","),
    );
    // 推送域同样自己认身份：登录即可，只碰请求主体自己的设备。
    expect(row(decide, "POST", "/api/push/devices")).toBe(PEOPLE.join(","));
  });

  it("能读身份是每个主体的底线：控制面的升级与 system.* 成员也过得去（契约 §35.1）", () => {
    const { decide, guard } = harness();
    expect(row(decide, "GET", "/api/ws")).toBe(PEOPLE.join(","));
    const ping = () =>
      guard(emptyRequest("POST", "rpc:system.ping"), {
        permission: "identity:read",
        workspaceId: "",
      }).allowed;
    expect(runAs({ subject: subject("outsider") }, ping)).toBe(true);
    // 快照里连 `identity:read` 都没有的主体照样不放。
    const bare: AuthorizationSubject = {
      principalId: "bare",
      kind: "member",
      scopes: [],
    };
    expect(runAs({ subject: bare }, ping)).toBe(false);
  });

  it("补全计划的新面：Gateway、凭据只有 owner；ACP、工作流查不到画布时只有 owner", () => {
    const { decide } = harness();
    expect(row(decide, "GET", "/api/gateway")).toBe("owner");
    expect(row(decide, "POST", "/api/credentials")).toBe("owner");
    expect(row(decide, "POST", "/api/acp/sessions")).toBe("owner");
    expect(row(decide, "POST", "/api/workflows/runs")).toBe("owner");
    // 实时同步与评论在路径上带着工作空间，按角色链收窄。
    expect(row(decide, "GET", "/api/workspaces/w1/boards/b1/sync")).toBe(
      "owner,driver,operator,editor,viewer",
    );
    expect(row(decide, "POST", "/api/workspaces/w1/boards/b1/comments")).toBe(
      "owner,driver,operator,editor",
    );
  });

  it("工作空间列表放行，只留看得见的", () => {
    const { decide } = harness();
    const list = [{ id: "w1" }, { id: "w2" }, { id: "w3" }];
    const visible = (who: string) =>
      (decide(who, "GET", "/api/workspaces").filter?.(list) ?? list) as {
        id: string;
      }[];
    expect(visible("owner").map((item) => item.id)).toEqual(["w1", "w2", "w3"]);
    expect(visible("viewer").map((item) => item.id)).toEqual(["w1"]);
    expect(visible("outsider").map((item) => item.id)).toEqual(["w2"]);
  });

  it("终端：开要 operator，写自己开的要 operator，写别人的要 driver", () => {
    creators.clear();
    const { decide } = harness();
    expect(
      row(decide, "POST", "/api/terminals", { workspaceId: "w1", cwd: "/" }),
    ).toBe("owner,driver,operator");
    // 读画面（capture）viewer 就够。
    expect(row(decide, "GET", "/api/terminals/t1/capture")).toBe(
      "owner,driver,operator,editor,viewer",
    );
    // 附着的 socket 能写：没记过创建者的会话按「别人的」判。
    expect(row(decide, "GET", "/api/terminals/t1/ws")).toBe("owner,driver");
    expect(row(decide, "POST", "/api/terminals/t1/paste")).toBe("owner,driver");
    // 不知道属于哪块画布的会话，成员一律不放。
    expect(row(decide, "GET", "/api/terminals/unknown/capture")).toBe("owner");
  });

  it("ACP 会话与终端同一档：按会话行与节点查画布（契约 §14.2）", () => {
    creators.clear();
    const { decide } = harness();
    expect(
      row(decide, "POST", "/api/acp/sessions", { workspaceId: "w1" }),
    ).toBe("owner,driver,operator");
    // 读镜像是看终端；发提示、取消、换模式是往会话里写。
    expect(row(decide, "GET", "/api/acp/sessions/t1/log")).toBe(
      "owner,driver,operator,editor,viewer",
    );
    expect(row(decide, "POST", "/api/acp/sessions/t1/prompt")).toBe(
      "owner,driver",
    );
    expect(row(decide, "POST", "/api/acp/sessions/unknown/prompt")).toBe(
      "owner",
    );
    // 切换驱动会结束一个进程、起另一个：driver 一档。
    expect(row(decide, "POST", "/api/acp/nodes/n1/driver")).toBe(
      "owner,driver",
    );
    // 自己开的 ACP 会话自己能发提示。
    const created = harness().decide("operator", "POST", "/api/acp/sessions", {
      workspaceId: "w1",
    });
    created.filter?.({ id: "t1" });
    expect(
      harness().decide("operator", "POST", "/api/acp/sessions/t1/prompt")
        .allowed,
    ).toBe(true);
    creators.clear();
  });

  it("请求体里的节点属于别的画布：终端与 ACP 会话都拒（安全审查 H1）", () => {
    creators.clear();
    const { decide } = harness();
    for (const path of ["/api/terminals", "/api/acp/sessions"]) {
      // outsider 是 w2 上的 driver；n1 在 w1 上。
      expect(
        row(decide, "POST", path, { workspaceId: "w2", nodeId: "n1" }),
        path,
      ).toBe("owner");
      expect(
        row(decide, "POST", path, { workspaceId: "w1", nodeId: "n1" }),
        path,
      ).toBe("owner,driver,operator");
      // 还没落库的新节点认不出画布：照体里的工作空间判。
      expect(
        row(decide, "POST", path, { workspaceId: "w2", nodeId: "fresh" }),
        path,
      ).toBe("owner,outsider");
    }
    creators.clear();
  });

  it("operator 自己开的终端自己能写，路由门重建（core 重启）之后照旧", () => {
    creators.clear();
    const created = harness().decide("operator", "POST", "/api/terminals", {
      workspaceId: "w1",
    });
    expect(created.allowed).toBe(true);
    created.filter?.({ id: "t1" });
    expect(creators.get("t1")).toBe("operator");
    // 新的一道门：内存里什么都没有，创建者只在「库」里。
    const { decide } = harness();
    expect(decide("operator", "POST", "/api/terminals/t1/paste").allowed).toBe(
      true,
    );
    expect(decide("operator", "GET", "/api/terminals/t1/ws").allowed).toBe(
      true,
    );
    // 别人仍然要 driver。
    expect(decide("editor", "POST", "/api/terminals/t1/paste").allowed).toBe(
      false,
    );
    expect(row(decide, "POST", "/api/terminals/t1/paste")).toBe(
      "owner,driver,operator",
    );
    creators.clear();
  });
});

describe("契约 §23：创建者 = 触发者与工作流", () => {
  it("工作流列表与起跑按查询串 / 请求体的画板落到画布", () => {
    const { decide } = harness();
    expect(
      row(decide, "GET", "/api/workflows/runs", undefined, { boardId: "b1" }),
    ).toBe("owner,driver,operator,editor,viewer");
    expect(
      row(decide, "GET", "/api/workflows/drafts", undefined, { boardId: "b1" }),
    ).toBe("owner,driver,operator,editor,viewer");
    expect(
      row(decide, "GET", "/api/workflows/runs", undefined, { boardId: "b9" }),
    ).toBe("owner");
    expect(
      row(decide, "POST", "/api/workflows/runs", {
        templateId: "x1",
        boardId: "b1",
      }),
    ).toBe("owner,driver,operator");
    expect(
      row(decide, "POST", "/api/workflows/runs", { templateId: "x1" }),
    ).toBe("owner");
  });

  it("分派抽屉：任务列表按画板看画布，重试是 operator（契约 §15.7）", () => {
    const { decide } = harness();
    expect(
      row(decide, "GET", "/api/workflows/tasks", undefined, { boardId: "b1" }),
    ).toBe("owner,driver,operator,editor,viewer");
    expect(
      row(decide, "GET", "/api/workflows/tasks", undefined, { boardId: "b9" }),
    ).toBe("owner");
    expect(row(decide, "GET", "/api/workflows/tasks")).toBe("owner");
    expect(row(decide, "POST", "/api/workflows/tasks/k1/retry")).toBe(
      "owner,driver,operator",
    );
    expect(row(decide, "POST", "/api/workflows/tasks/k9/retry")).toBe("owner");
    expect(row(decide, "GET", "/api/workflows/tasks/k1/retry")).toBe("owner");
  });

  it("节点记过触发者时，起它的人不改写创建者", () => {
    creators.clear();
    nodeCreators.set("n-new", "operator");
    // driver 的页面先挂载、替 operator 的协调者建的节点起了终端：库已按触发者
    // 写好（迁移 0035 的触发器），路由门不再记成 driver。
    const opened = harness().decide("driver", "POST", "/api/terminals", {
      workspaceId: "w1",
      nodeId: "n-new",
    });
    opened.filter?.({ id: "t-new", ownerNodeId: "n-new" });
    expect(creators.has("t-new")).toBe(false);
    // 没记过触发者的节点照旧记起它的人。
    harness()
      .decide("operator", "POST", "/api/terminals", { workspaceId: "w1" })
      .filter?.({ id: "t-plain", ownerNodeId: null });
    expect(creators.get("t-plain")).toBe("operator");
    nodeCreators.clear();
    creators.clear();
  });

  it("ACP 开会话答的是已有的那一行时，不把别人的会话改成自己的", () => {
    creators.clear();
    // n-drv 上活着的是 driver 起的 t-drv；operator 再开一次，答的还是 t-drv。
    const again = harness().decide("operator", "POST", "/api/acp/sessions", {
      workspaceId: "w1",
      nodeId: "n-drv",
    });
    expect(again.allowed).toBe(true);
    again.filter?.({ id: "t-drv" });
    expect(creators.has("t-drv")).toBe(false);
    expect(
      harness().decide("operator", "POST", "/api/acp/sessions/t-drv/prompt")
        .allowed,
    ).toBe(false);
    // 真起了新的一行才记。
    harness()
      .decide("operator", "POST", "/api/acp/sessions", {
        workspaceId: "w1",
        nodeId: "fresh",
      })
      .filter?.({ id: "t-fresh" });
    expect(creators.get("t-fresh")).toBe("operator");
    creators.clear();
  });

  it("还没起过终端的节点按记下的触发者判驱动切换", () => {
    nodeCreators.set("n-idle", "operator");
    const { decide } = harness();
    expect(row(decide, "POST", "/api/acp/nodes/n-idle/driver")).toBe(
      "owner,driver,operator",
    );
    nodeCreators.clear();
    expect(row(decide, "POST", "/api/acp/nodes/n-idle/driver")).toBe(
      "owner,driver",
    );
  });
});

/**
 * 全局路由的权限表（设计 §6）：每一行是一条路由对六个人的答案。成员能不能
 * 做由它落到哪块画布决定；落不到画布的，要么是无害的全局读（被共享了任意一块
 * 画布就行），要么是本机管理（只有 owner）。
 */
describe("全局路由的权限表", () => {
  const SHARED = "owner,driver,operator,editor,viewer,outsider";
  const W1_ALL = "owner,driver,operator,editor,viewer";
  const TABLE: readonly [string, string, string][] = [
    // 无害的全局读
    ["GET", "/api/agents", SHARED],
    ["GET", "/api/agents/claude/models", SHARED],
    ["GET", "/api/models/catalog", SHARED],
    ["GET", "/api/terminals/backend", SHARED],
    ["GET", "/api/usage/status", SHARED],
    // 按对象落到工作空间
    ["POST", "/api/agent-status/n1/read", W1_ALL],
    ["GET", "/api/agent-status/n1/transcript", W1_ALL],
    [
      "POST",
      "/api/agent-status/n1/suggest-title",
      "owner,driver,operator,editor",
    ],
    ["GET", "/api/nodes/n1/context-reads", W1_ALL],
    ["POST", "/api/approvals/p1/answer", "owner,driver"],
    // 契约 §23：operator 答自己起的终端上的审批；别人起的、自动化冷启动起的
    // （owner）只有 driver；operator 的协调者经 ama runner 建的成员继承他。
    ["POST", "/api/approvals/p-op/answer", "owner,driver,operator"],
    ["POST", "/api/approvals/p-drv/answer", "owner,driver"],
    ["POST", "/api/approvals/p-auto/answer", "owner,driver"],
    ["POST", "/api/approvals/p-ama/answer", "owner,driver,operator"],
    // 驱动切换与往会话里写同一套「自己的 / 别人的」。
    ["POST", "/api/acp/nodes/n-op/driver", "owner,driver,operator"],
    ["POST", "/api/acp/nodes/n-drv/driver", "owner,driver"],
    ["POST", "/api/acp/sessions/t-ama/prompt", "owner,driver,operator"],
    ["POST", "/api/acp/sessions/t-auto/prompt", "owner,driver"],
    ["POST", "/api/terminals/t-ama/paste", "owner,driver,operator"],
    // 工作流（契约 §23.3）：按草案 / 运行查画布。
    ["GET", "/api/workflows/runs/r1", W1_ALL],
    ["POST", "/api/workflows/runs/r1/cancel", "owner,driver,operator"],
    ["POST", "/api/workflows/runs/r1/gates/s1", "owner,driver,operator"],
    ["POST", "/api/workflows/runs/unknown/gates/s1", "owner"],
    ["GET", "/api/workflows/drafts/d1", W1_ALL],
    ["POST", "/api/workflows/drafts/d1/confirm", "owner,driver,operator"],
    ["POST", "/api/workflows/drafts/d1/discard", "owner,driver,operator"],
    // 列表不带画板：答案过滤不到 raw 路由，成员一律不放。
    ["GET", "/api/workflows/runs", "owner"],
    ["GET", "/api/workflows/drafts", "owner"],
    // 模板是本机共用的库：在哪块画布上能起 Agent 就能读，改只有 owner。
    ["GET", "/api/workflows/templates", "owner,driver,operator,outsider"],
    ["GET", "/api/workflows/templates/x1", "owner,driver,operator,outsider"],
    ["POST", "/api/workflows/templates", "owner"],
    ["PUT", "/api/workflows/templates/x1", "owner"],
    ["DELETE", "/api/workflows/templates/x1", "owner"],
    ["GET", "/api/workflows/nowhere", "owner"],
    ["POST", "/api/control/confirm/c1", "owner,driver"],
    // 找不到对象的：只有 owner
    ["POST", "/api/agent-status/unknown/read", "owner"],
    ["GET", "/api/nodes/unknown/context-reads", "owner"],
    ["POST", "/api/approvals/unknown/answer", "owner"],
    ["POST", "/api/control/confirm/unknown", "owner"],
    // 本机管理
    ["GET", "/api/settings", "owner"],
    ["PATCH", "/api/settings", "owner"],
    ["GET", "/api/settings/local", "owner"],
    ["PUT", "/api/settings/local", "owner"],
    ["POST", "/api/models/catalog/refresh", "owner"],
    ["GET", "/api/agents/claude/integration", "owner"],
    ["POST", "/api/agents/claude/integration/install", "owner"],
    ["GET", "/api/execution-hosts", "owner"],
    ["POST", "/api/execution-hosts", "owner"],
    ["GET", "/api/ssh/hosts/h1/test", "owner"],
    ["GET", "/api/ssh/prompts", "owner"],
    ["GET", "/api/data/info", "owner"],
    ["POST", "/api/data/backup", "owner"],
    ["GET", "/api/usage", "owner"],
    ["GET", "/api/usage/copilot", "owner"],
    ["GET", "/api/conversations", "owner"],
    ["POST", "/api/git/clone", "owner"],
    ["GET", "/api/power", "owner"],
    ["POST", "/api/power/leases", "owner"],
    ["GET", "/api/github/status", "owner"],
    ["GET", "/api/automations/plans", "owner"],
    ["POST", "/browser/open", "owner"],
    ["POST", "/api/terminals/t1/node-token/refresh", "owner"],
    ["GET", "/api/ownership", "owner"],
  ];

  for (const [method, path, expected] of TABLE) {
    it(`${method} ${path}`, () => {
      const { decide } = harness();
      expect(row(decide, method, path)).toBe(expected);
    });
  }

  it("没被共享任何画布的成员连无害的全局读也没有", () => {
    const { decide } = harness();
    expect(decide("stranger", "GET", "/api/agents").allowed).toBe(false);
    expect(decide("stranger", "GET", "/api/terminals/backend").allowed).toBe(
      false,
    );
  });
});

describe("真库上的查询", () => {
  it("终端创建者落进会话行，新建的路由门照样认；节点与审批按库找画布", () => {
    const opened = openDatabase({
      file: join(tempDir("armadra-route-access-"), "canvas.db"),
      migrationsDir: resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../db/migrations",
      ),
    });
    try {
      const db = opened.database;
      db.prepare(
        "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES ('w1', 'w1', '/tmp/w1', 'x', 'x')",
      ).run();
      db.prepare(
        "INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, status, created_at) VALUES ('t1', 'w1', '/', 'sh', 'running', 'x')",
      ).run();
      db.prepare(
        "INSERT INTO agent_status (node_id, workspace_id, agent_id, updated_at) VALUES ('n1', 'w1', 'claude', 'x')",
      ).run();
      db.prepare(
        "INSERT INTO agent_approvals (id, node_id, workspace_id, request_json, created_at) VALUES ('p1', 'n1', 'w1', '{}', 'x')",
      ).run();
      // 每次判定都新建一道门：内存里什么也不留，像每次都是重启之后。
      const as = (who: string, method: string, path: string, body?: unknown) =>
        runAs({ subject: subject(who) }, () =>
          createRouteGuard({
            database: db,
            permits: (actor, required) =>
              permits(
                [...actor.scopes, ...granted(actor.principalId)],
                required,
              ),
          })(
            { ...emptyRequest(method, path), json: <T>() => body as T },
            new Router().requiredScope(method, path),
          ),
        );

      expect(as("operator", "POST", "/api/terminals/t1/paste").allowed).toBe(
        false,
      );
      as("operator", "POST", "/api/terminals", { workspaceId: "w1" }).filter?.({
        id: "t1",
      });
      expect(
        db.prepare("SELECT creator_principal_id FROM terminal_sessions").get(),
      ).toEqual({ creator_principal_id: "operator" });
      expect(as("operator", "POST", "/api/terminals/t1/paste").allowed).toBe(
        true,
      );
      expect(as("viewer", "POST", "/api/agent-status/n1/read").allowed).toBe(
        true,
      );
      expect(as("outsider", "POST", "/api/agent-status/n1/read").allowed).toBe(
        false,
      );
      expect(as("driver", "POST", "/api/approvals/p1/answer").allowed).toBe(
        true,
      );
      expect(as("operator", "POST", "/api/approvals/p1/answer").allowed).toBe(
        false,
      );
      expect(as("viewer", "GET", "/api/nodes/n1/context-reads").allowed).toBe(
        true,
      );
    } finally {
      opened.close();
    }
  });
});
