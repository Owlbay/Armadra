import {
  Bell,
  Blocks,
  Bot,
  Gauge,
  GitPullRequest,
  Globe,
  History,
  Info,
  KeyRound,
  Keyboard,
  LayoutGrid,
  MonitorSmartphone,
  Presentation,
  Server,
  ServerCog,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  Star,
  Users,
  Waypoints,
  type LucideIcon,
} from "lucide-react";

import { RUNTIME_VIA_SERVER_SHELL } from "@/api/request";
import { isDesktop } from "@/platform";

/**
 * 设置页的分区注册表（界面第二波 §2.1）。
 *
 * 左栏一列导航，右栏是**当前分区独立的一页**，切换时整页替换。这张表决定
 * 导航顺序、分组切分、页面标题与作用范围；加一页只要在这里加一行，再在
 * `pages/index.ts` 的 `SECTION_PAGES` 里挂上组件。
 *
 * 分组由**相邻同 `groupKey` 的行**切出来，所以行的顺序就是视觉顺序。
 */

/**
 * 一页设置写到哪里：
 *
 * - `device`：眼前这台设备（localStorage），对成员与远程源一律可见；
 * - `host`：设置作用的那台 core（`/api/settings` 等），远程源时就是那台机器；
 * - `account`：当前登录的这个人（登录方式、设备、会话）。
 */
export type SettingsScope = "device" | "host" | "account";

export interface SettingsSection {
  /** 存进偏好、也是 `SECTION_PAGES` 的键。 */
  id: string;
  /** 导航里的分组标题（i18n 键）。 */
  groupKey: string;
  /** 分区标题（i18n 键），同时是右栏页头。 */
  labelKey: string;
  /** 导航项左侧的 16px 线性图标。 */
  icon: LucideIcon;
  /** 页头作用范围徽标（§2.3）。 */
  scope: SettingsScope;
  /**
   * 只在桌面壳里出现：这一页上的每一项都只对壳里的 `<webview>` 有意义。
   */
  desktopOnly?: boolean;
  /**
   * 只在服务器壳托管的页面上出现：账号与共享只对「一台服务器、好几个人」
   * 有意义。
   */
  serverOnly?: boolean;
  /**
   * 只给 owner；只许出现在 `host` 页上。
   *
   * 这些页读写整台机器的设置，而共享只发工作空间上的授权：成员打开它们看到
   * 的是缺省值，改了之后只会收到一句「保存失败」。`device` 页写的是本机
   * localStorage，谁都能改，所以永远不带这一条。
   */
  ownerOnly?: boolean;
  /**
   * 只对眼前这台设备有意义：设置作用的 core 在别处（经中继、直连远端源，或
   * 当前源是挂载的远程源，`remote-access.ts`）时不列。
   */
  localOnly?: boolean;
  /**
   * 固定操作本机 core，与当前源无关（远程访问页，`api/remote-services.ts`）：
   * 页头徽标恒为「本机」。
   */
  pinnedLocal?: boolean;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    // 首行是「Agent 默认视图」：新建节点最常改的那一项放在最前面。
    id: "defaults",
    groupKey: "settings.group.frequent",
    labelKey: "settings.section.defaults",
    icon: Star,
    scope: "device",
  },
  {
    id: "general",
    groupKey: "settings.group.look",
    labelKey: "settings.section.general",
    icon: SlidersHorizontal,
    scope: "device",
  },
  {
    id: "notifications",
    groupKey: "settings.group.look",
    labelKey: "settings.section.notifications",
    icon: Bell,
    scope: "device",
  },
  {
    id: "whiteboard",
    groupKey: "settings.group.look",
    labelKey: "settings.section.whiteboard",
    icon: Presentation,
    scope: "device",
  },
  {
    id: "terminalLook",
    groupKey: "settings.group.look",
    labelKey: "settings.section.terminalLook",
    icon: SquareTerminal,
    scope: "device",
  },
  {
    // 浏览器节点的内存配置说的是这扇窗口里的 `<webview>`。
    id: "browser",
    groupKey: "settings.group.look",
    labelKey: "settings.section.browser",
    icon: Globe,
    scope: "device",
    desktopOnly: true,
    localOnly: true,
  },
  {
    // 本设备那一层谁都能改；全局那一层只对 owner 可写（页内按行判断）。
    id: "keybindings",
    groupKey: "settings.group.look",
    labelKey: "settings.section.keybindings",
    icon: Keyboard,
    scope: "device",
  },
  {
    id: "agents",
    groupKey: "settings.group.agent",
    labelKey: "settings.section.agents",
    icon: Bot,
    scope: "host",
    ownerOnly: true,
  },
  {
    id: "customAgents",
    groupKey: "settings.group.agent",
    labelKey: "settings.section.customAgents",
    icon: Blocks,
    scope: "host",
    ownerOnly: true,
  },
  {
    id: "sessions",
    groupKey: "settings.group.agent",
    labelKey: "settings.section.sessions",
    icon: History,
    scope: "host",
    ownerOnly: true,
  },
  {
    id: "credentials",
    groupKey: "settings.group.agent",
    labelKey: "settings.section.credentials",
    icon: KeyRound,
    scope: "host",
    ownerOnly: true,
  },
  {
    id: "usage",
    groupKey: "settings.group.agent",
    labelKey: "settings.section.usage",
    icon: Gauge,
    scope: "host",
    ownerOnly: true,
  },
  {
    id: "workspace",
    groupKey: "settings.group.space",
    labelKey: "settings.section.workspace",
    icon: LayoutGrid,
    scope: "host",
    ownerOnly: true,
  },
  {
    // 成员只见连接状态（页内判断），所以整页不带 ownerOnly。
    id: "service",
    groupKey: "settings.group.host",
    labelKey: "settings.section.service",
    icon: ServerCog,
    scope: "host",
  },
  {
    id: "machines",
    groupKey: "settings.group.host",
    labelKey: "settings.section.machines",
    icon: Server,
    scope: "host",
    ownerOnly: true,
  },
  {
    id: "forge",
    groupKey: "settings.group.host",
    labelKey: "settings.section.forge",
    icon: GitPullRequest,
    scope: "host",
    ownerOnly: true,
  },
  {
    id: "remoteAccess",
    groupKey: "settings.group.remote",
    labelKey: "settings.section.remoteAccess",
    icon: Waypoints,
    scope: "host",
    ownerOnly: true,
    pinnedLocal: true,
  },
  {
    // 登录方式、设备与会话说的是「我」，不是这台机器，所以成员也进得来。
    id: "devices",
    groupKey: "settings.group.remote",
    labelKey: "settings.section.devices",
    icon: MonitorSmartphone,
    scope: "account",
  },
  {
    id: "security",
    groupKey: "settings.group.account",
    labelKey: "settings.section.security",
    icon: ShieldCheck,
    scope: "account",
  },
  {
    id: "accounts",
    groupKey: "settings.group.account",
    labelKey: "settings.section.accounts",
    icon: Users,
    scope: "host",
    serverOnly: true,
  },
  {
    id: "about",
    groupKey: "settings.group.about",
    labelKey: "settings.section.about",
    icon: Info,
    scope: "host",
  },
];

