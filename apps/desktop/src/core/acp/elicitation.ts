/**
 * `elicitation/create` 的两件纯事（契约 §26.1）：Agent 发来的请求收成审批行里
 * 存的那一份，人答的内容按它自己的 `requestedSchema` 校验。
 *
 * 不 import 别的域：审批（`agent/approvals.ts`）与会话层都用它。
 *
 * 表单只认规范允许的扁平原始类型（字符串、数、整数、布尔，字符串可带 `enum`）。
 * Agent 给了别的形状（嵌套对象、数组）时请求照样进审批行，但只能拒绝或取消：
 * 一个页面画不出来的字段，人也就答不了它。
 */

import type {
  AcpElicitationAction,
  AcpElicitationField,
  AcpElicitationParams,
  AcpElicitationResult,
  AcpElicitationSchema,
  AcpElicitationValue,
} from "./types";
import { ACP_ELICITATION_ACTIONS } from "./types";

/** 审批行里一条 elicitation 存的样子（`request_json.elicitation`）。 */
export interface StoredElicitation {
  readonly message: string;
  readonly mode: "form" | "url";
  readonly requestedSchema?: AcpElicitationSchema;
  readonly url?: string;
}

/** 消息与字段说明的上限：只为不让一条请求把审批行撑大。 */
const MESSAGE_LIMIT = 4_000;
const FIELD_LIMIT = 64;
const TEXT_LIMIT = 1_000;
const ENUM_LIMIT = 200;

