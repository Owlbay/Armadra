import { beforeEach, describe, expect, it } from "vitest";

import {
  COLLAPSED_WORKSPACES_KEY,
  LAST_BOARD_KEY,
  LAST_WORKSPACE_KEY,
  OPEN_WORKSPACES_KEY,
  PINNED_BOARDS_KEY,
  PINNED_WORKSPACES_KEY,
  idsInSource,
  migrateSourceScopedPreferences,
  storedLast,
  storedScopedIds,
  writeScopedIds,
} from "./sources";

beforeEach(() => localStorage.clear());

describe("按源记的偏好", () => {
  it("旧的裸 id 一次性迁到本机源，写回 { sourceId, … }[]", () => {
    localStorage.setItem(OPEN_WORKSPACES_KEY, JSON.stringify(["w1", "w2"]));
    localStorage.setItem(COLLAPSED_WORKSPACES_KEY, JSON.stringify(["w2"]));
    localStorage.setItem(PINNED_WORKSPACES_KEY, JSON.stringify(["w1"]));
    localStorage.setItem(PINNED_BOARDS_KEY, JSON.stringify(["b1"]));
    localStorage.setItem(LAST_WORKSPACE_KEY, "w1");
    localStorage.setItem(LAST_BOARD_KEY, "b1");

    migrateSourceScopedPreferences();

    expect(JSON.parse(localStorage.getItem(OPEN_WORKSPACES_KEY)!)).toEqual([
      { sourceId: "local", workspaceId: "w1" },
      { sourceId: "local", workspaceId: "w2" },
    ]);
    expect(JSON.parse(localStorage.getItem(PINNED_BOARDS_KEY)!)).toEqual([
      { sourceId: "local", boardId: "b1" },
    ]);
    expect(JSON.parse(localStorage.getItem(LAST_WORKSPACE_KEY)!)).toEqual({
      sourceId: "local",
      workspaceId: "w1",
    });
    expect(storedScopedIds(OPEN_WORKSPACES_KEY, "workspaceId")).toEqual([
      "local:w1",
      "local:w2",
    ]);
    expect(storedLast(LAST_BOARD_KEY, "boardId")).toEqual({
      sourceId: "local",
      id: "b1",
    });
  });

  it("迁移幂等：已是新格式的不动，别的源的条目保留", () => {
    writeScopedIds(OPEN_WORKSPACES_KEY, "workspaceId", ["local:w1", "s2:w1"]);
    const before = localStorage.getItem(OPEN_WORKSPACES_KEY);
    migrateSourceScopedPreferences();
    migrateSourceScopedPreferences();
    expect(localStorage.getItem(OPEN_WORKSPACES_KEY)).toBe(before);
    const keys = storedScopedIds(OPEN_WORKSPACES_KEY, "workspaceId");
    expect(keys).toEqual(["local:w1", "s2:w1"]);
    expect(idsInSource(keys, "s2")).toEqual(["w1"]);
    expect(idsInSource(keys, "local")).toEqual(["w1"]);
  });

  it("没有旧值、值损坏时不写、不抛", () => {
    localStorage.setItem(OPEN_WORKSPACES_KEY, "{not json");
    migrateSourceScopedPreferences();
    expect(localStorage.getItem(OPEN_WORKSPACES_KEY)).toBe("{not json");
    expect(localStorage.getItem(LAST_WORKSPACE_KEY)).toBeNull();
    expect(storedScopedIds(OPEN_WORKSPACES_KEY, "workspaceId")).toEqual([]);
  });
});