export const DEFAULT_SETTINGS_SECTION = SETTINGS_SECTIONS[0]!.id;

/**
 * 上一版导航的分区 id → 新 id（§2.2）。
 *
 * `lastSettingsSection` 存在 localStorage 里，桌面壳重载回设置时也带着它；
 * 这些旧 id 先映射再判断，老用户重开设置落在内容所在的新页，而不是回到第一页。
 */
export const LEGACY_SECTION_IDS: Readonly<Record<string, string>> = {
  agent: "defaults",
  integration: "agents",
  terminal: "terminalLook",
  host: "service",
  remote: "remoteAccess",
  github: "forge",
  ssh: "machines",
  executionHosts: "machines",
  data: "service",
  account: "usage",
  updates: "about",
};

/** 旧 id 映射成新 id；不认识的原样返回（交给 `isSettingsSectionId` 判断）。 */
export function canonicalSectionId(value: string): string {
  return Object.hasOwn(LEGACY_SECTION_IDS, value)
    ? LEGACY_SECTION_IDS[value]!
    : value;
}

/**
 * 这台机器上真正能进的分区。壳不在时少几行，而不是几行点不动的。
 *
 * `remote`：设置作用的 core 不在眼前这台设备上（`remote-access.ts`），只对
 * 本机有意义的分区不列。
 */
export function visibleSettingsSections(
  server: boolean = RUNTIME_VIA_SERVER_SHELL,
  member = false,
  remote = false,
): SettingsSection[] {
  const desktop = isDesktop();
  return SETTINGS_SECTIONS.filter(
    (section) =>
      (desktop || !section.desktopOnly) &&
      (server || !section.serverOnly) &&
      (!member || !section.ownerOnly) &&
      (!remote || !section.localOnly),
  );
}

export function isSettingsSectionId(
  value: unknown,
  member = false,
  remote = false,
): value is string {
  if (typeof value !== "string") return false;
  const id = canonicalSectionId(value);
  return visibleSettingsSections(RUNTIME_VIA_SERVER_SHELL, member, remote).some(
    (section) => section.id === id,
  );
}

/** 存着的分区（可能是旧 id）→ 这一刻该打开的分区。 */
export function activeSectionId(
  stored: unknown,
  member = false,
  remote = false,
): string {
  return isSettingsSectionId(stored, member, remote)
    ? canonicalSectionId(stored)
    : DEFAULT_SETTINGS_SECTION;
}

export function settingsSection(id: string): SettingsSection {
  const canonical = canonicalSectionId(id);
  return (
    SETTINGS_SECTIONS.find((section) => section.id === canonical) ??
    SETTINGS_SECTIONS[0]!
  );
}

export interface SettingsNavGroup {
  groupKey: string;
  sections: SettingsSection[];
}

/** 按注册顺序切成连续的分组段——顺序即导航里的顺序。 */
export function groupSections(
  sections: readonly SettingsSection[] = visibleSettingsSections(),
): SettingsNavGroup[] {
  const groups: SettingsNavGroup[] = [];
  for (const section of sections) {
    const last = groups[groups.length - 1];
    if (last && last.groupKey === section.groupKey) last.sections.push(section);
    else groups.push({ groupKey: section.groupKey, sections: [section] });
  }
  return groups;
}
