import Foundation

/// `apps/mobile/fixtures/`：Android 的单测读同一份。证书由 openssl 按 Gateway 本地
/// CA 的轮廓签（P-256、serverAuth、SAN 含 127.0.0.1），有效期 2026-10-01 起；推送
/// 信封由 core `push/crypto.ts::sealPayload` 封（`apps/mobile/src/fixtures.test.ts` 守着）。
enum Fixtures {
    static let directory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // ArmadraNativeKitTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // ArmadraNativeKit
        .deletingLastPathComponent() // ios
        .deletingLastPathComponent() // mobile
        .appendingPathComponent("fixtures")

    static func data(_ name: String) throws -> Data {
        try Data(contentsOf: directory.appendingPathComponent(name))
    }

    /// 2027-01-01：证书全都在有效期内。
    static let validDate = Date(timeIntervalSince1970: 1_798_761_600)
}
