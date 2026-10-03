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
import type {
  WorkflowDraft,
  WorkflowDraftRow,
  WorkflowRunJson,
  WorkflowTemplateJson,
} from "@armadra/shared";

import { TestProviders, installDomPolyfills } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";

const api = vi.hoisted(() => ({
  drafts: vi.fn(),
  confirmDraft: vi.fn(),
  discardDraft: vi.fn(),
  templates: vi.fn(),
  updateTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  runs: vi.fn(),
  startRun: vi.fn(),
  cancelRun: vi.fn(),
  answerGate: vi.fn(),
}));

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  workflowsApi: api,
}));

const { DraftCard } = await import("./DraftCard");
const { StartRunDialog, TemplateLibrary } = await import("./TemplateLibrary");
const { RunPanel, gateLabel } = await import("./RunPanel");
const { GateDialog } = await import("./GateDialog");
const { RunCompare } = await import("./RunCompare");
const { TemplateEditor, nextVersion } = await import("./TemplateEditor");
const { useWorkflowView } = await import("./store");
const model = await import("./model");

/** 工作流页面（设计系统 §5.5、契约 §15）。 */

const BODY: WorkflowDraft = {
  version: 1,
  title: "双人审查",
  params: [
    { name: "scope", type: "string", label: "范围", default: null },
    { name: "branch", type: "string", label: null, default: "main" },
  ],
  roles: [
    { id: "reviewer", agentId: "claude", title: "审查" },
    { id: "lead", agentId: "codex" },
  ],
  links: [{ from: "lead", to: "reviewer", role: "supervises" }],
  steps: [
    {
      id: "s1",
      kind: "prompt",
      role: "reviewer",
      prompt: "审查 {{scope}}",
      after: [],
    },
    { id: "s2", kind: "gate", label: "合并前确认", after: ["s1"] },
  ],
};

const TEMPLATE: WorkflowTemplateJson = {
  id: "tpl-1",
  name: "双人审查",
  version: 1,
  createdFromDraft: null,
  template: BODY,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

function run(patch: Partial<WorkflowRunJson> = {}): WorkflowRunJson {
  return {
    id: "run-1",
    templateId: "tpl-1",
    templateVersion: 1,
    title: "双人审查",
    workspaceId: "ws",
    boardId: "b1",
    frameId: "frame",
    params: { scope: "src/a", branch: "main" },
    status: "waiting",
    reason: null,
    roles: { reviewer: "n1", lead: "n2" },
    startedAt: "2026-10-02T08:00:00.000Z",
    endedAt: null,
    steps: [
      {
        stepId: "s1",
        kind: "prompt",
        role: "reviewer",
        status: "done",
        nodeId: "n1",
        startedAt: "2026-10-02T08:00:00.000Z",
        endedAt: "2026-10-02T08:03:00.000Z",
        reason: null,
        outputs: [
          {
            key: "review",
            body: "结论 A",
            at: "2026-10-02T08:02:00.000Z",
            target: "n2",
          },
        ],
        decision: null,
        note: null,
      },
      {
        stepId: "s2",
        kind: "gate",
        role: null,
        status: "waiting",
        nodeId: null,
        startedAt: "2026-10-02T08:03:00.000Z",
        endedAt: null,
        reason: null,
        outputs: [],
        decision: null,
        note: null,
      },
    ],
    ...patch,
  };
}

beforeAll(() => installDomPolyfills());
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  usePreferencesStore.getState().setLocale("zh-CN");
  useCanvasStore.setState({ boardId: "b1" });
  useWorkflowView.setState({
    tab: "templates",
    expanded: null,
    compare: [],
    comparing: false,
    gate: null,
    editing: null,
    starting: null,
  });
});
afterEach(() => cleanup());

describe("草案卡", () => {
  const row: WorkflowDraftRow = {
    id: "d1",
    workspaceId: "ws",
    boardId: "b1",
    proposerNodeId: "ama",
    status: "pending",
    templateId: null,
    draft: BODY,
    createdAt: "2026-10-02T08:00:00.000Z",
    updatedAt: "2026-10-02T08:00:00.000Z",
  };

  it("改了名字再保存：确认时带上新名字；丢弃走丢弃", async () => {
    api.confirmDraft.mockResolvedValue({ draft: row, template: TEMPLATE });
    api.discardDraft.mockResolvedValue(row);
    render(
      <TestProviders>
        <DraftCard row={row} />
      </TestProviders>,
    );
    expect(screen.getByText("2 角色 · 2 步 · claude / codex")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "每周审查" },
    });
    fireEvent.click(screen.getByText("保存为工作流"));
    await waitFor(() =>
      expect(api.confirmDraft).toHaveBeenCalledWith("d1", { name: "每周审查" }),
    );
    await waitFor(() =>
      expect(useCanvasStore.getState().panels.workflow).toBe("drawer"),
    );
    fireEvent.click(screen.getByText("丢弃"));
    await waitFor(() => expect(api.discardDraft).toHaveBeenCalledWith("d1"));
  });
});

