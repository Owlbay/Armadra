/**
 * 按模型选择（契约 §26.2）：Agent 在会话配置项里给的模型目录。
 *
 * ACP 的会话配置项（`configOptions`）随 `session/new|load|resume` 的答复来，
 * 也可能先在 `initialize` 的答复里；之后 Agent 以 `config_option_update` 更新、
 * 客户端以 `session/set_config_option` 改。模型那一项按 `category: "model"`
 * 认，没有分类时按 id `model` 认；都没有就是这家不给选模型。
 *
 * 纯函数，不起进程、不碰客户端。
 */

import type {
  AcpConfigSelectGroup,
  AcpConfigSelectOption,
  AcpSessionConfigOption,
} from "./types";

export interface AcpModel {
  readonly modelId: string;
  readonly name: string;
  readonly description?: string | null;
}

/** 页面看到的模型目录（与 `modes` 同一个形状）。 */
export interface AcpModelState {
  readonly currentModelId: string;
  readonly availableModels: readonly AcpModel[];
}

/** core 自己多记的那一项：改模型时发给 Agent 的配置项 id。 */
export interface AcpModelCatalog extends AcpModelState {
  readonly configId: string;
}

/** 目录的上限：只为不让一个 Agent 把答复撑大。 */
const MODEL_LIMIT = 500;

function isGroup(
  value: AcpConfigSelectOption | AcpConfigSelectGroup,
): value is AcpConfigSelectGroup {
  return Array.isArray((value as { options?: unknown }).options);
}

function flatten(
  options: readonly (AcpConfigSelectOption | AcpConfigSelectGroup)[],
): AcpConfigSelectOption[] {
  const out: AcpConfigSelectOption[] = [];
  for (const option of options) {
    if (typeof option !== "object" || option === null) continue;
    if (isGroup(option)) {
      out.push(...flatten(option.options));
    } else if (typeof option.value === "string") {
      out.push(option);
    }
  }
  return out;
}

function modelOption(
  options: readonly AcpSessionConfigOption[],
): AcpSessionConfigOption | undefined {
  const valid = options.filter(
    (option) =>
      typeof option === "object" &&
      option !== null &&
      typeof option.id === "string" &&
      Array.isArray(option.options),
  );
  return (
    valid.find((option) => option.category === "model") ??
    valid.find(
      (option) =>
        (option.category === undefined || option.category === null) &&
        option.id === "model",
    )
  );
}

/** 配置项 → 模型目录；没有模型那一项或一个可选值都没有时答 `null`。 */
export function modelCatalogOf(configOptions: unknown): AcpModelCatalog | null {
  if (!Array.isArray(configOptions)) return null;
  const option = modelOption(configOptions as AcpSessionConfigOption[]);
  if (option === undefined) return null;
  const seen = new Set<string>();
  const models: AcpModel[] = [];
  for (const entry of flatten(option.options)) {
    if (seen.has(entry.value) || models.length >= MODEL_LIMIT) continue;
    seen.add(entry.value);
    models.push({
      modelId: entry.value,
      name: typeof entry.name === "string" ? entry.name : entry.value,
      ...(typeof entry.description === "string"
        ? { description: entry.description }
        : {}),
    });
  }
  if (models.length === 0) return null;
  const current =
    typeof option.currentValue === "string" && seen.has(option.currentValue)
      ? option.currentValue
      : (models[0] as AcpModel).modelId;
  return {
    configId: option.id,
    currentModelId: current,
    availableModels: models,
  };
}

/** 页面那一份（不带 `configId`）。 */
export function modelStateOf(
  catalog: AcpModelCatalog | null,
): AcpModelState | null {
  return catalog === null
    ? null
    : {
        currentModelId: catalog.currentModelId,
        availableModels: catalog.availableModels,
      };
}

/** 一个答复（开会话、改配置项、`config_option_update`）里的 `configOptions`。 */
export function configOptionsOf(value: unknown): unknown {
  return typeof value === "object" && value !== null
    ? (value as { configOptions?: unknown }).configOptions
    : undefined;
}
