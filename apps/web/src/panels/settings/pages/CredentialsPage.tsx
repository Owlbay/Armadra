import { useRuntimeSettings } from "../use-runtime-settings";
import { AgentCredentials } from "./AgentCredentials";
import { AmaKeys } from "./AmaKeys";
import { CopilotSignIn } from "./CopilotSignIn";

/**
 * 设置 → 凭据与密钥（§2.1）：节点凭据、Armadra Agent 的模型密钥、Copilot 登录。
 * 每一样只说「有没有、叫什么」，值写进去之后不再出现。
 */
export function CredentialsPage() {
  const { settings, save } = useRuntimeSettings();
  const busy = !settings.data || save.isPending;
  // Copilot 的额度要借用登录令牌，另有一个默认关的出站键（外部服务 §9.3）：
  // 用量页那个开关关着时不能开始登录，已登录的仍可登出。
  const copilotUsage =
    settings.data?.usage?.providers?.copilot !== false &&
    settings.data?.usage?.copilotUsage === true;
  return (
    <>
      <AgentCredentials />
      <AmaKeys />
      <CopilotSignIn disabled={busy} signInDisabled={!copilotUsage} />
    </>
  );
}
