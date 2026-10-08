import { createElement, Fragment, type ReactElement } from "react";

import { useAccess } from "../../../app/use-access";
import { RealtimeSetting } from "../../../realtime/RealtimeSetting";
import { parseSubpage, useSubpage, type SubpageKind } from "../subpage";
import { AboutPage } from "./AboutPage";
import { AccountPage } from "./AccountPage";
import { AccountsSharingPage } from "./AccountsSharingPage";
import { AgentPage } from "./AgentPage";
import { BrowserPage } from "./BrowserPage";
import { DataPage } from "./DataPage";
import { DefaultsPage } from "./DefaultsPage";
import { ExecutionHostsPage } from "./ExecutionHostsPage";
import { CrashReportGroup, GeneralPage } from "./GeneralPage";
import { GithubPage } from "./GithubPage";
import { HostPage } from "./HostPage";
import { IntegrationPage } from "./IntegrationPage";
import { KeybindingsPage } from "./KeybindingsPage";
import { NotificationsPage } from "./NotificationsPage";
import { RemoteServicesPage } from "./RemoteServicesPage";
import { SshPage } from "./SshPage";
import { TerminalLookPage } from "./TerminalLookPage";
import { TerminalPage } from "./TerminalPage";
import { WhiteboardPage } from "./WhiteboardPage";
import { WorkspacePage } from "./WorkspacePage";
import { SecurityPage } from "./security/SecurityPage";

type Page = () => ReactElement | null;

interface Part {
  page: Page;
  /** 这一段自己推入的子页；子页开着时只画它那一段。 */
  subpage?: SubpageKind;
  /** 成员看不到的段（读写整台机器的设置）。 */
  ownerOnly?: boolean;
}

/**
 * 几张现有页按顺序叠成一页（§2.1 的合并页在拆分之前的过渡形态）。
 *
 * 子页在同一右栏里推入：哪一段的子页开着，就只画那一段，别的段不在表单
 * 下面陪跑。
 */
function stack(...parts: Part[]): Page {
  return function StackedPage() {
    const { member } = useAccess();
    const current = parseSubpage(useSubpage().current);
    const owner = current
      ? parts.find((part) => part.subpage === current.kind)
      : undefined;
    const shown = owner
      ? [owner]
      : parts.filter((part) => !member || !part.ownerOnly);
    return createElement(
      Fragment,
      null,
      ...shown.map((part, index) => createElement(part.page, { key: index })),
    );
  };
}

/**
 * 分区 id → 页面。顺序由 `nav.ts` 决定，这里只管挂组件。
 *
 * Agent、主机、远程访问那几组的新页还没拆出来时先指向内容所在的现有页
 * （§10 包 B 接手）：功能一项不丢，只是暂时多处可达。
 */
export const SECTION_PAGES: Readonly<Record<string, Page>> = {
  defaults: DefaultsPage,
  general: GeneralPage,
  notifications: NotificationsPage,
  whiteboard: WhiteboardPage,
  terminalLook: TerminalLookPage,
  browser: BrowserPage,
  keybindings: KeybindingsPage,
  agents: IntegrationPage,
  customAgents: AgentPage,
  sessions: AgentPage,
  credentials: AgentPage,
  usage: AccountPage,
  workspace: stack({ page: WorkspacePage }, { page: RealtimeSetting }),
  service: stack(
    { page: HostPage },
    { page: TerminalPage, ownerOnly: true },
    { page: DataPage, ownerOnly: true },
    { page: CrashReportGroup, ownerOnly: true },
  ),
  machines: stack(
    { page: SshPage, subpage: "ssh" },
    { page: ExecutionHostsPage, subpage: "executionHosts" },
  ),
  forge: GithubPage,
  remoteAccess: RemoteServicesPage,
  devices: SecurityPage,
  security: SecurityPage,
  accounts: AccountsSharingPage,
  about: AboutPage,
};