describe("模板库与起跑", () => {
  it("空库只有一句话", () => {
    render(
      <TestProviders>
        <TemplateLibrary templates={[]} runs={[]} />
      </TestProviders>,
    );
    expect(screen.getByText("保存一次协作就会出现在这里")).toBeTruthy();
  });

  it("卡片给出角色、步骤与上次运行；运行先填参数，缺参数不发", async () => {
    api.startRun.mockResolvedValue(run({ id: "run-9", status: "running" }));
    function Harness() {
      const starting = useWorkflowView((state) => state.starting);
      return (
        <>
          <TemplateLibrary templates={[TEMPLATE]} runs={[run()]} />
          <StartRunDialog
            template={starting ? TEMPLATE : null}
            onClose={() => useWorkflowView.getState().start(null)}
          />
        </>
      );
    }
    render(
      <TestProviders>
        <Harness />
      </TestProviders>,
    );
    expect(screen.getByText(/2 角色 · 2 步 · 上次/)).toBeTruthy();
    fireEvent.click(screen.getByText("运行"));
    expect(await screen.findByText("运行「双人审查」")).toBeTruthy();
    // 「范围」没有缺省值也没填：不发。
    fireEvent.click(
      document.querySelector('[data-slot="workflow-start-submit"]')!,
    );
    expect(await screen.findByText("还有参数没填")).toBeTruthy();
    expect(api.startRun).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("范围"), {
      target: { value: "src/b" },
    });
    fireEvent.click(
      document.querySelector('[data-slot="workflow-start-submit"]')!,
    );
    await waitFor(() =>
      expect(api.startRun).toHaveBeenCalledWith({
        templateId: "tpl-1",
        params: { scope: "src/b" },
        boardId: "b1",
      }),
    );
    await waitFor(() => expect(useWorkflowView.getState().tab).toBe("runs"));
    expect(useWorkflowView.getState().expanded).toBe("run-9");
  });
});

describe("运行记录与关卡", () => {
  it("等人的关卡带说明打开答复框，通过时带上备注", async () => {
    api.answerGate.mockResolvedValue(run({ status: "running" }));
    render(
      <TestProviders>
        <RunPanel runs={[run()]} templates={[TEMPLATE]} />
        <GateDialog />
      </TestProviders>,
    );
    expect(screen.getByText("需要你")).toBeTruthy();
    fireEvent.click(screen.getByText("答复"));
    expect(await screen.findByText("合并前确认")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("备注"), {
      target: { value: "可以合" },
    });
    fireEvent.click(screen.getByText("通过"));
    await waitFor(() =>
      expect(api.answerGate).toHaveBeenCalledWith("run-1", "s2", {
        decision: "approve",
        note: "可以合",
      }),
    );
  });

  it("模板改过之后关卡说明退回步骤 id", () => {
    expect(gateLabel(run(), "s2", [TEMPLATE])).toBe("合并前确认");
    expect(gateLabel(run({ templateVersion: 2 }), "s2", [TEMPLATE])).toBe("s2");
  });

  it("勾两次才能对比，第三次挤掉最早的", () => {
    render(
      <TestProviders>
        <RunPanel
          runs={[run(), run({ id: "run-2" }), run({ id: "run-3" })]}
          templates={[TEMPLATE]}
        />
      </TestProviders>,
    );
    const compare = document.querySelector<HTMLButtonElement>(
      '[data-slot="workflow-compare"]',
    )!;
    expect(compare.disabled).toBe(true);
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    expect(compare.disabled).toBe(false);
    fireEvent.click(boxes[2]!);
    expect(useWorkflowView.getState().compare).toEqual(["run-2", "run-3"]);
  });
});

describe("两次运行对比", () => {
  it("同一步逐字比：相同标相同，不同标不同，缺的那边说没有", () => {
    const left = run({ status: "succeeded" });
    const changed = run({ id: "run-2" });
    changed.steps[0] = {
      ...changed.steps[0]!,
      outputs: [{ ...changed.steps[0]!.outputs[0]!, body: "结论 B" }],
    };
    changed.steps.push({ ...changed.steps[1]!, stepId: "s3" });
    const rows = model.compareRuns(left, changed);
    expect(rows.map((row) => [row.stepId, row.same])).toEqual([
      ["s1", false],
      ["s2", true],
      ["s3", false],
    ]);
    render(
      <TestProviders>
        <RunCompare left={left} right={changed} open onClose={() => {}} />
      </TestProviders>,
    );
    expect(screen.getByText("结论 A")).toBeTruthy();
    expect(screen.getByText("结论 B")).toBeTruthy();
    expect(screen.getAllByText("不同")).toHaveLength(2);
    expect(screen.getByText("没有这一步")).toBeTruthy();
  });
});

describe("模板编辑器", () => {
  it("改选中步骤的提示词，保存时版本加一", async () => {
    api.updateTemplate.mockResolvedValue(TEMPLATE);
    render(
      <TestProviders>
        <TemplateEditor template={TEMPLATE} onClose={() => {}} />
      </TestProviders>,
    );
    fireEvent.change(await screen.findByLabelText("提示词"), {
      target: { value: "仔细审查 {{scope}}" },
    });
    fireEvent.click(screen.getByText("保存"));
    await waitFor(() => expect(api.updateTemplate).toHaveBeenCalled());
    const [id, input] = api.updateTemplate.mock.calls[0]!;
    expect(id).toBe("tpl-1");
    expect(input.template.version).toBe(2);
    expect(input.template.steps[0].prompt).toBe("仔细审查 {{scope}}");
    expect(nextVersion({ ...TEMPLATE, version: 4 }, BODY).version).toBe(5);
  });
});

describe("模型", () => {
  it("缺参数只算没缺省值也没填的；空值不发", () => {
    expect(model.missingParams(BODY, {})).toEqual(["scope"]);
    expect(model.missingParams(BODY, { scope: "x" })).toEqual([]);
    expect(model.filledParams({ scope: "x", branch: " " })).toEqual({
      scope: "x",
    });
    expect(model.paramSummary({ scope: "src/a", branch: "" })).toBe(
      "scope=src/a",
    );
    expect(model.runTone("succeeded")).toBe("done");
    expect(model.outputCount(run())).toBe(1);
  });
});
