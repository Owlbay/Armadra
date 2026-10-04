import * as React from "react";
import Markdown from "react-markdown";

import { useT } from "@/app/preferences-store";
import { ElicitationCard } from "@/acp/ElicitationCard";
import { ExportMenu } from "@/acp/ExportMenu";
import { MessageList } from "@/acp/MessageList";
import { PermissionCard } from "@/acp/PermissionCard";
import { PromptBox } from "@/acp/PromptBox";
import { Alert, AlertAction, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import {
  ACP_ELICITATION,
  ACP_ELICITATION_URL,
  ACP_ITEMS,
  ACP_MODELS,
  ACP_MODES,
  ACP_NODE_ID,
  ACP_PERMISSION,
  ACP_SESSION_ID,
  ACP_STREAMING_ITEMS,
} from "../fixtures/acp";

/**
 * `acp` 分区（设计展示页 §2.1，设计系统 §5.1–§5.2）：会话视图的真组件喂
 * 假数据。消息流（用户 / 思考 / 三种状态的工具调用 / 差异 / 助手）、流式
 * 尾部、权限卡与错误行、PromptBox 三态（带模式与模型）、窄屏「⋯」、
 * elicitation 表单与链接两种卡片、输出到画板菜单展开。
 */

const SOURCE = { nodeId: ACP_NODE_ID, sessionId: ACP_SESSION_ID };

function Frame({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col overflow-hidden rounded-[var(--r-card)] border border-border bg-[var(--card)] ${className}`}
    >
      {children}
    </div>
  );
}

const noop = () => undefined;
const sent = async () => true;

export default function AcpSection() {
  const t = useT();
  const exported = ACP_ITEMS.find(
    (item) => item.kind === "message" && item.role === "assistant",
  );
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Frame>
        <div className="flex flex-col gap-2 p-2.5">
          <MessageList items={ACP_ITEMS} streaming={false} source={SOURCE} />
        </div>
      </Frame>

      <div className="flex flex-col gap-4">
        {exported?.kind === "message" && (
          <Frame className="p-2.5 pb-44">
            <ExportMenu
              text={exported.text}
              source={{ ...SOURCE, messageId: exported.id }}
              defaultOpen
            >
              <div className="sticky-markdown pr-8 text-[13px] leading-relaxed">
                <Markdown>{exported.text.split("\n\n")[0] ?? ""}</Markdown>
              </div>
            </ExportMenu>
          </Frame>
        )}
        <Frame>
          <div className="flex flex-col gap-2 p-2.5">
            <MessageList items={ACP_STREAMING_ITEMS} streaming />
          </div>
          <PermissionCard
            permission={ACP_PERMISSION}
            canAnswer
            className="mx-2 mb-1.5"
          />
          <PromptBox
            sessionId={null}
            disabled={false}
            streaming
            modes={ACP_MODES}
            onSubmit={sent}
            onCancel={noop}
            onMode={noop}
          />
        </Frame>

        <Frame>
          <div className="flex flex-col gap-2 p-2.5">
            <Alert variant="destructive">
              <AlertTitle>{t("acp.error.turn")}</AlertTitle>
              <AlertAction>
                <Button size="xs" variant="outline">
                  {t("acp.error.retry")}
                </Button>
              </AlertAction>
            </Alert>
          </div>
          <PromptBox
            sessionId={null}
            disabled={false}
            streaming={false}
            modes={ACP_MODES}
            models={ACP_MODELS}
            onSubmit={sent}
            onCancel={noop}
            onMode={noop}
            onModel={noop}
          />
        </Frame>

        <Frame>
          <div className="flex flex-col gap-2 p-2.5">
            <ElicitationCard
              nodeId={ACP_NODE_ID}
              view={ACP_ELICITATION_URL}
              canAnswer
            />
          </div>
          <ElicitationCard
            nodeId={ACP_NODE_ID}
            view={ACP_ELICITATION}
            canAnswer
            className="mx-2 mb-1.5"
          />
          <PromptBox
            sessionId={null}
            disabled={false}
            streaming={false}
            modes={ACP_MODES}
            models={ACP_MODELS}
            onSubmit={sent}
            onCancel={noop}
            onMode={noop}
            onModel={noop}
            compact
          />
        </Frame>

        <Frame>
          <Alert className="rounded-none border-x-0 border-t-0 py-1.5">
            <AlertTitle className="text-xs">{t("acp.offline")}</AlertTitle>
          </Alert>
          <PromptBox
            sessionId={null}
            disabled
            streaming={false}
            modes={null}
            onSubmit={sent}
            onCancel={noop}
            onMode={noop}
          />
        </Frame>
      </div>
    </div>
  );
}
