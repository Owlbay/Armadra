// 场景 10：六家互读（设计 cli-collaboration §8）。
//
// 六种 CLI（claude、codex、opencode、pi、omp、copilot）各起一个**交互式 TUI**
// 节点，按这个顺序连成一个环（`peer` 连线），然后：
//
//   1. 每个节点经页面敲一句「Reply with just OK.」，等 hook / 扩展报完一轮。
//   2. 环上每个下游以自己的节点身份 `context summary` / `context transcript`
//      读上游：读得到内容，且「来源」落在那一家的根下（OpenCode 是
//      `opencode:<id>`，不是文件路径）。
//   3. 沿环 `send` 一轮，六条投递都是 delivered，目标都真的跑了一轮。
//   4. 半截输入门造一条排队（同场景 2），目标那一侧经
//      `DELETE /api/workspaces/{id}/deliveries/{queueId}` 拒收，发送方的收件箱
//      出现 `receipt:<queueId>` 那一行（契约 §12.3）。
//   5. 选一对走交接 prepare → accept：材料里有转录摘录，目标收件箱多一条。
//   6. 会话索引里每家都有这次工作目录的会话；`GET /api/usage/cost` 每家的
//      `source` 不是 none，且 24 小时窗口里确实记到了 token（或请求数）。
//
// 另记每个节点 `agent_status.transcript_path` 有没有上报（设计 §9 H1：OMP 的扩
// 展报不报）。
//
// 环境：
//   * 另外四家的临时 HOME 与凭据用 lib.mjs 的 `prepareCliHomes`，但 Pi / OMP 的
//     agent 目录、COPILOT_HOME 与 OpenCode 的 XDG_DATA_HOME 指到 core 自己的那几
//     个根（`ctx.environment`）：core 按自己的环境找历史，CLI 写到别处的话索引
//     与成本都看不见。Pi 与 OMP 因此共用一个 agent 目录（core 的环境里
//     `PI_CODING_AGENT_DIR` 对两家都生效）。
//   * 这四家的启动行经页面的「自定义启动命令」（localStorage 的
//     `armadra.launchOverrides`）换成一个临时包装脚本：换掉 HOME 与配置目录、读
//     0600 的凭据文件、带上模型参数，再 `exec` 真 CLI；注入的参数照常由页面拼在
//     后面。与用户在设置里填自定义命令是同一条路。
//   * Claude 进程用真实配置目录（见入口顶部），而 core 的 CLAUDE_CONFIG_DIR 是临
//     时的：会话索引与成本扫不到真实目录。所以把**这一次**的转录文件硬链接进
//     core 的那个根（只这一个文件，同一个 inode，不改原文件、不读别的会话）。
//   * 某家没装或认证不上就整家记 skipped 并写明原因，其余照跑；环只连起来了的
//     那几家。
//
// 花费：每家三轮左右「回复 OK」（首轮、环上一轮、交接目标多一轮通知）。
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  copyFileSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  cliEnvLines,
  note,
  prepareCliHomes,
  putDocument,
  report,
  scenario,
  sleep,
  waitFor,
  waitSoft,
} from "./lib.mjs";

const FAMILIES = ["claude", "codex", "opencode", "pi", "omp", "copilot"];
const TASK = "Reply with just OK.";
const STEPS = [
  "tui",
  "turn",
  "transcriptPath",
  "summary",
  "transcript",
  "send",
  "receipt",
  "handoff",
  "conversations",
  "cost",
];

/** 交互式启动时各家额外带的参数：模型与省 token 的开关。 */
const TUI_ARGS = {
  opencode: (cli) => ["--model", cli.model],
  pi: (cli) => ["--model", cli.model, "--thinking", "off"],
  omp: (cli) => [`--model=${cli.model}`],
  copilot: (cli) => ["--model", cli.model, "--no-auto-update"],
};

const quote = (word) => `'${String(word).replaceAll("'", "'\\''")}'`;

