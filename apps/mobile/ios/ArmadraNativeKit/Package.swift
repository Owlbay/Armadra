// swift-tools-version: 5.9
import PackageDescription

// 原生壳里不依赖 UIKit / Capacitor 的那一半：钉扎判定、推送信封、深链、钥匙串。
// App 与 Notification Service Extension 共用；单测在 macOS 上 `swift test` 就能跑。
let package = Package(
    name: "ArmadraNativeKit",
    platforms: [.iOS(.v15), .macOS(.v13)],
    products: [
        .library(name: "ArmadraNativeKit", targets: ["ArmadraNativeKit"])
    ],
    targets: [
        .target(name: "ArmadraNativeKit"),
        .testTarget(
            name: "ArmadraNativeKitTests",
            dependencies: ["ArmadraNativeKit"]
        )
    ]
)
