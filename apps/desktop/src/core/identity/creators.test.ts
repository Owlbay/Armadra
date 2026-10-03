import type { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/open";
import { Router, emptyRequest } from "../http/router";
import { stampColdStartCreator } from "../schedule/cold-start";
import { tempDir } from "../testing/temp-dir";
import type { AuthorizationSubject } from "./authorize";
import {
  AUTOMATION_CREATOR,
  nodeCreator,
  nodeOwnerPrincipal,
  recordNodeCreator,
  requestTrigger,
  sessionCreator,
} from "./creators";
import { runAs } from "./gate";
import { type ShareRole, roleScopes } from "./roles";
import { createRouteGuard } from "./route-access";
import { permits, scope } from "./scopes";

/**
 * 契约 §23「创建者 = 触发者」在真库上：节点记下的触发者经迁移 0035 的触发器
 * 落进每一个之后起的会话行；冷启动按自动化的创建者改写；路由门用库里的查询
 * 判审批、驱动切换与工作流。
 */

let opened: ReturnType<typeof openDatabase>;
let db: DatabaseSync;

beforeEach(() => {
  opened = openDatabase({
    file: join(tempDir("armadra-creators-"), "canvas.db"),
    migrationsDir: resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../db/migrations",
    ),
  });
  db = opened.database;
  db.prepare(
    "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES ('w1', 'w1', '/tmp/w1', 'x', 'x')",
  ).run();
  db.prepare(
    "INSERT INTO boards (id, workspace_id, name, created_at, updated_at) VALUES ('b1', 'w1', 'b1', 'x', 'x')",
  ).run();
});

afterEach(() => {
  opened.close();
});

let sequence = 0;
/** 像终端管理器那样插一行：从不写创建者那一列。 */
function spawn(nodeId: string | null): string {
  sequence += 1;
  const id = `t${sequence}`;
  db.prepare(
    "INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, status, created_at, owner_node_id) " +
      "VALUES (?, 'w1', '/', 'sh', 'running', ?, ?)",
  ).run(id, `2026-10-03T00:00:${String(sequence).padStart(2, "0")}Z`, nodeId);
  return id;
}

const GRANTS: Record<string, ShareRole> = {
  driver: "driver",
  operator: "operator",
  "operator-b": "operator",
  editor: "editor",
};

function member(name: string): AuthorizationSubject {
  return {
    principalId: name,
    kind: "member",
    scopes: [scope("identity:read")],
  };
}

function allowed(
  who: string,
  method: string,
  path: string,
  options: { body?: unknown; query?: Record<string, string> } = {},
): boolean {
  const granted = (subject: AuthorizationSubject) => {
    const role = GRANTS[subject.principalId];
    return role === undefined ? [] : [...roleScopes(role, "w1")];
  };
  return runAs({ subject: member(who) }, () =>
    createRouteGuard({
      database: db,
      permits: (actor, required) =>
        permits([...actor.scopes, ...granted(actor)], required),
      effectiveScopes: (actor) => [...actor.scopes, ...granted(actor)],
    })(
      {
        ...emptyRequest(method, path),
        query: new URLSearchParams(options.query ?? {}),
        json: <T>() => options.body as T,
      },
      new Router().requiredScope(method, path),
    ),
  ).allowed;
}

describe("创建者 = 触发者", () => {
  it("节点记下的触发者由库继承到之后起的每一个会话行", () => {
    recordNodeCreator(db, { nodeId: "n1", workspaceId: "w1" }, "operator");
    expect(nodeCreator(db, "n1")).toBe("operator");
    const first = spawn("n1");
    const second = spawn("n1");
    expect(sessionCreator(db, first)).toBe("operator");
    expect(sessionCreator(db, second)).toBe("operator");
    // 没记过的节点、不属于节点的终端：保持空串（0028 的判法）。
    expect(sessionCreator(db, spawn("n2"))).toBe("");
    expect(sessionCreator(db, spawn(null))).toBe("");
    expect(nodeCreator(db, "n2")).toBeNull();
  });

  it("「节点是谁的」：最近的会话行优先，没起过时看记下的触发者", () => {
    recordNodeCreator(db, { nodeId: "n1", workspaceId: "w1" }, "operator");
    expect(nodeOwnerPrincipal(db, "n1")).toBe("operator");
    expect(nodeOwnerPrincipal(db, "nobody")).toBe("");
    const row = spawn("n1");
    db.prepare(
      "UPDATE terminal_sessions SET creator_principal_id = 'driver' WHERE id = ?",
    ).run(row);
    expect(nodeOwnerPrincipal(db, "n1")).toBe("driver");
  });

  it("冷启动按自动化的创建者改写，压过节点记下的触发者", () => {
    recordNodeCreator(db, { nodeId: "n1", workspaceId: "w1" }, "operator");
    const row = spawn("n1");
    expect(sessionCreator(db, row)).toBe("operator");
    stampColdStartCreator(db, row);
    expect(sessionCreator(db, row)).toBe(AUTOMATION_CREATOR);
    expect(AUTOMATION_CREATOR).toBe("");
  });

  it("请求的触发者：成员是他自己，owner 与没有请求身份时是空串", () => {
    expect(requestTrigger()).toBe("");
    expect(runAs({ subject: member("operator") }, requestTrigger)).toBe(
      "operator",
    );
    expect(
      runAs(
        { subject: { principalId: "o".repeat(32), kind: "owner", scopes: [] } },
        requestTrigger,
      ),
    ).toBe("");
  });
});

