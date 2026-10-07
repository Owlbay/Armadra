import * as React from "react";
import { Play } from "lucide-react";
import { toast } from "sonner";
import { runtimeApi } from "@/api/client";
import { useAccess } from "@/app/use-access";
import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { IconButton } from "@/ui/icon-button";
import { Button } from "@/ui/button";
import { Textarea } from "@/ui/textarea";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
} from "@/panels/ResponsiveDialog";

export function ManualRunButton({ nodeId }: { nodeId: string }) {
  const t = useT(),
    access = useAccess();
  const [open, setOpen] = React.useState(false),
    [prompt, setPrompt] = React.useState(""),
    [saving, setSaving] = React.useState(false);
  const frozen = React.useRef<{
    prompt: string;
    expectedUpdatedAt: string;
    key: string;
  } | null>(null);
  if (access.member) return null;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || !prompt.trim()) return;
    const store = useCanvasStore.getState(),
      board = store.document?.board,
      workspace = store.workspace;
    if (!board || !workspace) return;
    frozen.current ??= {
      prompt,
      expectedUpdatedAt: board.updatedAt,
      key: crypto.randomUUID(),
    };
    setSaving(true);
    try {
      await runtimeApi.startManualRun(
        workspace.id,
        board.id,
        nodeId,
        frozen.current,
      );
      setOpen(false);
      setPrompt("");
      frozen.current = null;
      toast.success(t("run.manual.queued"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <span className="text-xs text-muted-foreground">
        {t("run.manual.waiting")}
      </span>
      <IconButton label={t("run.manual.open")} onClick={() => setOpen(true)}>
        <Play className="size-3" />
      </IconButton>
      <ResponsiveDialog open={open} onOpenChange={setOpen}>
        <ResponsiveDialogContent
          onPointerDown={(event) => event.stopPropagation()}
        >
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>
              {t("run.manual.open")}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {t("run.manual.description")}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <form onSubmit={(event) => void submit(event)} className="space-y-4">
            <label htmlFor={`run-prompt-${nodeId}`} className="text-sm">
              {t("run.manual.prompt")}
            </label>
            <Textarea
              id={`run-prompt-${nodeId}`}
              value={prompt}
              disabled={saving}
              maxLength={2000}
              onChange={(event) => {
                setPrompt(event.target.value);
                frozen.current = null;
              }}
            />
            <ResponsiveDialogFooter>
              <Button type="submit" disabled={saving || !prompt.trim()}>
                {saving ? t("run.manual.starting") : t("run.manual.start")}
              </Button>
            </ResponsiveDialogFooter>
          </form>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  );
}
