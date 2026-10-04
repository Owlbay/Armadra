import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryService } from "../git/repository/service";
import { temporary, type Temporary } from "../files/workspace.fixture";
import { type RemoteCaller, setRemoteCaller } from "../remote/execute";
import { OPERATIONS } from "../remote/operations";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { createRemoteWorkspace } from "../workspaces/table";
import {
  EXPORTS_DIRECTORY,
  TEXT_EXPORTS_DIRECTORY,
  exportBase,
} from "./exports";
import { install } from "./routes";

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** A whiteboard export lands at `.armadra/exports/<uuid>.png`, node or not. */
describe("the PNG export route", () => {
  let core: Fixture;
  let workspaceId: string;

  beforeEach(async () => {
    core = fixture([installWorkspaces, install]);
    const created = await core.call("POST", "/api/workspaces", {
      name: "Canvas",
      rootPath: core.directory,
    });
    workspaceId = (created.body as { id: string }).id;
  });
  afterEach(() => {
    core.close();
  });

  it("writes the uploaded bytes and answers both paths", async () => {
    const id = "0f1a2b3c-4d5e-4f60-8a71-92b3c4d5e6f7";
    const answer = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/exports/${id}/png`,
      { dataUrl: `data:image/png;base64,${TINY_PNG}` },
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      path: join(core.directory, EXPORTS_DIRECTORY, `${id}.png`),
      relativePath: `${EXPORTS_DIRECTORY}/${id}.png`,
      bytes: Buffer.from(TINY_PNG, "base64").length,
    });
    expect(
      readFileSync(join(core.directory, EXPORTS_DIRECTORY, `${id}.png`)),
    ).toEqual(Buffer.from(TINY_PNG, "base64"));
    expect(
      readFileSync(join(core.directory, ".armadra/.gitignore"), "utf8"),
    ).toBe("*\n");
  });

  it("refuses an id that is not a uuid and a body that is not a PNG data URL", async () => {
    const bad = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/exports/..%2Fescape/png`,
      { dataUrl: `data:image/png;base64,${TINY_PNG}` },
    );
    expect(bad.status).toBe(400);
    const notPng = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/exports/0f1a2b3c-4d5e-4f60-8a71-92b3c4d5e6f7/png`,
      { dataUrl: "data:image/jpeg;base64,AAAA" },
    );
    expect(notPng.status).toBe(400);
  });
});

/** 输出到画板的代码块落在 `.armadra/exports/acp/<nodeId>/<name>`（契约 §14.5）。 */
describe("the text export route", () => {
  let core: Fixture;
  let workspaceId: string;
  const id = "0f1a2b3c-4d5e-4f60-8a71-92b3c4d5e6f7";

  beforeEach(async () => {
    core = fixture([installWorkspaces, install]);
    const created = await core.call("POST", "/api/workspaces", {
      name: "Canvas",
      rootPath: core.directory,
    });
    workspaceId = (created.body as { id: string }).id;
  });
  afterEach(() => {
    core.close();
  });

  it("creates the directories and writes the text", async () => {
    const answer = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/exports/${id}/text`,
      { name: "m1-1.ts", content: "export const a = 1;\n" },
    );
    expect(answer.status).toBe(200);
    const relativePath = `${TEXT_EXPORTS_DIRECTORY}/${id}/m1-1.ts`;
    expect(answer.body).toEqual({
      path: join(core.directory, relativePath),
      relativePath,
      bytes: 20,
    });
    expect(readFileSync(join(core.directory, relativePath), "utf8")).toBe(
      "export const a = 1;\n",
    );
    expect(
      readFileSync(join(core.directory, ".armadra/.gitignore"), "utf8"),
    ).toBe("*\n");
  });

  it("refuses a name that is a path and a missing body", async () => {
    for (const name of ["../x.ts", "a/b.ts", ".hidden", ""]) {
      const answer = await core.call(
        "POST",
        `/api/workspaces/${workspaceId}/exports/${id}/text`,
        { name, content: "x" },
      );
      expect(answer.status, name).toBe(400);
    }
    const missing = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/exports/${id}/text`,
      { name: "a.ts" },
    );
    expect(missing.status).toBe(400);
    const badId = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/exports/not-a-uuid/text`,
      { name: "a.ts", content: "x" },
    );
    expect(badId.status).toBe(400);
  });
});

/** 给一个节点记一行终端会话：core 从这里读 Agent 的工作目录。 */
function recordSession(
  core: Fixture,
  workspaceId: string,
  nodeId: string,
  cwd: string,
  createdAt = "2026-10-04T00:00:00.000Z",
): void {
  core.database
    .prepare(
      "INSERT INTO terminal_sessions (id, workspace_id, owner_node_id, cwd, shell, status, created_at) " +
        "VALUES (?, ?, ?, ?, '/bin/sh', 'exited', ?)",
    )
    .run(`s-${createdAt}`, workspaceId, nodeId, cwd, createdAt);
}

