import type { MessageModule } from "./index";

/**
 * 口令重置链接：签发对话框与整页「设置新口令」（G5-03，契约 §25）。
 *
 * G5-00 先登记空模块，免得各包同时改 `index.ts`；键由实现它的包填，两种语言
 * 同步加。
 */
export const passwordReset: MessageModule = {
  "zh-CN": {},
  en: {},
};
