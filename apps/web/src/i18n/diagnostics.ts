import type { MessageModule } from "./index";

/**
 * 页面错误上报：通用页诊断区的「包含页面错误」开关（G5-19，契约 §30）。
 *
 * G5-00 先登记空模块，免得各包同时改 `index.ts`；键由实现它的包填，两种语言
 * 同步加。
 */
export const diagnostics: MessageModule = {
  "zh-CN": {},
  en: {},
};
