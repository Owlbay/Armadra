/**
 * 设置 → 安全（补全架构 §8.3）：passkey、MFA、会话与设备、审计。
 *
 * G0-2 先占住分区与页面位置，内容由 G2-8 在本目录下补齐并替换这个占位。
 * 所有角色都能进（`ownerOnly: false`）：每个人都要管自己的登录方式与设备。
 */
export function SecurityPage() {
  return <div data-slot="security-page" className="flex flex-col gap-6" />;
}
