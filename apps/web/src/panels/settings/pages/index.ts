import type { ReactElement } from "react";

import { AboutPage } from "./AboutPage";
import { AccountsSharingPage } from "./AccountsSharingPage";
import { AgentsPage } from "./AgentsPage";
import { BrowserPage } from "./BrowserPage";
import { CredentialsPage } from "./CredentialsPage";
import { CustomAgentsPage } from "./CustomAgentsPage";
import { DefaultsPage } from "./DefaultsPage";
import { DevicesPage } from "./DevicesPage";
import { ForgePage } from "./ForgePage";
import { GeneralPage } from "./GeneralPage";
import { KeybindingsPage } from "./KeybindingsPage";
import { MachinesPage } from "./MachinesPage";
import { NotificationsPage } from "./NotificationsPage";
import { RemoteAccessPage } from "./RemoteAccessPage";
import { ServicePage } from "./ServicePage";
import { SessionsPage } from "./SessionsPage";
import { TerminalLookPage } from "./TerminalLookPage";
import { UsagePage } from "./UsagePage";
import { WhiteboardPage } from "./WhiteboardPage";
import { WorkspacePage } from "./WorkspacePage";
import { SecurityPage } from "./security/SecurityPage";

type Page = () => ReactElement | null;

/** 分区 id → 页面。顺序由 `nav.ts` 决定，这里只管挂组件；一页一个组件。 */
export const SECTION_PAGES: Readonly<Record<string, Page>> = {
  defaults: DefaultsPage,
  general: GeneralPage,
  notifications: NotificationsPage,
  whiteboard: WhiteboardPage,
  terminalLook: TerminalLookPage,
  browser: BrowserPage,
  keybindings: KeybindingsPage,
  agents: AgentsPage,
  customAgents: CustomAgentsPage,
  sessions: SessionsPage,
  credentials: CredentialsPage,
  usage: UsagePage,
  workspace: WorkspacePage,
  service: ServicePage,
  machines: MachinesPage,
  forge: ForgePage,
  remoteAccess: RemoteAccessPage,
  devices: DevicesPage,
  security: SecurityPage,
  accounts: AccountsSharingPage,
  about: AboutPage,
};