/** 代码块落在来源 Agent 的工作目录里（在工作区内时）。 */
describe("the text export goes to the agent's working directory", () => {
  let core: Fixture;
  let workspaceId: string;
  const id = "0f1a2b3c-4d5e-4f60-8a71-92b3c4d5e6f7";

  beforeEach(async () => {
    core = fixture([installWorkspaces, install]);
    const created = await core.call("POST", "/api/workspaces", {
      name: "Canvas",
      rootPath: core.directory,
    });
    workspaceId = (created.body as { id: string }).id;
  });
  afterEach(() => {
    core.close();
  });

  it("writes under the cwd's own .armadra and answers a workspace-relative path", async () => {
    mkdirSync(join(core.directory, "packages/api"), { recursive: true });
    recordSession(core, workspaceId, id, join(core.directory, "packages/api"));
    const answer = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/exports/${id}/text`,
      { name: "m1-1.ts", content: "export const a = 1;\n" },
    );
    expect(answer.status).toBe(200);
    const relativePath = `packages/api/${TEXT_EXPORTS_DIRECTORY}/${id}/m1-1.ts`;
    expect(answer.body).toEqual({
      path: join(core.directory, relativePath),
      relativePath,
      bytes: 20,
    });
    expect(
      readFileSync(
        join(core.directory, "packages/api/.armadra/.gitignore"),
        "utf8",
      ),
    ).toBe("*\n");
    expect(existsSync(join(core.directory, TEXT_EXPORTS_DIRECTORY))).toBe(
      false,
    );
  });

  it("uses the newest session of that node", async () => {
    mkdirSync(join(core.directory, "old"));
    mkdirSync(join(core.directory, "new"));
    recordSession(
      core,
      workspaceId,
      id,
      join(core.directory, "old"),
      "2026-10-01T00:00:00.000Z",
    );
    recordSession(
      core,
      workspaceId,
      id,
      join(core.directory, "new"),
      "2026-10-03T00:00:00.000Z",
    );
    const answer = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/exports/${id}/text`,
      { name: "a.ts", content: "x" },
    );
    expect((answer.body as { relativePath: string }).relativePath).toBe(
      `new/${TEXT_EXPORTS_DIRECTORY}/${id}/a.ts`,
    );
  });

  it("falls back to the workspace root for a cwd outside it, a gone one, or none", async () => {
    const outside = temporary("armadra-outside-");
    try {
      for (const cwd of [outside.path, join(core.directory, "gone")]) {
        recordSession(core, workspaceId, id, cwd, new Date().toISOString());
        const answer = await core.call(
          "POST",
          `/api/workspaces/${workspaceId}/exports/${id}/text`,
          { name: "a.ts", content: "x" },
        );
        expect(
          (answer.body as { relativePath: string }).relativePath,
          cwd,
        ).toBe(`${TEXT_EXPORTS_DIRECTORY}/${id}/a.ts`);
      }
      expect(existsSync(join(outside.path, ".armadra"))).toBe(false);
    } finally {
      outside.remove();
    }
  });
});

describe("exportBase", () => {
  let root: Temporary;
  beforeEach(() => {
    root = temporary("armadra-export-base-");
    mkdirSync(join(root.path, "a/b"), { recursive: true });
    mkdirSync(join(root.path, ".armadra/x"), { recursive: true });
  });
  afterEach(() => root.remove());

  it("answers the cwd relative to the root, in / form", () => {
    expect(exportBase(root.path, join(root.path, "a/b"))).toBe("a/b");
    expect(exportBase(root.path, root.path)).toBe("");
    expect(exportBase(root.path, undefined)).toBe("");
    expect(exportBase(root.path, "a/b")).toBe("");
  });

  it("refuses managed folders and a link that leads out", () => {
    expect(exportBase(root.path, join(root.path, ".armadra/x"))).toBe("");
    const outside = temporary("armadra-export-out-");
    try {
      symlinkSync(outside.path, join(root.path, "link"), "dir");
      expect(exportBase(root.path, join(root.path, "link"))).toBe("");
    } finally {
      outside.remove();
    }
  });
});

/** 远端工作空间：经 Worker 的 `assets.exportText` 落在执行主机上，不再 501。 */
describe("the text export on a remote workspace", () => {
  let core: Fixture;
  let far: Temporary;
  let state: Temporary;
  let workspaceId: string;
  let previous: RemoteCaller | undefined;
  const calls: string[] = [];
  const id = "0f1a2b3c-4d5e-4f60-8a71-92b3c4d5e6f7";

  beforeEach(() => {
    core = fixture([installWorkspaces, install]);
    far = temporary("armadra-far-");
    state = temporary("armadra-far-state-");
    calls.length = 0;
    // 「那台机器」就是本进程里同一张操作表，根与状态目录都是另一处。
    previous = setRemoteCaller(async (_host, operation, payload) => {
      calls.push(operation);
      return await OPERATIONS[operation]!.run(
        {
          service: new RepositoryService(),
          freshDiscovery: true,
          stateDir: state.path,
        },
        payload.root,
        payload.args ?? {},
      );
    });
    workspaceId = createRemoteWorkspace(core.database, {
      name: "far",
      executionHostId: "far",
      rootPath: far.path,
    }).id;
  });
  afterEach(() => {
    setRemoteCaller(previous);
    core.close();
    far.remove();
    state.remove();
  });

  it("writes on the execution host, in the agent's cwd there", async () => {
    mkdirSync(join(far.path, "svc"));
    recordSession(core, workspaceId, id, join(far.path, "svc"));
    const answer = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/exports/${id}/text`,
      { name: "m1-1.ts", content: "export const a = 1;\n" },
    );
    expect(answer.status).toBe(200);
    const relativePath = `svc/${TEXT_EXPORTS_DIRECTORY}/${id}/m1-1.ts`;
    expect(answer.body).toEqual({
      path: join(far.path, relativePath),
      relativePath,
      bytes: 20,
    });
    expect(calls).toEqual(["assets.exportText"]);
    expect(readFileSync(join(far.path, relativePath), "utf8")).toBe(
      "export const a = 1;\n",
    );
    expect(existsSync(join(core.directory, TEXT_EXPORTS_DIRECTORY))).toBe(
      false,
    );
  });

  it("refuses a bad name there as well", async () => {
    const answer = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/exports/${id}/text`,
      { name: "../x.ts", content: "x" },
    );
    expect(answer.status).toBe(400);
  });
});
