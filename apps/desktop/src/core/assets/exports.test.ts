import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { EXPORTS_DIRECTORY, TEXT_EXPORTS_DIRECTORY } from "./exports";
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