function clip(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function textOf(value: unknown, limit = TEXT_LIMIT): string | undefined {
  return typeof value === "string" ? clip(value, limit) : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** 一个字段收成规范的子集；认不出的答 `undefined`（整张表单就答不了）。 */
function fieldOf(raw: unknown): AcpElicitationField | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const field = raw as Record<string, unknown>;
  const common = {
    ...(textOf(field.title) === undefined
      ? {}
      : { title: textOf(field.title) }),
    ...(textOf(field.description) === undefined
      ? {}
      : { description: textOf(field.description) }),
  };
  switch (field.type) {
    case "string": {
      const values = Array.isArray(field.enum)
        ? field.enum.filter((item): item is string => typeof item === "string")
        : undefined;
      const names = Array.isArray(field.enumNames)
        ? field.enumNames.filter(
            (item): item is string => typeof item === "string",
          )
        : undefined;
      return {
        type: "string",
        ...common,
        ...(values === undefined
          ? {}
          : {
              enum: values.slice(0, ENUM_LIMIT).map((v) => clip(v, TEXT_LIMIT)),
            }),
        ...(names === undefined
          ? {}
          : {
              enumNames: names
                .slice(0, ENUM_LIMIT)
                .map((v) => clip(v, TEXT_LIMIT)),
            }),
        ...(textOf(field.format, 40) === undefined
          ? {}
          : { format: textOf(field.format, 40) }),
        ...(finite(field.minLength) === undefined
          ? {}
          : { minLength: finite(field.minLength) }),
        ...(finite(field.maxLength) === undefined
          ? {}
          : { maxLength: finite(field.maxLength) }),
        ...(typeof field.default === "string"
          ? { default: clip(field.default, TEXT_LIMIT) }
          : {}),
      } as AcpElicitationField;
    }
    case "number":
    case "integer":
      return {
        type: field.type,
        ...common,
        ...(finite(field.minimum) === undefined
          ? {}
          : { minimum: finite(field.minimum) }),
        ...(finite(field.maximum) === undefined
          ? {}
          : { maximum: finite(field.maximum) }),
        ...(finite(field.default) === undefined
          ? {}
          : { default: finite(field.default) }),
      } as AcpElicitationField;
    case "boolean":
      return {
        type: "boolean",
        ...common,
        ...(typeof field.default === "boolean"
          ? { default: field.default }
          : {}),
      } as AcpElicitationField;
    default:
      return undefined;
  }
}

/**
 * 表单 schema 收成规范子集。字段超过 {@link FIELD_LIMIT} 个、或有一个字段认
 * 不出时答 `undefined`：这张表单只能拒绝或取消。
 */
export function schemaOf(raw: unknown): AcpElicitationSchema | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const schema = raw as Record<string, unknown>;
  if (schema.type !== undefined && schema.type !== "object") return undefined;
  const properties =
    typeof schema.properties === "object" && schema.properties !== null
      ? Object.entries(schema.properties as Record<string, unknown>)
      : [];
  if (properties.length > FIELD_LIMIT) return undefined;
  const fields: Record<string, AcpElicitationField> = {};
  for (const [name, value] of properties) {
    const field = fieldOf(value);
    if (field === undefined) return undefined;
    fields[clip(name, 200)] = field;
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter(
        (name): name is string => typeof name === "string" && name in fields,
      )
    : [];
  return {
    type: "object",
    properties: fields,
    ...(required.length === 0 ? {} : { required }),
  };
}

/** Agent 的请求 → 审批行里存的那一份。`_meta` 与未知字段不存。 */
export function storedElicitation(
  params: AcpElicitationParams,
): StoredElicitation {
  const mode = params.mode === "url" ? "url" : "form";
  const schema = mode === "form" ? schemaOf(params.requestedSchema) : undefined;
  return {
    message: clip(String(params.message ?? ""), MESSAGE_LIMIT),
    mode,
    ...(schema === undefined ? {} : { requestedSchema: schema }),
    ...(mode === "url" && typeof params.url === "string"
      ? { url: clip(params.url, 2_000) }
      : {}),
  };
}

/** 审批行的 `request_json` 里那一份；不是 elicitation 答 `undefined`。 */
export function elicitationOf(request: unknown): StoredElicitation | undefined {
  if (typeof request !== "object" || request === null) return undefined;
  const raw = request as { protocol?: unknown; elicitation?: unknown };
  if (raw.protocol !== "acp") return undefined;
  const value = raw.elicitation;
  if (typeof value !== "object" || value === null) return undefined;
  const stored = value as Record<string, unknown>;
  return {
    message: typeof stored.message === "string" ? stored.message : "",
    mode: stored.mode === "url" ? "url" : "form",
    ...(stored.requestedSchema === undefined
      ? {}
      : (() => {
          const schema = schemaOf(stored.requestedSchema);
          return schema === undefined ? {} : { requestedSchema: schema };
        })()),
    ...(typeof stored.url === "string" ? { url: stored.url } : {}),
  };
}

export function isElicitationAction(
  value: unknown,
): value is AcpElicitationAction {
  return (
    typeof value === "string" &&
    (ACP_ELICITATION_ACTIONS as readonly string[]).includes(value)
  );
}

function valueFits(
  field: AcpElicitationField,
  value: unknown,
): value is AcpElicitationValue {
  switch (field.type) {
    case "string": {
      if (typeof value !== "string") return false;
      if (field.enum !== undefined && !field.enum.includes(value)) return false;
      if (field.minLength !== undefined && value.length < field.minLength)
        return false;
      if (field.maxLength !== undefined && value.length > field.maxLength)
        return false;
      return value.length <= 8_192;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      if (field.type === "integer" && !Number.isInteger(value)) return false;
      if (field.minimum !== undefined && value < field.minimum) return false;
      if (field.maximum !== undefined && value > field.maximum) return false;
      return true;
    }
    case "boolean":
      return typeof value === "boolean";
    default:
      return false;
  }
}

/** 一次答复的校验结果：成功时是要交给 Agent 的那一份。 */
export type ElicitationCheck =
  | { readonly ok: true; readonly result: AcpElicitationResult }
  | { readonly ok: false; readonly message: string };

/**
 * 人答的内容按请求自己的 schema 校验：`accept` 要一张能画出来的表单（URL 模式
 * 没有内容），字段只能是 schema 里有的、类型对的，`required` 都在；`decline` /
 * `cancel` 不带内容。
 */
export function checkElicitationAnswer(
  stored: StoredElicitation,
  answer: { readonly action: unknown; readonly content?: unknown },
): ElicitationCheck {
  if (!isElicitationAction(answer.action)) {
    return { ok: false, message: "action must be accept, decline or cancel" };
  }
  if (answer.action !== "accept") {
    if (answer.content !== undefined && answer.content !== null) {
      return { ok: false, message: "content is only sent with accept" };
    }
    return { ok: true, result: { action: answer.action } };
  }
  if (stored.mode === "url") {
    if (answer.content !== undefined && answer.content !== null) {
      return { ok: false, message: "a URL elicitation takes no content" };
    }
    return { ok: true, result: { action: "accept" } };
  }
  const schema = stored.requestedSchema;
  if (schema === undefined) {
    return {
      ok: false,
      message: "this elicitation's form cannot be answered; decline or cancel",
    };
  }
  const content = answer.content ?? {};
  if (
    typeof content !== "object" ||
    content === null ||
    Array.isArray(content)
  ) {
    return { ok: false, message: "content must be an object" };
  }
  const out: Record<string, AcpElicitationValue> = {};
  for (const [name, value] of Object.entries(content)) {
    const field = schema.properties[name];
    if (field === undefined) {
      return { ok: false, message: `${name} is not a field of this form` };
    }
    if (!valueFits(field, value)) {
      return { ok: false, message: `${name} does not fit its field` };
    }
    out[name] = value;
  }
  for (const name of schema.required ?? []) {
    if (!(name in out)) {
      return { ok: false, message: `${name} is required` };
    }
  }
  return { ok: true, result: { action: "accept", content: out } };
}
