import type { MessageModule } from "./index";

/**
 * 协调者的分派抽屉与成员行（G5-09）。
 *
 * G5-00 先登记空模块，免得各包同时改 `index.ts`；键由实现它的包填，两种语言
 * 同步加。
 */
export const coordinator: MessageModule = {
  "zh-CN": {},
  en: {},
};
