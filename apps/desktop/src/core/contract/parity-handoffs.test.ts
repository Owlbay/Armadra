import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractEntries } from "@armadra/shared";
import { type AgentFixture, agentFixture } from "../agent/fixture";
import { routeScope } from "../http/route-scopes";
import { installContract } from "../http/rpc";
import { type Answer, type Kit, expectParity, startKit } from "./parity-kit";

/**
 * 对话交接的对偶测试（契约 §39.8）。
 *
 * 同一份夹具问三次：路由表里原来那条 handler、旧 REST 路径（经 HTTP，由契约实现
 * 经 `OpenAPIHandler` 答）、新 procedure。冻结、批准、撤回每种答法各用自己的那
 * 一份交接（各自一对节点），比较前把交接 id、摘要与时刻换成占位。
 */

let core: AgentFixture;
let kit: Kit;

/** 每次都会变的：交接与信箱的标识、摘要、冻结的时刻、各会话的标识。 */
const VOLATILE = new Set([
  "handoffId",
  "digest",
  "createdAt",
  "updatedAt",
  "acceptedAt",
  "mailboxId",
  "traceId",
  "nodeId",
  "sessionId",
  "sourceRevision",
  "reference",
  "sha256",
  "sourceUpdatedAt",
]);

beforeAll(async () => {
  core = agentFixture();
  installContract(core.server, {
    validateOutput: true,
    platform: core.platform,
  });
  kit = await startKit(core.server, () => undefined);
});

afterAll(async () => {
  await core.server.close();
  core.close();
});

const handoffs = () => `/api/workspaces/${core.workspaceId}/handoffs`;

/**
 * 一对连着线的 Agent 节点与它们的会话，加上冻结它们要的体。标题每对都一样：
 * 它冻结进包里，也算进字节预算。
 */
function pair() {
  const source = core.agentNode("Source");
  const target = core.agentNode("Target", "codex");
  core.link(source, target);
  return {
    source,
    target,
    body: {
      sourceNodeId: source,
      sourceSessionId: core.session(source, "claude"),
      sourceGeneration: 1,
      targetNodeId: target,
      targetSessionId: core.session(target, "codex"),
      targetGeneration: 1,
      sections: { goal: "finish it", pending: "tests" },
      filePaths: [],
      byteBudget: 8192,
      includeTranscript: false,
    },
  };
}

interface View {
  readonly bundle: { readonly handoffId: string };
  readonly digest: string;
}

/** 三种答法各冻结一份。 */
async function threePrepared(): Promise<[View, View, View]> {
  const [a, b, c] = [pair(), pair(), pair()];
  const made: [Answer, Answer, Answer] = [
    await kit.table("POST", handoffs(), a.body),
    await kit.legacy("POST", handoffs(), b.body),
    await kit.procedure("agents.prepareHandoff", {
      workspaceId: core.workspaceId,
      ...c.body,
    }),
  ];
  expectParity(made, { volatile: VOLATILE });
  expect(made[0].status).toBe(200);
  expect(made[0].body).toMatchObject({ state: "prepared", attempts: 0 });
  return made.map((answer) => answer.body as View) as [View, View, View];
}

