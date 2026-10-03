import { DomainError } from "../workspaces/support";
import {
  WORKFLOW_ID_PATTERN,
  WORKFLOW_LIMITS,
  WORKFLOW_PARAM_PATTERN,
  WORKFLOW_PARAM_TYPES,
  type WorkflowDraft,
  type WorkflowLink,
  type WorkflowParam,
  type WorkflowRole,
  type WorkflowSource,
  type WorkflowStep,
} from "./types";

/**
 * 草案 JSON 的校验与参数代入（契约 §15.1）。
 *
 * 手写而不是 zod：core 不依赖 `@armadra/shared`。规则与共享层那份 schema 逐条
 * 对应——未知字段丢掉、缺省值补上、`agentId` 必须是注册表 id 或 `custom:`、
 * `after` 不能指向不存在的步骤也不能成环、`collect` 的来源必须在它自己的
 * `after` 里（汇总的东西得先存在）。
 *
 * 校验只回答「这份 JSON 是不是一份草案」；「这台机器能不能跑它」（权限模式、
 * 参数是否给齐、代入之后是否超长）是起跑时的问题，在 `engine.ts`。
 */

export function invalidDraft(message: string): DomainError {
  return new DomainError(400, "invalid_draft", message);
}

type Json = Record<string, unknown>;

function object(value: unknown, where: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidDraft(`${where} 必须是一个对象。`);
  }
  return value as Json;
}

function array(value: unknown, where: string, max: number, min = 0): unknown[] {
  if (value === undefined && min === 0) return [];
  if (!Array.isArray(value)) throw invalidDraft(`${where} 必须是数组。`);
  if (value.length < min) throw invalidDraft(`${where} 至少要 ${min} 项。`);
  if (value.length > max) throw invalidDraft(`${where} 最多 ${max} 项。`);
  return value;
}

function text(
  value: unknown,
  where: string,
  max: number,
  options: { readonly optional?: boolean } = {},
): string | null {
  if (value === undefined || value === null) {
    if (options.optional === true) return null;
    throw invalidDraft(`${where} 不能缺。`);
  }
  if (typeof value !== "string" || value.length === 0) {
    throw invalidDraft(`${where} 必须是非空字符串。`);
  }
  if ([...value].length > max) {
    throw invalidDraft(`${where} 最长 ${max} 个字符。`);
  }
  return value;
}

function identifier(value: unknown, where: string): string {
  if (typeof value !== "string" || !WORKFLOW_ID_PATTERN.test(value)) {
    throw invalidDraft(`${where} 必须是以字母开头、最多 32 个字符的标识。`);
  }
  return value;
}

function ids(value: unknown, where: string): string[] {
  return array(value, where, WORKFLOW_LIMITS.steps).map((entry, index) =>
    identifier(entry, `${where}[${index}]`),
  );
}

export interface DraftRules {
  /** 注册表 id 或 `custom:`（`agent/registry.ts::validAgentId`）。 */
  readonly validAgentId: (agentId: string) => boolean;
}

/** 校验并规整一份草案；不成立就抛 `INVALID_DRAFT`。 */
export function parseDraft(raw: unknown, rules: DraftRules): WorkflowDraft {
  let input = raw;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input) as unknown;
    } catch {
      throw invalidDraft("草案不是合法的 JSON。");
    }
  }
  const draft = object(input, "草案");
  const bytes = Buffer.byteLength(JSON.stringify(draft), "utf8");
  if (bytes > WORKFLOW_LIMITS.draftBytes) {
    throw invalidDraft(`草案超过 ${WORKFLOW_LIMITS.draftBytes} 字节。`);
  }
  const version = draft.version;
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    throw invalidDraft("version 是不小于 1 的整数。");
  }
  const title = text(draft.title, "title", WORKFLOW_LIMITS.title) as string;

  const params = array(draft.params, "params", WORKFLOW_LIMITS.params).map(
    (entry, index) => parseParam(entry, `params[${index}]`),
  );
  const roles = array(draft.roles, "roles", WORKFLOW_LIMITS.roles, 1).map(
    (entry, index) => parseRole(entry, `roles[${index}]`, rules),
  );
  const links = array(draft.links, "links", WORKFLOW_LIMITS.links).map(
    (entry, index) => parseLink(entry, `links[${index}]`),
  );
  const steps = array(draft.steps, "steps", WORKFLOW_LIMITS.steps, 1).map(
    (entry, index) => parseStep(entry, `steps[${index}]`),
  );

  unique(
    params.map((param) => param.name),
    "params",
  );
  const roleIds = unique(
    roles.map((role) => role.id),
    "roles",
  );
  const stepIds = unique(
    steps.map((step) => step.id),
    "steps",
  );
  links.forEach((link, index) => {
    if (!roleIds.has(link.from) || !roleIds.has(link.to)) {
      throw invalidDraft(`links[${index}] 连的不是草案里的角色。`);
    }
    if (link.from === link.to) {
      throw invalidDraft(`links[${index}] 两端是同一个角色。`);
    }
  });
  steps.forEach((step, index) => {
    if (step.kind !== "gate" && !roleIds.has(step.role)) {
      throw invalidDraft(`steps[${index}] 的 role \`${step.role}\` 不存在。`);
    }
    for (const id of step.after) {
      if (!stepIds.has(id) || id === step.id) {
        throw invalidDraft(
          `steps[${index}] 的 after 里 \`${id}\` 不是别的步骤。`,
        );
      }
    }
    if (step.kind === "collect") {
      for (const id of step.from) {
        if (!step.after.includes(id)) {
          throw invalidDraft(
            `steps[${index}] 汇总的 \`${id}\` 必须也写在它的 after 里。`,
          );
        }
      }
    }
  });
  const cycle = findCycle(steps);
  if (cycle !== undefined) {
    throw invalidDraft(`after 成环：${cycle.join(" → ")}。`);
  }
  const source =
    draft.source === undefined || draft.source === null
      ? undefined
      : parseSource(draft.source);
  return {
    version,
    title,
    params,
    roles,
    links,
    steps,
    ...(source === undefined ? {} : { source }),
  };
}

