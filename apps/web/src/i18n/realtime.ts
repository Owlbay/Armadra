import type { MessageModule } from "./index";

/** 实时协同：在线成员、光标、离线编辑（补全计划 G2-5，设计系统 §5.6）。 */
export const realtime: MessageModule = {
  "zh-CN": {
    "realtime.presence.label": "在线成员",
    "realtime.presence.self": "你",
    "realtime.presence.more": "另外 {count} 人",
    "realtime.follow": "跟随",
    "realtime.unfollow": "取消跟随",
    "realtime.offline": "离线编辑",
    "realtime.disconnected": "已断开",
    "realtime.readOnly": "只读",
    "realtime.cursors": "成员光标",
    "realtime.setting": "实时协同",
  },
  en: {
    "realtime.presence.label": "People here",
    "realtime.presence.self": "You",
    "realtime.presence.more": "{count} more",
    "realtime.follow": "Follow",
    "realtime.unfollow": "Stop following",
    "realtime.offline": "Editing offline",
    "realtime.disconnected": "Disconnected",
    "realtime.readOnly": "Read-only",
    "realtime.cursors": "Cursors",
    "realtime.setting": "Real-time collaboration",
  },
};
