import * as React from "react";
import { ArrowUp, Ellipsis, Square } from "lucide-react";
import type { AcpModeState, AcpModelState } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { useCompactLayout } from "@/platform/layout";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Textarea } from "@/ui/textarea";
import { acpApi } from "./api";

/**
 * 会话视图底部的输入（ACP 设计 §6、§5.6）。
 *
 * Enter 发送、Shift+Enter 换行、输入法组字时的 Enter 不算；回合进行中发送钮
 * 换成停止（`session/cancel`），Esc 同样停止。
 *
 * 人在这里打字就不是 Agent 的回合：聚焦拿人类租约（`takeover`），失焦或
 * 提交交还（`release`），Agent 的 `send` 在这段时间排队——与终端模式同一条
 * 规矩，租约本身归 core。
 *
 * 模式与模型（契约 §26.2）各一个 Select，只在有得选时出现；窄屏（≤ 767，
 * 含手机焦点页）两个收进一个「⋯」菜单，不挤占输入框。
 */
export function PromptBox({
  sessionId,
  disabled,
  streaming,
  modes,
  models = null,
  onSubmit,
  onCancel,
  onMode,
  onModel,
  inputRef,
  compact: forceCompact,
}: {
  sessionId: string | null;
  disabled: boolean;
  streaming: boolean;
  modes: AcpModeState | null;
  models?: AcpModelState | null;
  /** 返回 `false` 时保留输入框里的字。 */
  onSubmit: (text: string) => Promise<boolean>;
  onCancel: () => void;
  onMode: (modeId: string) => void;
  onModel?: (modelId: string) => void;
  inputRef?: React.Ref<HTMLTextAreaElement>;
  /** 展示页用：不看视口，直接画窄屏那一版。 */
  compact?: boolean;
}) {
  const t = useT();
  const narrow = useCompactLayout();
  const compact = forceCompact ?? narrow;
  const [text, setText] = React.useState("");
  const holding = React.useRef<string | null>(null);

  const take = React.useCallback(() => {
    if (!sessionId || holding.current === sessionId) return;
    holding.current = sessionId;
    void acpApi.drive(sessionId, "takeover").catch(() => undefined);
  }, [sessionId]);

  const release = React.useCallback(() => {
    const held = holding.current;
    if (!held) return;
    holding.current = null;
    void acpApi.drive(held, "release").catch(() => undefined);
  }, []);

  // 卸载或换了会话时把租约交回去，不留一个没人坐的驾驶位。
  React.useEffect(() => release, [sessionId, release]);

  const submit = async () => {
    const value = text.trim();
    if (!value || disabled || streaming) return;
    setText("");
    release();
    const sent = await onSubmit(value);
    if (!sent) setText(value);
  };

  const modeChoice = modes && modes.availableModes.length > 1 ? modes : null;
  // 只有一个模型也画：让人看得见在用哪个（契约 §26.2 只在目录非空时给）。
  const modelChoice =
    models && onModel && models.availableModels.length > 0 ? models : null;

  return (
    <div className="flex items-end gap-1.5 border-t border-[var(--border)] p-1.5">
      <Textarea
        ref={inputRef}
        aria-label={t("acp.prompt.label")}
        rows={1}
        value={text}
        disabled={disabled}
        className="max-h-[calc(6lh+1rem)] min-h-8 flex-1 resize-none overflow-y-auto py-1.5 text-[13px] md:text-[13px]"
        onChange={(event) => setText(event.target.value)}
        onFocus={take}
        onBlur={release}
        onKeyDown={(event) => {
          if (event.key === "Escape" && streaming) {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key !== "Enter" || event.shiftKey) return;
          if (event.nativeEvent.isComposing) return;
          event.preventDefault();
          void submit();
        }}
      />
      {compact ? (
        (modeChoice || modelChoice) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("acp.prompt.more")}
                disabled={disabled}
              >
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="max-h-[60dvh] min-w-44 overflow-y-auto"
            >
              {modeChoice && (
                <>
                  <DropdownMenuLabel>{t("acp.prompt.mode")}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={modeChoice.currentModeId}
                    onValueChange={onMode}
                  >
                    {modeChoice.availableModes.map((mode) => (
                      <DropdownMenuRadioItem key={mode.id} value={mode.id}>
                        {mode.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </>
              )}
              {modeChoice && modelChoice && <DropdownMenuSeparator />}
              {modelChoice && (
                <>
                  <DropdownMenuLabel>{t("acp.prompt.model")}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={modelChoice.currentModelId}
                    onValueChange={(id) => onModel?.(id)}
                  >
                    {modelChoice.availableModels.map((model) => (
                      <DropdownMenuRadioItem
                        key={model.modelId}
                        value={model.modelId}
                      >
                        {model.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )
      ) : (
        <>
          {modelChoice && (
            <Select
              value={modelChoice.currentModelId}
              disabled={disabled}
              onValueChange={(id) => onModel?.(id)}
            >
              <SelectTrigger
                size="sm"
                aria-label={t("acp.prompt.model")}
                className="max-w-36 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modelChoice.availableModels.map((model) => (
                  <SelectItem key={model.modelId} value={model.modelId}>
                    {model.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {modeChoice && (
            <Select
              value={modeChoice.currentModeId}
              disabled={disabled}
              onValueChange={onMode}
            >
              <SelectTrigger
                size="sm"
                aria-label={t("acp.prompt.mode")}
                className="max-w-32 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modeChoice.availableModes.map((mode) => (
                  <SelectItem key={mode.id} value={mode.id}>
                    {mode.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </>
      )}
      {streaming ? (
        <Button
          size="icon-sm"
          variant="outline"
          aria-label={t("acp.prompt.stop")}
          disabled={disabled}
          onClick={onCancel}
        >
          <Square />
        </Button>
      ) : (
        <Button
          size="icon-sm"
          aria-label={t("acp.prompt.send")}
          disabled={disabled || !text.trim()}
          onClick={() => void submit()}
        >
          <ArrowUp />
        </Button>
      )}
    </div>
  );
}