function unique(values: readonly string[], where: string): Set<string> {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw invalidDraft(`${where} 里 \`${value}\` 重复。`);
    seen.add(value);
  }
  return seen;
}

function parseParam(raw: unknown, where: string): WorkflowParam {
  const entry = object(raw, where);
  const name = entry.name;
  if (typeof name !== "string" || !WORKFLOW_PARAM_PATTERN.test(name)) {
    throw invalidDraft(`${where}.name 必须是字母、数字、下划线组成的名字。`);
  }
  const type = entry.type ?? "string";
  if (!(WORKFLOW_PARAM_TYPES as readonly unknown[]).includes(type)) {
    throw invalidDraft(
      `${where}.type 只能是 ${WORKFLOW_PARAM_TYPES.join(" / ")}。`,
    );
  }
  const label = text(entry.label, `${where}.label`, 160, { optional: true });
  const fallback =
    entry.default === undefined || entry.default === null
      ? null
      : typeof entry.default === "string" &&
          [...entry.default].length <= WORKFLOW_LIMITS.paramValue
        ? entry.default
        : (() => {
            throw invalidDraft(`${where}.default 必须是字符串。`);
          })();
  return {
    name,
    type: type as WorkflowParam["type"],
    ...(label === null ? {} : { label }),
    ...(fallback === null ? {} : { default: fallback }),
  };
}

const PERMISSION_MODES = ["default", "auto-edit", "full-auto", "plan"];

function parseRole(
  raw: unknown,
  where: string,
  rules: DraftRules,
): WorkflowRole {
  const entry = object(raw, where);
  const id = identifier(entry.id, `${where}.id`);
  const agentId = entry.agentId;
  if (typeof agentId !== "string" || !rules.validAgentId(agentId)) {
    throw invalidDraft(
      `${where}.agentId \`${String(agentId)}\` 不是注册表里的 Agent，也不是 custom: 开头的自定义 Agent。`,
    );
  }
  const permissionMode = entry.permissionMode ?? null;
  if (
    permissionMode !== null &&
    (typeof permissionMode !== "string" ||
      !PERMISSION_MODES.includes(permissionMode))
  ) {
    throw invalidDraft(
      `${where}.permissionMode 只能是 ${PERMISSION_MODES.join(" / ")}。`,
    );
  }
  const title = text(entry.title, `${where}.title`, 160, { optional: true });
  const model = text(entry.model, `${where}.model`, WORKFLOW_LIMITS.model, {
    optional: true,
  });
  const worktree = text(entry.worktree, `${where}.worktree`, 200, {
    optional: true,
  });
  return {
    id,
    agentId,
    title,
    permissionMode: permissionMode as string | null,
    model,
    worktree,
  };
}

function parseLink(raw: unknown, where: string): WorkflowLink {
  const entry = object(raw, where);
  const role = entry.role ?? "peer";
  if (role !== "peer" && role !== "supervises") {
    throw invalidDraft(`${where}.role 只能是 peer / supervises。`);
  }
  return {
    from: identifier(entry.from, `${where}.from`),
    to: identifier(entry.to, `${where}.to`),
    role,
  };
}

function parseStep(raw: unknown, where: string): WorkflowStep {
  const entry = object(raw, where);
  const id = identifier(entry.id, `${where}.id`);
  const after = ids(entry.after, `${where}.after`);
  switch (entry.kind) {
    case "prompt":
      return {
        id,
        kind: "prompt",
        role: identifier(entry.role, `${where}.role`),
        prompt: text(
          entry.prompt,
          `${where}.prompt`,
          WORKFLOW_LIMITS.prompt,
        ) as string,
        after,
      };
    case "collect": {
      const from = ids(entry.from, `${where}.from`);
      if (from.length === 0) throw invalidDraft(`${where}.from 至少要一项。`);
      return {
        id,
        kind: "collect",
        role: identifier(entry.role, `${where}.role`),
        from,
        prompt: text(
          entry.prompt,
          `${where}.prompt`,
          WORKFLOW_LIMITS.prompt,
        ) as string,
        after,
      };
    }
    case "gate":
      return {
        id,
        kind: "gate",
        label: text(entry.label, `${where}.label`, 160) as string,
        after,
      };
    default:
      throw invalidDraft(`${where}.kind 只能是 prompt / collect / gate。`);
  }
}

