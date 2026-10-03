/**
 * 评论正文里的提及记号（契约 §16.3）：`@[显示名](principal:<id>)`。
 *
 * 单独一个文件：路由按它判提及，`collab/context-link.ts` 按它把正文换成给
 * Agent 看的纯文本，后者不该为此牵进整个路由模块。
 */

/** 一条评论里最多认这么多个提及；再多的照原文留着。 */
export const MAX_MENTIONS = 20;

/** `@[显示名](principal:<id>)`。显示名不跨行、不含 `]`。 */
const MENTION = /@\[([^\]\n]{1,80})\]\(principal:([A-Za-z0-9._:-]{1,128})\)/g;

/** 正文里写到的提及（principal id，去重、按出现顺序），不判是否存在。 */
export function mentionTokens(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(MENTION)) {
    const id = match[2];
    if (id !== undefined) seen.add(id);
    if (seen.size >= MAX_MENTIONS) break;
  }
  return [...seen];
}

/** 给 Agent 与日志看的正文：提及换成 `@显示名`。 */
export function plainCommentText(body: string): string {
  return body.replace(MENTION, (_whole, name: string) => `@${name}`);
}
