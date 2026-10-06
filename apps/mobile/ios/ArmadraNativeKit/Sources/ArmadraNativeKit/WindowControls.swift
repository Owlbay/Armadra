import CoreGraphics
import Foundation

/// iPadOS 窗口化（台前调度 / 窗口应用）时左上角那组窗口控件占掉的区域，以及把它交给
/// 页面的那一行 JS（设计系统 §3.1）。
///
/// 这块不在 `safe-area-inset-*` 里：系统只在 `UIView.LayoutRegion` 的「角落适配」里给出
/// （iOS 26 起，`edgeInsets(for: .safeArea(cornerAdaptation:))`）。横向适配多出来的左边距
/// = 控件右沿到窗口左缘的距离，纵向适配多出来的上边距 = 控件下沿到窗口上缘的距离；
/// 两者都减掉普通安全区，只剩控件本身。全屏、iPhone、iOS 26 以下都是 0。
///
/// 页面在根元素上读 `--window-controls-left` / `--window-controls-top`，与桌面壳给
/// macOS 红绿灯留的占位是同一个用法：标题栏左边的钮往右让。
public struct WindowControls: Equatable {
    public let left: CGFloat
    public let top: CGFloat

    public static let none = WindowControls(left: 0, top: 0)

    public init(left: CGFloat, top: CGFloat) {
        // 半个点以下的差是取整误差，不是控件；负数（适配后反而更小）也按没有算。
        self.left = left >= 0.5 ? left.rounded(.up) : 0
        self.top = top >= 0.5 ? top.rounded(.up) : 0
    }

    /// 普通安全区与两种角落适配的安全区之差。
    public init(safeLeft: CGFloat, safeTop: CGFloat, adaptedLeft: CGFloat, adaptedTop: CGFloat) {
        self.init(left: adaptedLeft - safeLeft, top: adaptedTop - safeTop)
    }

    /// 写进 `document.documentElement` 的内联样式；数值是整数点，不拼任何外来文本。
    public var script: String {
        "(function(s){s.setProperty('--window-controls-left','\(Int(left))px');"
            + "s.setProperty('--window-controls-top','\(Int(top))px');})"
            + "(document.documentElement.style);"
    }
}
