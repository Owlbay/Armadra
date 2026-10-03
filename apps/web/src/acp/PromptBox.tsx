import * as React from "react";
import { ArrowUp, Square } from "lucide-react";
import type { AcpModeState } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
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
 */
export function PromptBox({
  sessionId,
  disabled,
  streaming,
  modes,
  onSubmit,
  onCancel,
  onMode,
  inputRef,
}: {
  sessionId: string | null;
  disabled: boolean;
  streaming: boolean;
  modes: AcpModeState | null;
  /** 返回 `false` 时保留输入框里的字。 */
  onSubmit: (text: string) => Promise<boolean>;
  onCancel: () => void;
  onMode: (modeId: string) => void;
  inputRef?: React.Ref<HTMLTextAreaElement>;
}) {
  const t = useT();
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

  const selectable = modes && modes.availableModes.length > 1;

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
      {selectable && (
        <Select
          value={modes.currentModeId}
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
            {modes.availableModes.map((mode) => (
              <SelectItem key={mode.id} value={mode.id}>
                {mode.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
