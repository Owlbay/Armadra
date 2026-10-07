import Capacitor
import UIKit

/// 窗口由 `Main.storyboard`（`ArmadraBridgeViewController`）建，这里只把场景事件
/// 交给 Capacitor：深链（`armadra://…`）经它发成 `.capacitorOpenURL`，冷启动时的
/// 那一条在插件装好之后才补发。
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
