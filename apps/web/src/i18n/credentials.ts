import type { MessageModule } from "./index";

/**
 * 节点凭据（补全架构 §9.1，契约 §20）：设置 → Agent 的凭据区块、节点头的账号
 * 标记、起终端被拒时的那句话。界面只显示名字与种类，从不回显值。
 */
const zh = {
  "credentials.title": "节点凭据",
  "credentials.empty": "暂无凭据",
  "credentials.add": "添加凭据",
  "credentials.kind": "种类",
  "credentials.label": "名称",
  "credentials.value": "值",
  "credentials.save": "保存",
  "credentials.cancel": "取消",
  "credentials.delete": "删除",
  "credentials.deleteConfirm": "删除凭据「{label}」？",
  "credentials.deleted": "已删除凭据",
  "credentials.saved": "已保存凭据",
  "credentials.notSet": "未设置",
  "credentials.pending": "待实测",
  "credentials.note":
    "凭据只交给 CLI 进程，但 CLI 启动的子进程也能读到，请使用权限最小的令牌。",
  "credentials.unavailable.credential_backend_insecure":
    "本机密钥存储是明文文件，不能保存凭据",
  "credentials.unavailable.credential_unsupported_here":
    "此安装缺少画布启动器，不能使用节点凭据",
  "credentials.badge.title": "账号：{account}",
  "credentials.badge.default": "默认登录",
  "credentials.badge.switched": "重启终端后生效",
  "credentials.error.credential_not_found": "凭据不存在",
  "credentials.error.credential_mismatch": "凭据与节点的 Agent 不匹配",
  "credentials.error.credential_kind_disabled": "这种凭据尚未启用",
  "credentials.error.credential_unsupported_here":
    "这里不能使用节点凭据（SSH 节点或缺少画布启动器）",
  "credentials.error.credential_backend_insecure":
    "本机密钥存储是明文文件，不能使用凭据",
  "credentials.error.credential_unset": "凭据没有值，请重新设置",
  "credentials.error.credential_unavailable": "密钥存储暂时不可用",
};

const en: typeof zh = {
  "credentials.title": "Node credentials",
  "credentials.empty": "No credentials",
  "credentials.add": "Add credential",
  "credentials.kind": "Kind",
  "credentials.label": "Name",
  "credentials.value": "Value",
  "credentials.save": "Save",
  "credentials.cancel": "Cancel",
  "credentials.delete": "Delete",
  "credentials.deleteConfirm": "Delete credential “{label}”?",
  "credentials.deleted": "Credential deleted",
  "credentials.saved": "Credential saved",
  "credentials.notSet": "Not set",
  "credentials.pending": "Pending verification",
  "credentials.note":
    "Credentials go to the CLI process only, but processes the CLI starts can read them too. Use the narrowest token you can.",
  "credentials.unavailable.credential_backend_insecure":
    "This host stores secrets in a plain file, so credentials cannot be saved",
  "credentials.unavailable.credential_unsupported_here":
    "This installation has no canvas launcher, so node credentials are unavailable",
  "credentials.badge.title": "Account: {account}",
  "credentials.badge.default": "Default login",
  "credentials.badge.switched": "Takes effect after the terminal restarts",
  "credentials.error.credential_not_found": "The credential does not exist",
  "credentials.error.credential_mismatch":
    "The credential does not match this node's agent",
  "credentials.error.credential_kind_disabled":
    "This kind of credential is not enabled yet",
  "credentials.error.credential_unsupported_here":
    "Node credentials cannot be used here (SSH node or no canvas launcher)",
  "credentials.error.credential_backend_insecure":
    "This host stores secrets in a plain file, so credentials cannot be used",
  "credentials.error.credential_unset":
    "The credential has no value; set it again",
  "credentials.error.credential_unavailable":
    "The secret store is unavailable right now",
};

export const credentials: MessageModule = {
  "zh-CN": zh,
  en,
};