/** 交互式包装：换环境、读凭据，`exec` 真 CLI，后面接页面拼好的注入参数。 */
function writeTuiWrapper(scratch, id, cli) {
  const wrapper = join(scratch, `tui-${id}.sh`);
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      ...cliEnvLines(scratch, id, cli),
      `exec ${[cli.program, ...TUI_ARGS[id](cli)].map(quote).join(" ")} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(wrapper, 0o755);
  return wrapper;
}

/** 刷一次 OpenCode 的在线模型目录，挑一个免费模型（名字里带 free 的优先）。 */
function pickFreeModel(scratch, cli) {
  const lister = join(scratch, "opencode-models.sh");
  writeFileSync(
    lister,
    [
      "#!/bin/sh",
      ...cliEnvLines(scratch, "opencode", cli),
      `exec ${quote(cli.program)} models --refresh`,
      "",
    ].join("\n"),
  );
  chmodSync(lister, 0o755);
  let listed = [];
  try {
    listed = execFileSync(lister, {
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("opencode/"));
  } catch {}
  return (
    listed.find((name) => name.endsWith("-free")) ?? listed[0] ?? cli.model
  );
}

/** `a` 在 `root`（或它的真实路径）下面。 */
function under(text, root) {
  if (typeof text !== "string" || root === undefined) return false;
  const candidates = [root];
  try {
    candidates.push(realpathSync(root));
  } catch {}
  return candidates.some((candidate) => text.includes(`${candidate}/`));
}

/** `context` 输出里的「来源：…」那一段。 */
function originOf(text) {
  const match = /来源：([^，\n]+?)(?:，读了|\n|$)/.exec(text ?? "");
  return match?.[1]?.trim();
}

export default async function run10(ctx) {
  const {
    api,
    scratch,
    project,
    projectReal,
    codexHome,
    claudeInstallHome,
    environment,
    workspace,
    documentPath,
    makeNode,
    edge,
    status,
    statusSummary,
    liveSession,
    screen,
    deliveriesTo,
    queueFor,
    all,
    canvasAs,
    contextAs,
    inboxOf,
    conversationsRows,
    openPage,
    waitAgentUp,
    waitDelivered,
    at,
  } = ctx;
  const s = scenario("10-six-way-context");
  const startedAt = Date.now();
  /** 每家每一步：passed / failed / skipped（带原因）。 */
  const matrix = Object.fromEntries(
    FAMILIES.map((id) => [id, Object.fromEntries(STEPS.map((k) => [k, "-"]))]),
  );
  const mark = (id, step, ok, why) => {
    matrix[id][step] = ok ? "passed" : why ? `failed: ${why}` : "failed";
    return ok;
  };
  const sixWay = (report.sixWay = {
    matrix,
    skipped: {},
    transcriptPaths: {},
    seconds: {},
  });
  const timed = async (name, body) => {
    const t0 = Date.now();
    try {
      return await body();
    } finally {
      sixWay.seconds[name] = Math.round((Date.now() - t0) / 1000);
    }
  };

  /** 节点完成一轮：`since` 之后报过 idle / done，来源是 hook 或扩展。 */
  const waitTurn = async (nodeId, since, timeout = 180_000) => {
    const seen = new Set();
    return waitFor(
      `${nodeId} 完成一轮`,
      () => {
        const row = status(nodeId);
        if (row === undefined) return undefined;
        const fresh = Date.parse(row.last_event_at ?? "") >= since;
        if (fresh) seen.add(row.state);
        return fresh &&
          ["idle", "done"].includes(row.state) &&
          ["hook", "extension"].includes(row.state_source)
          ? { seen: [...seen], final: statusSummary(nodeId) }
          : undefined;
      },
      { timeout, interval: 250 },
    );
  };

  let page = ctx.page;
  try {
    /* ------------------------------ 准备 ------------------------------ */

    const homes = prepareCliHomes(scratch, {
      dirs: {
        pi: environment.PI_CODING_AGENT_DIR,
        omp: environment.PI_CODING_AGENT_DIR,
        copilot: environment.COPILOT_HOME,
        xdgData: environment.XDG_DATA_HOME,
      },
    });
    const overrides = {};
    for (const id of ["opencode", "pi", "omp", "copilot"]) {
      const cli = homes[id];
      if (cli.skip) continue;
      if (id === "opencode") {
        cli.model = pickFreeModel(scratch, cli);
        note("OpenCode 用的免费模型", cli.model);
      }
      overrides[id] = writeTuiWrapper(scratch, id, cli);
    }
    for (const id of FAMILIES) {
      if (homes[id]?.skip) sixWay.skipped[id] = homes[id].skip;
    }
    const active = FAMILIES.filter((id) => sixWay.skipped[id] === undefined);
    for (const id of FAMILIES) {
      if (!active.includes(id)) {
        for (const step of STEPS)
          matrix[id][step] = `skipped: ${sixWay.skipped[id]}`;
        s.check(`${id}：跳过`, true, sixWay.skipped[id]);
      }
    }
    if (active.length < 2) throw new Error(`能跑的不到两家：${active}`);

    for (const id of active) {
      if (id === "claude" || id === "codex") continue;
      await api(`/api/agents/${id}/integration/install`, {
        method: "POST",
      }).catch((error) => note(`${id} 注入产物准备失败`, error.message));
    }

    // 各家 CLI 自己写历史的根：来源要落在这下面。
    const roots = {
      // 探针的 Claude 用真实配置目录；core 的那个根里只有硬链接过去的这一份。
      claude: [join(homedir(), ".claude"), claudeInstallHome],
      codex: [codexHome],
      pi: [environment.PI_CODING_AGENT_DIR],
      omp: [environment.PI_CODING_AGENT_DIR],
      copilot: [environment.COPILOT_HOME],
    };
    const belongs = (id, origin) =>
      id === "opencode"
        ? /opencode:\S+/.test(origin ?? "")
        : (roots[id] ?? []).some((root) => under(origin, root));

    // 页面的「自定义启动命令」：先写进 localStorage，再关页面改画布、重开页面。
    if (page === undefined) page = await openPage();
    await page.evaluate(`
      const key = "armadra.launchOverrides";
      const current = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(key, JSON.stringify({ ...current, ...${JSON.stringify(overrides)} }));
      return 1;
    `);
    await page.close();
    page = undefined;
    ctx.page = undefined;

    const nodes = Object.fromEntries(
      active.map((id, index) => [
        id,
        makeNode(`ring-${id}`, index * 620, 1300, id),
      ]),
    );
    // Claude 用「自动编辑」起：操作员的缺省权限模式是 bypass 时，新版 Claude 起
    // 来先弹「把 auto 设成缺省权限模式？」，缺省选项是「是」。首跑实测：TUI 没认
    // 出提示符，环上那条 send 照样投了进去，回车就把操作员
    // ~/.claude/settings.json 的 defaultMode 改成了 auto（已手动改回）。显式的
    // `--permission-mode` 不弹这个对话框。
    if (nodes.claude !== undefined)
      nodes.claude.data.agent.permissionMode = "auto-edit";
    const ring = active.map((id) => nodes[id]);
    const familyOf = Object.fromEntries(active.map((id) => [nodes[id].id, id]));
    const next = (index) => ring[(index + 1) % ring.length];
    const ready = (node) => matrix[familyOf[node.id]]?.turn === "passed";
    await putDocument(api, documentPath, (current) => ({
      nodes: [...current.nodes, ...ring],
      edges: [
        ...current.edges,
        ...ring.map((node, index) => edge(node, next(index), "peer")),
      ],
    }));
    note("环就位", active.map((id) => `ring-${id}`).join(" → "));
    page = await openPage();
    ctx.page = page;

    /* ------------------------- 1. 起 TUI、跑一轮 ------------------------- */

    await timed("tui+turn", async () => {
      for (const id of active) {
        const node = nodes[id];
        try {
          if (id === "claude" || id === "codex") {
            await waitAgentUp(node.id, id, page, 150_000);
          } else {
            // 另外四家没有固定的提示符可认：等扩展 / 插件的开场上报。
            await waitFor(
              `${id} 开场上报`,
              () => {
                const session = liveSession(node.id);
                const row = status(node.id);
                return session?.status === "running" &&
                  row !== undefined &&
                  ["hook", "extension"].includes(row.state_source)
                  ? row
                  : undefined;
              },
              { timeout: 150_000, interval: 1000 },
            );
          }
          mark(id, "tui", true);
        } catch (error) {
          mark(id, "tui", false, error.message);
          s.check(`${id} TUI 起来`, false, {
            error: error.message,
            screen: (await screen(node.id, 30))
              .split("\n")
              .filter(Boolean)
              .slice(-8),
          });
          continue;
        }
        await sleep(2500);
        await page.focusNode(node.id);
        const since = Date.now();
        await page.type(TASK);
        await sleep(500);
        await page.enter();
        const turn = await waitTurn(node.id, since).catch((error) => ({
          error: error.message,
        }));
        s.check(
          `${id} 首轮跑完`,
          mark(id, "turn", turn.error === undefined, turn.error),
          turn,
        );
      }
    });
    await page.shot("10-ring-first-turn", s);

    for (const id of active) {
      const path = status(nodes[id].id)?.transcript_path ?? null;
      sixWay.transcriptPaths[id] = path;
      s.check(
        `${id} 上报了 transcript_path`,
        mark(id, "transcriptPath", typeof path === "string" && path !== ""),
        path,
      );
    }

    // Claude：把这一次的转录硬链接进 core 的 CLAUDE_CONFIG_DIR（见顶部）。
    const claudePath = sixWay.transcriptPaths.claude;
    if (claudePath && existsSync(claudePath)) {
      const linked = join(
        claudeInstallHome,
        "projects",
        basename(dirname(claudePath)),
        basename(claudePath),
      );
      mkdirSync(dirname(linked), { recursive: true });
      try {
        linkSync(claudePath, linked);
      } catch {
        copyFileSync(claudePath, linked);
      }
      note("Claude 的转录已链接进 core 的根", linked);
    }

    /* ------------------------ 2. 下游读上游的上下文 ------------------------ */

    await timed("context", async () => {
      for (const [index, upstream] of ring.entries()) {
        const id = familyOf[upstream.id];
        const reader = next(index);
        if (matrix[id].turn !== "passed") {
          mark(id, "summary", false, "首轮没跑完");
          mark(id, "transcript", false, "首轮没跑完");
          continue;
        }
        for (const verb of ["summary", "transcript"]) {
          const answer = await contextAs(
            reader.id,
            verb,
            "--node",
            upstream.id,
          );
          const origin = originOf(answer.stdout);
          const ok =
            answer.code === 0 &&
            answer.stdout.length > 0 &&
            belongs(id, origin);
          s.check(
            `${familyOf[reader.id]} 读 ${id} 的 ${verb}：非空、来源属于 ${id}`,
            mark(id, verb, ok, ok ? undefined : (origin ?? answer.stderr)),
            { code: answer.code, origin, bytes: answer.stdout.length },
          );
        }
      }
    });

    /* --------------------------- 3. 沿环 send --------------------------- */

    await timed("send", async () => {
      const before = Object.fromEntries(
        ring.map((node) => [node.id, deliveriesTo(node.id).length]),
      );
      // 没跑完首轮的目标不投：它可能正停在某个启动对话框上，正文加回车就是替
      // 人选了缺省选项。
      const sent = await Promise.all(
        ring.map((node, index) =>
          ready(next(index))
            ? canvasAs(node.id, "send", "--to", next(index).id, "--body", TASK)
            : undefined,
        ),
      );
      for (const [index, answer] of sent.entries()) {
        if (answer !== undefined && answer.code !== 0)
          note(`ring-${familyOf[ring[index].id]} send 失败`, answer.stderr);
      }
      for (const [index, node] of ring.entries()) {
        const target = next(index);
        const id = familyOf[target.id];
        if (!ready(target)) {
          mark(id, "send", false, "首轮没跑完，不往里投");
          continue;
        }
        const row = await waitDelivered(target.id, before[target.id], 180_000)
          .then((found) => found)
          .catch((error) => ({
            error: error.message,
            queue: queueFor(target.id).map((item) => ({
              state: item.state,
              reason: item.last_reason,
            })),
          }));
        const delivered = row.outcome === "delivered";
        const turn = delivered
          ? await waitTurn(target.id, at(row)).catch((error) => ({
              error: error.message,
            }))
          : { error: "没投出去" };
        s.check(
          `ring-${familyOf[node.id]} → ${id}：delivered 且跑了一轮`,
          mark(
            id,
            "send",
            delivered && turn.error === undefined,
            delivered ? turn.error : (row.error ?? row.outcome),
          ),
          {
            outcome: row.outcome ?? row,
            targetState: row.target_state,
            turn: turn.error ?? turn.final?.state,
          },
        );
      }
    });

    /* ----------------------- 4. 拒收一条排队，发回执 ----------------------- */

    await timed("receipt", async () => {
      // 半截输入门最稳（场景 2 验过 Claude 的那条）；Claude 没起来就用环上第一
      // 个跑完首轮的。
      const targetIndex = ready(nodes.claude ?? {})
        ? active.indexOf("claude")
        : ring.findIndex(ready);
      if (targetIndex < 0) throw new Error("没有一个节点跑完首轮");
      const target = ring[targetIndex];
      const sender = ring[(targetIndex - 1 + ring.length) % ring.length];
      const id = familyOf[target.id];
      const half = "Reply with just";
      await page.focusNode(target.id);
      await page.type(half);
      // 人的租约十秒自动放手，之后挡住投递的只剩半截输入。
      await sleep(12_000);
      const queued = await canvasAs(
        sender.id,
        "send",
        "--to",
        target.id,
        "--body",
        "Reply with just OK again.",
      );
      const queueId = queued.json?.id;
      const isQueued = queued.json?.outcome === "queued" && queueId;
      s.check(`向 ${id} send 排队`, isQueued, queued.json ?? queued.stderr);
      let receipt;
      if (isQueued) {
        const rejected = await api(
          `/api/workspaces/${workspace.id}/deliveries/${queueId}`,
          { method: "DELETE" },
        );
        s.check(`${id} 那一侧拒收`, rejected?.cancelled === true, rejected);
        receipt = await waitSoft(
          () =>
            inboxOf(sender.id).find(
              (row) => row.message_key === `receipt:${queueId}`,
            ),
          { timeout: 15_000, interval: 500 },
        );
        const record = all(
          "SELECT outcome FROM agent_deliveries WHERE receipt = ? AND outcome = 'cancelled'",
          queueId,
        );
        s.check(
          `发送方 ring-${familyOf[sender.id]} 的收件箱有 receipt:<queueId>`,
          receipt !== undefined,
          receipt === undefined
            ? inboxOf(sender.id).map((row) => row.message_key)
            : { key: receipt.message_key, from: receipt.source_node_id },
        );
        s.check("拒收写了 cancelled 投递记录", record.length > 0, record);
        s.check(
          "回执的 from 是目标节点",
          receipt?.source_node_id === target.id,
          receipt?.source_node_id,
        );
      }
      mark(
        id,
        "receipt",
        Boolean(isQueued) && receipt?.source_node_id === target.id,
      );
      // 把半行删掉，免得它在后面的投递里跟着提交。
      await page.focusNode(target.id);
      for (let i = 0; i < half.length + 2; i += 1)
        await page.key("Backspace", 8);
    });

    /* --------------------------- 5. 交接一对 --------------------------- */

    await timed("handoff", async () => {
      // 源用 Pi（文件来源里行形状最不像 Claude 的那家）；它或它的下游没起来
      // 就换一对都跑完首轮的。
      let sourceIndex = active.indexOf("pi");
      if (!(ready(ring[sourceIndex] ?? {}) && ready(next(sourceIndex))))
        sourceIndex = ring.findIndex(
          (node, index) => ready(node) && ready(next(index)),
        );
      if (sourceIndex < 0) {
        s.check("交接：找不到两头都跑完首轮的一对", false);
        return;
      }
      const from = ring[sourceIndex];
      const to = next(sourceIndex);
      const id = familyOf[from.id];
      const fromSession = liveSession(from.id);
      const toSession = liveSession(to.id);
      const inboxBefore = inboxOf(to.id).length;
      let ok = false;
      try {
        const prepared = await api(`/api/workspaces/${workspace.id}/handoffs`, {
          method: "POST",
          body: JSON.stringify({
            sourceNodeId: from.id,
            sourceSessionId: fromSession.id,
            sourceGeneration: fromSession.generation,
            targetNodeId: to.id,
            targetSessionId: toSession.id,
            targetGeneration: toSession.generation,
            sections: { goal: "e2e handoff probe: nothing to do, reply OK" },
            filePaths: [],
            byteBudget: 8192,
            includeTranscript: true,
          }),
        });
        s.check(
          `交接 prepare（${id} → ${familyOf[to.id]}）`,
          prepared?.state === "prepared" && prepared.digest,
          { state: prepared?.state },
        );
        s.check(
          "交接材料里有转录摘录",
          (prepared?.bundle?.transcriptExcerpt ?? "").length > 0,
          { bytes: (prepared?.bundle?.transcriptExcerpt ?? "").length },
        );
        const accepted = await api(
          `/api/workspaces/${workspace.id}/handoffs/${prepared.bundle.handoffId}/accept`,
          {
            method: "POST",
            body: JSON.stringify({ expectedDigest: prepared.digest }),
          },
        );
        const notice = inboxOf(to.id)
          .slice(inboxBefore)
          .find((row) => row.source_node_id === from.id);
        s.check(
          "交接 accept：状态 queued，目标收件箱多一条来自源节点的",
          accepted?.state === "queued" && notice !== undefined,
          { state: accepted?.state, key: notice?.message_key },
        );
        ok =
          prepared?.state === "prepared" &&
          (prepared?.bundle?.transcriptExcerpt ?? "").length > 0 &&
          accepted?.state === "queued" &&
          notice !== undefined;
      } catch (error) {
        s.check(`交接（${id}）未抛错`, false, error.message);
      }
      mark(id, "handoff", ok);
    });

    /* ------------------------ 6. 会话索引与成本 ------------------------ */

    await timed("index+cost", async () => {
      await api("/api/conversations/refresh", { method: "POST" }).catch(
        (error) => note("会话索引刷新失败", error.message),
      );
      const rows = [
        ...conversationsRows(projectReal),
        ...(project === projectReal ? [] : conversationsRows(project)),
      ];
      sixWay.conversations = rows.map((row) => ({
        provider: row.provider,
        sessionId: row.session_id,
        path: row.path,
      }));
      for (const id of active) {
        const mine = rows.filter((row) => row.provider === id);
        s.check(
          `会话索引里有 ${id} 这次的会话`,
          mark(id, "conversations", mine.length > 0),
          mine.map((row) => row.path),
        );
      }
      // Pi 与 OMP 共用一个 agent 目录时，一个文件只该算在写它的那一家名下。
      const paths = new Map();
      for (const row of rows) {
        paths.set(row.path, [...(paths.get(row.path) ?? []), row.provider]);
      }
      const doubled = [...paths.entries()].filter(
        ([, providers]) => providers.length > 1,
      );
      s.check(
        "同一个会话文件没有被两家各认一次",
        doubled.length === 0,
        doubled.map(([path, providers]) => ({ path, providers })),
      );

      await api("/api/usage/cost/refresh", { method: "POST" }).catch((error) =>
        note("成本刷新失败", error.message),
      );
      const cost = await api("/api/usage/cost");
      const byAgent = cost?.ranges?.["24h"]?.byAgent ?? [];
      sixWay.cost = {};
      for (const id of active) {
        const row = byAgent.find((entry) => entry.agent === id);
        const tokens = row
          ? row.tokens.input +
            row.tokens.output +
            row.tokens.cacheRead +
            row.tokens.cacheCreation
          : 0;
        sixWay.cost[id] = {
          source: row?.source ?? null,
          unit: row?.unit ?? null,
          tokens,
          requests: row?.requests ?? 0,
          costUsd: row?.costUsd ?? 0,
        };
        s.check(
          `成本：${id} 的 source 不是 none，24 小时里记到了用量`,
          mark(
            id,
            "cost",
            row !== undefined &&
              row.source !== "none" &&
              (tokens > 0 || (row.requests ?? 0) > 0),
          ),
          sixWay.cost[id],
        );
      }
    });

    await page.shot("10-ring-done", s);
  } catch (error) {
    s.fail(error);
    if (page === undefined) page = await openPage().catch(() => undefined);
    await page?.shot("10-failure", s).catch(() => {});
  }
  ctx.page = page;
  sixWay.seconds.total = Math.round((Date.now() - startedAt) / 1000);
  note("六家互读矩阵", matrix);
  s.finish();
}
