import type { MessageModule } from "./index";

/**
 * Claude Code mod 的斜杠命令（[Claude Code mods](../../../../docs/design/claude-mods.md)
 * §5.1）：`/help` 与补全里每条命令的一句说明，以及命令答不了时的那一行。
 *
 * 页面不显示这些串：它们在这里是为了文案有归属、中英同步受 `i18n.test.ts`
 * 守卫。core 生成 mod 源码时用的是 `core/hook/install/claude-mod/commands.ts`
 * 里的镜像，那边的测试断言两份逐键相等。
 */
export const modCommands: MessageModule = {
  "zh-CN": {
    "mod.command.post": "给连线的节点留一份交接",
    "mod.command.inbox": "查看待收的画布消息",
    "mod.command.ack": "确认收到一条消息",
    "mod.command.send": "把消息送进连线的节点",
    "mod.command.team": "在画布上组一队节点",
    "mod.command.open": "在画布上新建一个节点",
    "mod.command.list": "列出与本节点连线的节点",
    "mod.command.outside": "不在画布节点里",
    "mod.command.unclosed": "引号没有闭合",
    "mod.command.failed": "画布命令没有运行",
  },
  en: {
    "mod.command.post": "Leave a handoff for a linked node",
    "mod.command.inbox": "Read your pending canvas messages",
    "mod.command.ack": "Acknowledge a received message",
    "mod.command.send": "Send a message into a linked node",
    "mod.command.team": "Open a team of nodes on the canvas",
    "mod.command.open": "Open a new node on the canvas",
    "mod.command.list": "List the nodes linked to this one",
    "mod.command.outside": "Not in a canvas node",
    "mod.command.unclosed": "Unclosed quote",
    "mod.command.failed": "The canvas command did not run",
  },
};