describe("agents：对话交接（§39.8）", () => {
  it("冻结、读回、批准、撤回，再列出", async () => {
    const views = await threePrepared();
    const [one, two, three] = views.map((view) => view.bundle.handoffId) as [
      string,
      string,
      string,
    ];

    expectParity(
      [
        await kit.table("GET", `${handoffs()}/${one}`),
        await kit.legacy("GET", `${handoffs()}/${two}`),
        await kit.procedure("agents.handoff", {
          workspaceId: core.workspaceId,
          handoffId: three,
        }),
      ],
      { volatile: VOLATILE },
    );

    const accepted = [
      await kit.table("POST", `${handoffs()}/${one}/accept`, {
        expectedDigest: views[0].digest,
      }),
      await kit.legacy("POST", `${handoffs()}/${two}/accept`, {
        expectedDigest: views[1].digest,
      }),
      await kit.procedure("agents.acceptHandoff", {
        workspaceId: core.workspaceId,
        handoffId: three,
        expectedDigest: views[2].digest,
      }),
    ] as const;
    expectParity(accepted, { volatile: VOLATILE });
    expect(accepted[0].body).toMatchObject({ state: "queued", attempts: 1 });

    const cancelled = [
      await kit.table("POST", `${handoffs()}/${one}/cancel`, {
        expectedDigest: (accepted[0].body as View).digest,
      }),
      await kit.legacy("POST", `${handoffs()}/${two}/cancel`, {
        expectedDigest: (accepted[1].body as View).digest,
      }),
      await kit.procedure("agents.cancelHandoff", {
        workspaceId: core.workspaceId,
        handoffId: three,
        expectedDigest: (accepted[2].body as View).digest,
      }),
    ] as const;
    expectParity(cancelled, { volatile: VOLATILE });
    expect(cancelled[0].body).toMatchObject({ state: "cancelled" });

    const listed = [
      await kit.table("GET", handoffs()),
      await kit.legacy("GET", handoffs()),
      await kit.procedure("agents.handoffs", {
        workspaceId: core.workspaceId,
      }),
    ] as const;
    expectParity(listed, { volatile: VOLATILE });
    expect(listed[0].body).toHaveLength(3);
  });

  it("按节点列：来源与目标两边都看得到", async () => {
    const { source, target, body } = pair();
    const prepared = await kit.procedure("agents.prepareHandoff", {
      workspaceId: core.workspaceId,
      ...body,
    });
    expect(prepared.status).toBe(200);
    for (const node of [source, target]) {
      const answers = [
        await kit.table("GET", `${handoffs()}?sourceNodeId=${node}`),
        await kit.legacy("GET", `${handoffs()}?sourceNodeId=${node}`),
        await kit.procedure("agents.handoffs", {
          workspaceId: core.workspaceId,
          sourceNodeId: node,
        }),
      ] as const;
      expectParity(answers, { volatile: VOLATILE });
      expect(answers[0].body).toHaveLength(1);
    }
  });

  it("拒绝：码、状态与原话一样", async () => {
    // 缺了来源与目标。
    expectParity([
      await kit.table("POST", handoffs(), {
        sections: { goal: "x" },
        byteBudget: 8192,
      }),
      await kit.legacy("POST", handoffs(), {
        sections: { goal: "x" },
        byteBudget: 8192,
      }),
      await kit.procedure("agents.prepareHandoff", {
        workspaceId: core.workspaceId,
        sections: { goal: "x" },
        byteBudget: 8192,
      }),
    ]);
    // 不认识的交接。
    expectParity([
      await kit.table("GET", `${handoffs()}/nope`),
      await kit.legacy("GET", `${handoffs()}/nope`),
      await kit.procedure("agents.handoff", {
        workspaceId: core.workspaceId,
        handoffId: "nope",
      }),
    ]);
    // 预览的摘要不对：看到的和批准的不是同一份。
    const views = await threePrepared();
    const ids = views.map((view) => view.bundle.handoffId);
    expectParity([
      await kit.table("POST", `${handoffs()}/${ids[0]}/accept`, {
        expectedDigest: "stale",
      }),
      await kit.legacy("POST", `${handoffs()}/${ids[1]}/accept`, {
        expectedDigest: "stale",
      }),
      await kit.procedure("agents.acceptHandoff", {
        workspaceId: core.workspaceId,
        handoffId: ids[2],
        expectedDigest: "stale",
      }),
    ]);
    // 没带摘要。
    expectParity([
      await kit.table("POST", `${handoffs()}/${ids[0]}/cancel`, {}),
      await kit.legacy("POST", `${handoffs()}/${ids[1]}/cancel`, {}),
      await kit.procedure("agents.cancelHandoff", {
        workspaceId: core.workspaceId,
        handoffId: ids[2],
      }),
    ]);
  });
});

describe("契约与路由表（交接）", () => {
  const entries = contractEntries().filter((entry) =>
    /^agents\.(handoffs?|\w+Handoff)$/.test(entry.name),
  );

  it("五条，scope 与路由表给旧路径的一致，旧路径都在路由表里", () => {
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      "agents.acceptHandoff",
      "agents.cancelHandoff",
      "agents.handoff",
      "agents.handoffs",
      "agents.prepareHandoff",
    ]);
    for (const entry of entries) {
      const legacy = entry.meta.legacy!;
      expect(entry.meta.workspaceKey, entry.name).toBe("workspaceId");
      expect(
        routeScope(legacy.method, legacy.path)?.permission ?? null,
        entry.name,
      ).toBe(entry.meta.scope);
      expect(
        core.server.router.match(legacy.path)?.entry.methods,
        entry.name,
      ).toContain(legacy.method);
    }
  });
});
