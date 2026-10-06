import { describe, expect, it, vi } from "vitest";

/**
 * 在线订阅 `boards.presence` 的页面一侧（契约 §36.4）：每一项过页面的 schema 再
 * 交出去，取消不算结束，被拒与自然结束才通知调用方。
 */

const presence = vi.fn();
vi.mock("./client", () => ({
  controlClient: () => ({ boards: { presence } }),
}));
vi.mock("./events", () => ({ connectionOf: () => ({}) }));

const { watchBoardPresence } = await import("./board-presence");

const base = { workspaceId: "w", boardId: "b", clientId: "tab-aaaaaaaaaaaa" };
const item = {
  boardId: "b",
  clients: [{ clientId: "tab-aaaaaaaaaaaa", deviceName: "", lastSeenAt: "t" }],
  lease: null,
  writable: true,
};

function stream(...items: unknown[]) {
  return (async function* () {
    for (const one of items) yield one;
  })();
}

describe("watchBoardPresence", () => {
  it("订上时带着客户端与设备名，每一项补上页面的缺省后交出去", async () => {
    presence.mockResolvedValueOnce(stream(item));
    const seen: unknown[] = [];
    const ended = new Promise<unknown>((resolve) =>
      watchBoardPresence({
        ...base,
        deviceName: "Mac",
        onPresence: (value) => seen.push(value),
        onEnd: resolve,
      }),
    );
    expect(await ended).toBeUndefined();
    expect(presence.mock.calls[0]?.[0]).toEqual({ ...base, deviceName: "Mac" });
    // `deviceKey` 在线上是必有的字段，旧 core 不发时页面补成空串。
    expect(seen).toEqual([
      {
        ...item,
        clients: [{ ...item.clients[0], deviceKey: "" }],
      },
    ]);
  });

  it("被拒时把错误交给调用方；取消不算结束", async () => {
    const refusal = Object.assign(new Error("no"), { code: "forbidden" });
    presence.mockRejectedValueOnce(refusal);
    const ended = new Promise<unknown>((resolve) =>
      watchBoardPresence({
        ...base,
        deviceName: "",
        onPresence: () => {},
        onEnd: resolve,
      }),
    );
    expect(await ended).toBe(refusal);

    const onEnd = vi.fn();
    let signal: AbortSignal | undefined;
    presence.mockImplementationOnce(
      async (_input: unknown, options: { signal: AbortSignal }) => {
        signal = options.signal;
        return (async function* () {
          await new Promise((resolve) =>
            options.signal.addEventListener("abort", resolve),
          );
        })();
      },
    );
    const stop = watchBoardPresence({
      ...base,
      deviceName: "",
      onPresence: () => {},
      onEnd,
    });
    await vi.waitFor(() => expect(signal).toBeDefined());
    stop();
    expect(signal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onEnd).not.toHaveBeenCalled();
  });
});