describe("路由门用库里的查询", () => {
  it("审批：按审批行的会话判「自己的」；旧行没有会话时按节点", () => {
    recordNodeCreator(db, { nodeId: "n1", workspaceId: "w1" }, "operator");
    const mine = spawn("n1");
    db.prepare(
      "INSERT INTO agent_approvals (id, node_id, workspace_id, request_json, created_at, session_id) VALUES ('p1', 'n1', 'w1', '{}', 'x', ?)",
    ).run(mine);
    // hook 面写的旧行：没有 session_id。
    db.prepare(
      "INSERT INTO agent_approvals (id, node_id, workspace_id, request_json, created_at) VALUES ('p2', 'n1', 'w1', '{}', 'x')",
    ).run();
    const others = spawn("n9");
    db.prepare(
      "INSERT INTO agent_approvals (id, node_id, workspace_id, request_json, created_at, session_id) VALUES ('p3', 'n9', 'w1', '{}', 'x', ?)",
    ).run(others);

    const answer = (who: string, id: string) =>
      allowed(who, "POST", `/api/approvals/${id}/answer`);
    expect(answer("operator", "p1")).toBe(true);
    expect(answer("operator", "p2")).toBe(true);
    expect(answer("operator-b", "p1")).toBe(false);
    expect(answer("editor", "p1")).toBe(false);
    expect(answer("operator", "p3")).toBe(false);
    expect(answer("driver", "p3")).toBe(true);
  });

  it("页面起触发者记过的节点：创建者仍是触发者，起它的人写不进去", () => {
    recordNodeCreator(db, { nodeId: "n1", workspaceId: "w1" }, "operator");
    const row = spawn("n1");
    // operator-b 的页面替它起了这个终端，路由门的过滤不改写。
    runAs({ subject: member("operator-b") }, () =>
      createRouteGuard({
        database: db,
        permits: (actor, required) =>
          permits([...actor.scopes, ...roleScopes("operator", "w1")], required),
      })(
        {
          ...emptyRequest("POST", "/api/terminals"),
          json: <T>() => ({ workspaceId: "w1", nodeId: "n1" }) as T,
        },
        new Router().requiredScope("POST", "/api/terminals"),
      ),
    ).filter?.({ id: row, ownerNodeId: "n1" });
    expect(sessionCreator(db, row)).toBe("operator");
    expect(allowed("operator", "POST", `/api/terminals/${row}/paste`)).toBe(
      true,
    );
    expect(allowed("operator-b", "POST", `/api/terminals/${row}/paste`)).toBe(
      false,
    );
    expect(allowed("operator", "POST", "/api/acp/nodes/n1/driver")).toBe(true);
    expect(allowed("operator-b", "POST", "/api/acp/nodes/n1/driver")).toBe(
      false,
    );
  });

  it("工作流按画板、草案与运行行查画布", () => {
    db.prepare(
      "INSERT INTO workflow_drafts (id, workspace_id, board_id, draft_json, created_at, updated_at) VALUES ('d1', 'w1', 'b1', '{}', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO workflow_runs (id, template_id, template_version, template_json, workspace_id, board_id, status, started_at) VALUES ('r1', 'x1', 1, '{}', 'w1', 'b1', 'waiting', 1)",
    ).run();
    expect(
      allowed("editor", "GET", "/api/workflows/runs", {
        query: { boardId: "b1" },
      }),
    ).toBe(true);
    expect(allowed("editor", "GET", "/api/workflows/runs")).toBe(false);
    expect(allowed("editor", "GET", "/api/workflows/drafts/d1")).toBe(true);
    expect(allowed("editor", "POST", "/api/workflows/drafts/d1/confirm")).toBe(
      false,
    );
    expect(
      allowed("operator", "POST", "/api/workflows/drafts/d1/confirm"),
    ).toBe(true);
    expect(allowed("editor", "POST", "/api/workflows/runs/r1/gates/s1")).toBe(
      false,
    );
    expect(allowed("operator", "POST", "/api/workflows/runs/r1/gates/s1")).toBe(
      true,
    );
    expect(
      allowed("operator", "POST", "/api/workflows/runs", {
        body: { templateId: "x1", boardId: "b1" },
      }),
    ).toBe(true);
    expect(
      allowed("operator", "POST", "/api/workflows/runs", {
        body: { templateId: "x1", boardId: "elsewhere" },
      }),
    ).toBe(false);
  });
});