function parseSource(raw: unknown): WorkflowSource {
  const entry = object(raw, "source");
  const nodeIds =
    entry.nodeIds === undefined || entry.nodeIds === null
      ? null
      : array(entry.nodeIds, "source.nodeIds", 64).map((value) => {
          if (typeof value !== "string") {
            throw invalidDraft("source.nodeIds 必须是字符串数组。");
          }
          return value;
        });
  return {
    boardId: text(entry.boardId, "source.boardId", 200, { optional: true }),
    nodeIds,
    proposedBy: text(entry.proposedBy, "source.proposedBy", 64, {
      optional: true,
    }),
    sessionId: text(entry.sessionId, "source.sessionId", 200, {
      optional: true,
    }),
  };
}

/** `after` 的环：找到一条就回它（从环上的第一个回到它自己），没有回 `undefined`。 */
export function findCycle(
  steps: readonly { readonly id: string; readonly after: readonly string[] }[],
): string[] | undefined {
  const edges = new Map(steps.map((step) => [step.id, step.after]));
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    const mark = state.get(id);
    if (mark === 2) return undefined;
    if (mark === 1) return [...path.slice(path.indexOf(id)), id];
    state.set(id, 1);
    path.push(id);
    for (const next of edges.get(id) ?? []) {
      if (!edges.has(next)) continue;
      const found = visit(next);
      if (found !== undefined) return found;
    }
    path.pop();
    state.set(id, 2);
    return undefined;
  };
  for (const step of steps) {
    const found = visit(step.id);
    if (found !== undefined) return found;
  }
  return undefined;
}

/* --------------------------------- 参数 ----------------------------------- */

/**
 * 起跑时给的参数，按草案的声明补缺省、拒未知、拒缺。值一律是字符串。
 */
export function resolveParams(
  draft: WorkflowDraft,
  given: unknown,
): Record<string, string> {
  const supplied = given === undefined || given === null ? {} : (given as Json);
  if (typeof supplied !== "object" || Array.isArray(supplied)) {
    throw new DomainError(400, "bad_request", "params 必须是一个对象。");
  }
  const declared = new Map(draft.params.map((param) => [param.name, param]));
  for (const name of Object.keys(supplied)) {
    if (!declared.has(name)) {
      throw new DomainError(400, "bad_request", `模板没有参数 \`${name}\`。`);
    }
  }
  const resolved: Record<string, string> = {};
  for (const param of draft.params) {
    const value = supplied[param.name] ?? param.default ?? undefined;
    if (value === undefined || value === null || value === "") {
      throw new DomainError(
        400,
        "missing_param",
        `参数 \`${param.name}\` 没有给值。`,
      );
    }
    if (typeof value !== "string") {
      throw new DomainError(
        400,
        "bad_request",
        `参数 \`${param.name}\` 必须是字符串。`,
      );
    }
    if ([...value].length > WORKFLOW_LIMITS.paramValue) {
      throw new DomainError(
        400,
        "bad_request",
        `参数 \`${param.name}\` 最长 ${WORKFLOW_LIMITS.paramValue} 个字符。`,
      );
    }
    resolved[param.name] = value;
  }
  return resolved;
}

/** `{{name}}` 换成参数值；没声明的名字原样留着（那是提示词里的字面量）。 */
export function renderPrompt(
  prompt: string,
  params: Readonly<Record<string, string>>,
): string {
  return prompt.replace(
    /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
    (whole, name: string) => params[name] ?? whole,
  );
}

/**
 * `collect` 投出去的正文末尾会多一句「来源步骤的结论在你的收件箱里」
 * （`engine.ts::collectNote`），给它留的余量。
 */
export const COLLECT_NOTE_RESERVE = 200;

/** 每一步代入之后都不超长；超了在起跑前就拒绝，而不是跑到一半才发现。 */
export function checkRendered(
  draft: WorkflowDraft,
  params: Readonly<Record<string, string>>,
): void {
  for (const step of draft.steps) {
    if (step.kind === "gate") continue;
    const rendered = renderPrompt(step.prompt, params);
    const reserve = step.kind === "collect" ? COLLECT_NOTE_RESERVE : 0;
    if ([...rendered].length + reserve > WORKFLOW_LIMITS.prompt) {
      throw new DomainError(
        400,
        "prompt_too_long",
        `步骤 \`${step.id}\` 代入参数之后超过 ${WORKFLOW_LIMITS.prompt} 个字符。`,
      );
    }
  }
}
