import { useEffect, useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { ReactFlowProvider } from "@xyflow/react";
import { useAgentStatusHydration } from "../agent/hydration";
import { useWorkspaceEvents } from "../api/events";
import { FlowWorkspace } from "../canvas/FlowWorkspace";
// 浮层都在 `./lazy` 里 `React.lazy` 包过，走各自的 chunk（§17 代码分割）；
// `./Overlays` 是它们的挂载点，也是决定 chunk 什么时候才被取回来的闸门。
import { Overlays } from "./Overlays";
import { IdentityGate } from "./IdentityGate";
import { useMinimapPreferences } from "./minimap-preferences";
import { Banners } from "../shell/Banners";
import { ControlsCluster } from "../shell/ControlsCluster";
import { EmptyCanvas } from "../canvas/EmptyCanvas";
import { Dock } from "../shell/Dock";
import { LeftSidebar } from "../shell/LeftSidebar";
import { MobileBottomNav } from "../shell/MobileBottomNav";
import { MobileFocusPage } from "../shell/MobileFocusPage";
import { WindowDragLayer } from "../shell/WindowDragLayer";
import { useCanvasStore } from "../store/canvas-store";
import { useWorkspaceSource } from "../sources/workspace-source";
import { onIdentitySessionChange } from "../api/identity";
import { Toaster } from "@/ui/sonner";
import { useCompactLayout } from "@/platform/layout";
import { TooltipProvider } from "@/ui/tooltip";
import { useCommandDispatch } from "./commands";
import { useAgentNotifications } from "./notifications";
import { syncDocumentPreferences } from "./preferences-store";
import { useAppKeybindings } from "./use-app-keybindings";
import { useBoardSync } from "./use-board-sync";
import { useWorkspaceAccessLost } from "./use-access-lost";
import { useControlNotices } from "./use-control-notices";
import { useUsagePolicyNotice } from "./use-usage-policy-notice";
import { useSourceSwitchCacheReset } from "./use-sources-bootstrap";
import { useCanvasPreferences } from "./use-canvas-preferences";

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, staleTime: 5_000 },
    },
  });
}

/**
 * `<ReactFlowProvider>` 包住整棵树（React Flow 计划 §2.9）。
 *
 * Dock 的缩放档位用 `useViewport()`，命令面板与侧栏用 `flow-context` 的
 * 树外句柄；provider 在最外层，两条路才都走得通。它自己不渲染任何东西，
 * 也不要求下面真的有一个 `<ReactFlow>`——没有工作空间时画布不挂载，
 * `useViewport()` 读到的就是 `{0,0,1}`。
 */
export function App() {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <ReactFlowProvider>
        <TooltipProvider delayDuration={500}>
          <IdentityGate>
            <AppShell />
          </IdentityGate>
        </TooltipProvider>
      </ReactFlowProvider>
    </QueryClientProvider>
  );
}

/**
 * 壳的渲染顺序（§22 改版后，§27 删掉首页）：侧栏 + 画布占满窗口，
 * 其余全是浮层。
 *
 * 启动就是这一个壳，不再有启动页：还没有工作空间时侧栏照常在（顶行下拉里
 * 打开 / 新建 / 克隆都能用），只是画布那一半空着——画布与它的浮层都要一块
 * 画布才有意义，所以它们跟着工作空间一起出现，空屏上不写任何提示文案（§14）。
 */
function AppShell() {
  const workspace = useCanvasStore((state) => state.workspace);
  const minimapCollapsed = useMinimapPreferences((state) => state.collapsed);
  const compact = useCompactLayout();

  const queryClient = useQueryClient();
  // Every /api call made before this device paired was refused. Once the Host
  // session appears, re-read rather than leaving the shell showing the
  // failures from before the user signed in.
  useEffect(
    () => onIdentitySessionChange(() => void queryClient.invalidateQueries()),
    [queryClient],
  );

  useEffect(syncDocumentPreferences, []);
  useCanvasPreferences();
  const workspaceSource = useWorkspaceSource();
  useWorkspaceEvents(workspace?.id ?? null, workspaceSource);
  useWorkspaceAccessLost();
  useControlNotices();
  useUsagePolicyNotice();
  useSourceSwitchCacheReset();
  // 节点徽标属于画布，不属于侧栏：镜像在这里补齐，与面板开合无关。
  useAgentStatusHydration(workspace?.id ?? null);
  useAgentNotifications();
  useBoardSync();
  const dispatch = useCommandDispatch();
  useAppKeybindings(dispatch);

  return (
    // 根容器让开顶、左、右三边的安全区（`--safe-*`，设计系统 §3.1）：侧栏、画布
    // 和画布里贴边的浮层（工具簇、通知条、Dock、缩略图）跟着整体内缩，状态栏下
    // 只剩这块底色。底边不在这里让：手机布局的底部导航自己垫主页横条，画布底部
    // 的浮层各自加 `--safe-bottom`，否则那一截会算两遍。
    <div className="flex h-full overflow-hidden bg-background pt-[var(--safe-top)] pr-[var(--safe-right)] pl-[var(--safe-left)]">
      {/* 必须是整棵树的第一个子节点。原生层算可拖拽区域时按 DOM 顺序把
          `drag` 矩形并进去、`no-drag` 矩形减出来，后出现的覆盖先出现的——
          它排在侧栏后面时，侧栏标题栏里那几颗 `no-drag` 的按钮先减掉、再被
          这一整条加回来，点上去就是拖窗口。z 轴与此无关，那只管页面自己的
          命中。 */}
      <WindowDragLayer />
      <LeftSidebar />
      <main
        className="workspace-surface relative min-w-0 flex-1"
        data-minimap-collapsed={minimapCollapsed}
      >
        {workspace && <FlowWorkspace />}
        {workspace && (
          <>
            <EmptyCanvas />
            <ControlsCluster />
            <Dock />
          </>
        )}
        {/* 通知条坐在画布面的顶部标题带里，与工具簇同一层（`shell/Banners`）。 */}
        <Banners />
      </main>
      {/* 手机布局的两块：底部导航与单节点焦点页。两者都在 <768px 才渲染，
          桌面上是 null，不占位也不订阅任何东西（客户端平台设计）。 */}
      <MobileBottomNav />
      <MobileFocusPage />
      <Overlays />
      {/* 手机上提示从顶部出：底部是焦点页的输入框与按键条，sonner 落在那里
          会短暂盖住正在打字的地方（G2-10 遗留）。顶部让出状态栏安全区。 */}
      <Toaster
        position={compact ? "top-center" : "bottom-right"}
        offset={{
          bottom: "calc(24px + var(--safe-bottom))",
          right: "calc(24px + var(--safe-right))",
        }}
        mobileOffset={{
          top: "calc(var(--safe-top) + 8px)",
          right: "calc(16px + var(--safe-right))",
          left: "calc(16px + var(--safe-left))",
        }}
      />
    </div>
  );
}
