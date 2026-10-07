/**
 * 一条会话的令牌：访问、刷新与到期时刻，只在内存里。
 *
 * 每个源一份：本机源的那份由身份面（`api/identity.ts`）持有，远程源的在各自的
 * 凭据来源里（`sources/credentials.ts`）。这个文件不 import 任何东西，身份面
 * 在模块求值时就要用它。
 */
export interface SessionTokens {
  access: string;
  refresh: string;
  /** 访问令牌到期的时刻（毫秒）；不知道是 0。 */
  accessExpiresAt: number;
  clear(): void;
}

export function createSessionTokens(): SessionTokens {
  return {
    access: "",
    refresh: "",
    accessExpiresAt: 0,
    clear() {
      this.access = "";
      this.refresh = "";
      this.accessExpiresAt = 0;
    },
  };
}
