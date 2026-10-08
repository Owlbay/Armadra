import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const access = vi.hoisted(() => ({ member: false }));
vi.mock("../../../app/use-access", () => ({
  useAccess: () => ({ member: access.member }),
}));

/** 每张现有页换成一个只报名字的替身：这里只验证怎么叠。 */
function stub(name: string) {
  return { [name]: () => <div data-testid="part">{name}</div> };
}
vi.mock("./HostPage", () => stub("HostPage"));
vi.mock("./TerminalPage", () => stub("TerminalPage"));
vi.mock("./DataPage", () => stub("DataPage"));
vi.mock("./SshPage", () => stub("SshPage"));
vi.mock("./ExecutionHostsPage", () => stub("ExecutionHostsPage"));
vi.mock("./WorkspacePage", () => stub("WorkspacePage"));
vi.mock("../../../realtime/RealtimeSetting", () => stub("RealtimeSetting"));
vi.mock("./GeneralPage", () => ({
  ...stub("GeneralPage"),
  ...stub("CrashReportGroup"),
  CONTROL_WIDTH: "w-[168px]",
}));

import { usePreferencesStore } from "../../../app/preferences-store";
import { SECTION_PAGES } from "./index";

const parts = () =>
  screen.queryAllByTestId("part").map((element) => element.textContent);

function show(id: string) {
  const Page = SECTION_PAGES[id]!;
  render(<Page />);
}

beforeEach(() => {
  access.member = false;
  usePreferencesStore.setState({ settingsSubpage: null });
});
afterEach(cleanup);

describe("合并页的过渡形态（§2.2）", () => {
  it("本机服务：连接、终端会话、数据、崩溃上报依次叠放", () => {
    show("service");
    expect(parts()).toEqual([
      "HostPage",
      "TerminalPage",
      "DataPage",
      "CrashReportGroup",
    ]);
  });

  it("本机服务对成员只剩连接状态", () => {
    access.member = true;
    show("service");
    expect(parts()).toEqual(["HostPage"]);
  });

  it("工作空间带上实时协同", () => {
    show("workspace");
    expect(parts()).toEqual(["WorkspacePage", "RealtimeSetting"]);
  });

  it("远程机器：子页开着时只画推入它的那一段", () => {
    show("machines");
    expect(parts()).toEqual(["SshPage", "ExecutionHostsPage"]);
    cleanup();
    usePreferencesStore.setState({ settingsSubpage: "ssh:box" });
    show("machines");
    expect(parts()).toEqual(["SshPage"]);
    cleanup();
    usePreferencesStore.setState({ settingsSubpage: "executionHosts:a" });
    show("machines");
    expect(parts()).toEqual(["ExecutionHostsPage"]);
  });
});
