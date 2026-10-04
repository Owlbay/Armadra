import type { MessageModule } from "./index";

/**
 * 托管平台：Git 工具窗口的「托管」区与「Git 托管」设置页（G5-15，契约 §29）。
 *
 * G5-00 先登记空模块，免得各包同时改 `index.ts`；键由实现它的包填，两种语言
 * 同步加。
 */
export const forge: MessageModule = {
  "zh-CN": {},
  en: {},
};
