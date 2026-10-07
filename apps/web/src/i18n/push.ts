import type { MessageModule } from "./index";

/** 推送：开启之后「收哪些通知」那组开关（契约 §27.1）。 */
export const push: MessageModule = {
  "zh-CN": {
    "push.kinds.title": "接收哪些通知",
    "push.kinds.done": "完成",
    "push.kinds.failed": "没能保存通知设置",
    "push.kind.approval": "等待审批",
    "push.kind.agentDone": "Agent 完成",
    "push.kind.agentError": "Agent 出错",
    "push.kind.deliveryFailed": "投递失败",
    "push.kind.schedule": "定时任务",
    "push.kind.resources": "资源超过阈值",
    "push.kind.comment": "评论里提到我",
    "push.kind.workflowGate": "工作流等待确认",
  },
  en: {
    "push.kinds.title": "Notify me about",
    "push.kinds.done": "Done",
    "push.kinds.failed": "Couldn't save notification settings",
    "push.kind.approval": "Approval requests",
    "push.kind.agentDone": "Agent finished",
    "push.kind.agentError": "Agent errors",
    "push.kind.deliveryFailed": "Failed deliveries",
    "push.kind.schedule": "Scheduled tasks",
    "push.kind.resources": "Resource thresholds",
    "push.kind.comment": "Mentions in comments",
    "push.kind.workflowGate": "Workflow gates",
  },
};
