/**
 * 非 GitHub 平台答复的公共拆解：远端给什么都先过这里，长度有上限、类型不对就
 * 落到空值，网页地址只认 http(s)。Gitea 与 GitLab 共用。
 */

import { MAX_NUMBER, forgeError } from "./types";

export function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

/** 只认 http(s) 的网页地址；别的协议（`javascript:`…）丢掉。 */
export function webUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  return /^https?:\/\//i.test(value) ? value.slice(0, 2048) : "";
}

export function numbered(number: number): number {
  if (!Number.isSafeInteger(number) || number <= 0 || number > MAX_NUMBER) {
    throw forgeError("invalid", "NUMBER_INVALID");
  }
  return number;
}
