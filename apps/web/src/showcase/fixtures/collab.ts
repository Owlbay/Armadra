import type { Peer } from "@/realtime/awareness";

/**
 * `collab` 分区的假在线成员（设计展示页 §2.1，设计系统 §5.6）。纯对象；
 * 名字是数据不是界面文案，允许中文。
 */

const NAMES = ["林舟", "Ada", "周远", "Mika", "陈一", "Noor"];

function peer(index: number, cursor?: { x: number; y: number }): Peer {
  return {
    clientId: 100 + index,
    state: {
      principalId: `p${index}`,
      deviceId: `d${index}`,
      name: NAMES[index] ?? `#${index}`,
      color: 2 + index,
      ...(cursor ? { cursor } : {}),
    },
  };
}

/** 头像堆叠的三档：只有一个别人、三个、六个（溢出成 +N）。 */
export const PEER_SETS: readonly (readonly Peer[])[] = [
  [peer(0)],
  [peer(0), peer(1), peer(2)],
  [peer(0), peer(1), peer(2), peer(3), peer(4), peer(5)],
];

/** 光标样本：画在 360×180 的小画布上。 */
export const CURSOR_PEERS: readonly Peer[] = [
  peer(0, { x: 60, y: 40 }),
  peer(1, { x: 210, y: 110 }),
];
