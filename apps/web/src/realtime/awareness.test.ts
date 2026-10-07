import { describe, expect, it } from "vitest";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import * as Y from "yjs";

import {
  CURSOR_THROTTLE_MS,
  VIEWPORT_THROTTLE_MS,
  colorClash,
  peersOf,
  pickColor,
  startLocalPresence,
  type Peer,
} from "./awareness";

function peer(clientId: number, color: number): Peer {
  return {
    clientId,
    state: { principalId: "", deviceId: `d${clientId}`, name: "n", color },
  };
}

/** 把 `from` 的本地状态灌进 `into`，像 core 转发过来一样。 */
function relay(from: Awareness, into: Awareness): void {
  applyAwarenessUpdate(
    into,
    encodeAwarenessUpdate(from, [from.clientID]),
    "remote",
  );
}

describe("awareness（契约 §16.4）", () => {
  it("别人的状态逐条校验，认不出的不进在线表", () => {
    const me = new Awareness(new Y.Doc());
    const good = new Awareness(new Y.Doc());
    const bad = new Awareness(new Y.Doc());
    good.setLocalState({
      principalId: "p",
      deviceId: "g",
      name: "G",
      color: 3,
    });
    bad.setLocalState({ name: "no device", color: 99 });
    relay(good, me);
    relay(bad, me);
    const peers = peersOf(me, me.clientID);
    expect(peers.map((entry) => entry.clientId)).toEqual([good.clientID]);
    expect(peers[0]!.state.color).toBe(3);
  });

  it("颜色取在场者没用过的最小一个，从 2 起", () => {
    expect(pickColor([], 10)).toBe(2);
    expect(pickColor([peer(1, 2), peer(2, 4)], 10)).toBe(3);
    const full = [2, 3, 4, 5, 6, 7, 8].map((color, i) => peer(i, color));
    expect(pickColor(full, 10)).toBeGreaterThanOrEqual(2);
    expect(pickColor(full, 10)).toBeLessThanOrEqual(8);
  });

  it("同时加入撞了色：clientID 大的那个换", () => {
    expect(colorClash([peer(5, 2)], 9, 2)).toBe(true);
    expect(colorClash([peer(12, 2)], 9, 2)).toBe(false);
  });

  it("自己的那份：身份、颜色、选区、焦点；撞色自己换", () => {
    const remote = new Awareness(new Y.Doc());
    remote.setLocalState({
      principalId: "",
      deviceId: "r",
      name: "R",
      color: 2,
    });
    const me = new Awareness(new Y.Doc());
    relay(remote, me);
    const presence = startLocalPresence(me, { deviceId: "me", name: "Mac" });
    expect(me.getLocalState()).toMatchObject({
      deviceId: "me",
      name: "Mac",
      color: 3,
    });
    presence.setSelection(["a", "", "wb:b"]);
    presence.setFocus("a");
    expect(me.getLocalState()).toMatchObject({
      selection: ["a", "wb:b"],
      focusNodeId: "a",
    });
    presence.setSelection([]);
    presence.setFocus(null);
    expect(me.getLocalState()).not.toHaveProperty("selection");
    expect(me.getLocalState()).not.toHaveProperty("focusNodeId");
    presence.destroy();
  });

  it("光标节流：间隔内只写最后一个，离开画布立刻写", () => {
    const me = new Awareness(new Y.Doc());
    let clock = 0;
    const timers: (() => void)[] = [];
    const presence = startLocalPresence(me, {
      deviceId: "me",
      name: "Mac",
      now: () => clock,
      setTimer: (run) => {
        timers.push(run);
        return timers.length;
      },
      clearTimer: () => {
        timers.length = 0;
      },
    });
    presence.setCursor({ x: 1, y: 1 });
    expect(me.getLocalState()).toMatchObject({ cursor: { x: 1, y: 1 } });

    clock += 10;
    presence.setCursor({ x: 2, y: 2 });
    presence.setCursor({ x: 3, y: 3 });
    expect(me.getLocalState()).toMatchObject({ cursor: { x: 1, y: 1 } });
    expect(timers).toHaveLength(1);
    clock += CURSOR_THROTTLE_MS;
    timers.shift()!();
    expect(me.getLocalState()).toMatchObject({ cursor: { x: 3, y: 3 } });

    presence.setCursor(null);
    expect(me.getLocalState()).not.toHaveProperty("cursor");
    presence.destroy();
  });

  it("视口节流：间隔内只写最后一个，缩放夹进范围，null 立刻摘掉", () => {
    const me = new Awareness(new Y.Doc());
    let clock = 0;
    const timers: (() => void)[] = [];
    const presence = startLocalPresence(me, {
      deviceId: "me",
      name: "Mac",
      now: () => clock,
      setTimer: (run) => {
        timers.push(run);
        return timers.length;
      },
      clearTimer: () => {
        timers.length = 0;
      },
    });
    presence.setViewport({ x: 10, y: 20, zoom: 1 });
    expect(me.getLocalState()).toMatchObject({
      viewport: { x: 10, y: 20, zoom: 1 },
    });
    clock += 10;
    presence.setViewport({ x: 11, y: 21, zoom: 1 });
    presence.setViewport({ x: 12, y: 22, zoom: 1000 });
    expect(me.getLocalState()).toMatchObject({ viewport: { x: 10 } });
    clock += VIEWPORT_THROTTLE_MS;
    timers.shift()!();
    expect(me.getLocalState()).toMatchObject({
      viewport: { x: 12, y: 22, zoom: 100 },
    });
    // 光标与视口各节流各的。
    presence.setCursor({ x: 1, y: 1 });
    expect(me.getLocalState()).toMatchObject({ cursor: { x: 1, y: 1 } });
    presence.setViewport(null);
    expect(me.getLocalState()).not.toHaveProperty("viewport");
    presence.destroy();
  });

  it("视口经 awareness 送到对方，过校验进在线表", () => {
    const remote = new Awareness(new Y.Doc());
    const presence = startLocalPresence(remote, { deviceId: "r", name: "R" });
    presence.setViewport({ x: -40, y: 80, zoom: 0.5 });
    const me = new Awareness(new Y.Doc());
    relay(remote, me);
    expect(peersOf(me, me.clientID)[0]!.state.viewport).toEqual({
      x: -40,
      y: 80,
      zoom: 0.5,
    });
    presence.destroy();
  });
});
