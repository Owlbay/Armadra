/**
 * 任务模板（ACP 设计 §8 第 4 条）：内置五条，模板只是 prompt 文本 + 建议的
 * 权限模式。文案（标签与 prompt 正文）都在 `i18n/acp.ts`，随界面语言走。
 * 用户自定义模板是第二期（存 `settings.json`）。
 */
import type { PermissionMode } from "@armadra/shared";

import type { Translate } from "@/app/preferences-store";

export interface TaskTemplate {
  id: "explain" | "fixBug" | "tests" | "review" | "plan";
  /** 建议的权限模式；Agent 不支持时退回 `default`。 */
  permissionMode: PermissionMode;
}

export const TASK_TEMPLATES: readonly TaskTemplate[] = [
  { id: "explain", permissionMode: "plan" },
  { id: "fixBug", permissionMode: "auto-edit" },
  { id: "tests", permissionMode: "auto-edit" },
  { id: "review", permissionMode: "plan" },
  { id: "plan", permissionMode: "plan" },
];

export function templateLabel(template: TaskTemplate, t: Translate): string {
  return t(`wizard.template.${template.id}`);
}

export function templatePrompt(template: TaskTemplate, t: Translate): string {
  return t(`wizard.template.${template.id}.prompt`);
}

export function templateById(id: string): TaskTemplate | undefined {
  return TASK_TEMPLATES.find((template) => template.id === id);
}
