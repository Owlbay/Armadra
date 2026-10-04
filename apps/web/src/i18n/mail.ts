import type { MessageModule } from "./index";

/**
 * 邮件通道：邀请与重置链接的「发送邮件」（G5-03 / G5-13，契约 §28）。
 *
 * G5-00 先登记空模块，免得各包同时改 `index.ts`；键由实现它的包填，两种语言
 * 同步加。
 */
export const mail: MessageModule = {
  "zh-CN": {},
  en: {},
};
