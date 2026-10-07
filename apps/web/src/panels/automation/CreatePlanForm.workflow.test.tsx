import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { WorkflowTemplateJson } from "@armadra/shared";

import { TestProviders, installDomPolyfills } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import {
  AutomationTargetKind,
  type AutomationApi,
} from "../../api/automations";

const templates = vi.hoisted(() => vi.fn());
vi.mock("@/workflow/api", async (original) => {
  const actual = await original<typeof import("@/workflow/api")>();
  return {
    ...actual,
    workflowsApi: { ...actual.workflowsApi, templates },
  };
});

const { CreatePlanForm } = await import("./CreatePlanForm");

/** 自动化表单的「运行工作流」目标（契约 §15.6）。 */

const TEMPLATE: WorkflowTemplateJson = {
  id: "tpl-1",
  name: "夜间审查",
  version: 3,
  createdFromDraft: null,
  template: {
    version: 3,
    title: "夜间审查",
    params: [{ name: "scope", type: "string", label: "范围", default: null }],
    roles: [{ id: "worker", agentId: "claude" }],
    links: [],
    steps: [
      {
        id: "s1",
        kind: "prompt",
        role: "worker",
        prompt: "审查 {{scope}}",
        after: [],
      },
    ],
  },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const client = {
  listCommandSessions: vi.fn(async () => ({
    sessions: [],
    nextId: "",
    hasMore: false,
  })),
} as unknown as AutomationApi;

beforeAll(() => installDomPolyfills());
beforeEach(() => {
  templates.mockResolvedValue([TEMPLATE]);
  usePreferencesStore.getState().setLocale("zh-CN");
  useCanvasStore.setState({ boardId: "board-1" });
});
afterEach(() => cleanup());

describe("运行工作流的计划", () => {
  it("从模板库来：模板预选，参数冻结进载荷，目标钉住模板版本与画布", async () => {
    const onCreate = vi.fn();
    render(
      <TestProviders>
        <CreatePlanForm
          client={client}
          hostId="0123456789abcdef0123456789abcdef"
          workspaceId="workspace-1"
          busy={false}
          prefill={{
            targetKind: "workflow",
            nodeId: "",
            title: "夜间审查",
            origin: "workflow",
            workflow: { templateId: "tpl-1", params: {} },
          }}
          onCreate={onCreate}
        />
      </TestProviders>,
    );
    const scope = await waitFor(() => {
      const input = document.querySelector('[data-param="scope"]');
      if (!input) throw new Error("参数输入还没出现");
      return input;
    });
    // 缺参数：不保存。
    fireEvent.click(document.querySelector('[data-slot="automation-submit"]')!);
    expect(await screen.findByText("还有参数没填")).toBeTruthy();
    expect(onCreate).not.toHaveBeenCalled();
    fireEvent.change(scope, { target: { value: "src" } });
    fireEvent.click(document.querySelector('[data-slot="automation-submit"]')!);
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    const request = onCreate.mock.calls[0]![0];
    expect(request.payload).toBe('{"params":{"scope":"src"}}');
    expect(request.config.target.kind).toBe(AutomationTargetKind.WORKFLOW_RUN);
    expect(request.config.target.workflowRun).toEqual({
      templateId: "tpl-1",
      templateVersion: 3,
      boardId: "board-1",
    });
    expect(request.config.title).toBe("夜间审查");
  });
});
