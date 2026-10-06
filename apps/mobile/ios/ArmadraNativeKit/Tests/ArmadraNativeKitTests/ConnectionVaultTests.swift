import ArmadraNativeKit
import XCTest

final class ConnectionVaultTests: XCTestCase {
    private let a = String(repeating: "0", count: 32) + "." + String(repeating: "a", count: 43)
    private let b = String(repeating: "1", count: 32) + "." + String(repeating: "b", count: 43)
    private let fp = String(repeating: "e", count: 64)

    private func session(_ id: String, via: String = "direct", origin: String = "https://192.168.1.8:8443") -> SessionRecord {
        SessionRecord(sourceId: id, origin: origin, via: via, accessToken: a, refreshToken: b, expiresAtMs: 1000)
    }

    func testKeepsOneSessionPerSourceAndRoute() {
        let vault = ConnectionVault(store: MemoryStore())
        XCTAssertTrue(vault.setSession(session("h1")))
        XCTAssertTrue(vault.setSession(session("h1", via: "relayed", origin: "https://relay.example.com")))
        XCTAssertTrue(vault.setSession(session("h2")))
        XCTAssertEqual(vault.sessions().count, 3)
        // 同键覆盖，不新增。
        XCTAssertTrue(vault.setSession(session("h1")))
        XCTAssertEqual(vault.sessions().count, 3)
    }

    func testRemovingOneSourceLeavesTheOthers() {
        let vault = ConnectionVault(store: MemoryStore())
        vault.setSession(session("h1"))
        vault.setSession(session("h1", via: "relayed", origin: "https://relay.example.com"))
        vault.setSession(session("h2"))
        vault.removeSession(sourceId: "h1", origin: "https://relay.example.com")
        XCTAssertEqual(vault.sessions().map { "\($0.sourceId)/\($0.via)" }.sorted(), ["h1/direct", "h2/direct"])
        vault.removeSession(sourceId: "h1")
        XCTAssertEqual(vault.sessions().map(\.sourceId), ["h2"])
    }

    func testRejectsMalformedSessions() {
        let vault = ConnectionVault(store: MemoryStore())
        XCTAssertFalse(vault.setSession(SessionRecord(sourceId: "bad id", origin: "https://h:1", via: "direct", accessToken: a, refreshToken: b, expiresAtMs: 0)))
        XCTAssertFalse(vault.setSession(SessionRecord(sourceId: "h", origin: "https://h:1", via: "satellite", accessToken: a, refreshToken: b, expiresAtMs: 0)))
        XCTAssertFalse(vault.setSession(SessionRecord(sourceId: "h", origin: "https://h:1/path", via: "direct", accessToken: a, refreshToken: b, expiresAtMs: 0)))
        XCTAssertFalse(vault.setSession(SessionRecord(sourceId: "h", origin: "http://relay.example.com", via: "relayed", accessToken: a, refreshToken: b, expiresAtMs: 0)))
        XCTAssertFalse(vault.setSession(SessionRecord(sourceId: "h", origin: "https://h:1", via: "direct", accessToken: "short", refreshToken: b, expiresAtMs: 0)))
        XCTAssertFalse(vault.setSession(SessionRecord(sourceId: "h", origin: "https://h:1", via: "direct", accessToken: a, refreshToken: b, expiresAtMs: -1)))
        XCTAssertTrue(vault.sessions().isEmpty)
        // 回环上的 http 签发方（本机联调）放行。
        XCTAssertTrue(vault.setSession(session("h", via: "relayed", origin: "http://127.0.0.1:8787")))
    }

    func testSessionsReadBackOnlyWhenTheKeyMatchesTheContent() {
        let store = MemoryStore()
        let vault = ConnectionVault(store: store)
        vault.setSession(session("h1"))
        // 把别人的内容塞进这个键：读回来要丢掉，不能张冠李戴。
        store.write("session.h9.direct", store.read("session.h1.direct")!)
        XCTAssertEqual(vault.sessions().map(\.sourceId), ["h1"])
    }

    func testRemotesAreKeyedByServiceAndValidated() {
        let vault = ConnectionVault(store: MemoryStore())
        let one = RemoteRecord(serviceId: "personal:relay.example.com", issuer: "https://relay.example.com", kind: "personal", refreshToken: "r-1", fingerprint: fp)
        XCTAssertTrue(vault.setRemote(one))
        XCTAssertTrue(vault.setRemote(RemoteRecord(serviceId: "personal:relay.example.com", issuer: "https://relay.example.com", kind: "personal", refreshToken: "r-2", fingerprint: "")))
        XCTAssertEqual(vault.remotes().map(\.refreshToken), ["r-2"])
        XCTAssertFalse(vault.setRemote(RemoteRecord(serviceId: "x", issuer: "https://h:1", kind: "other", refreshToken: "r", fingerprint: "")))
        XCTAssertFalse(vault.setRemote(RemoteRecord(serviceId: "x", issuer: "https://h:1", kind: "personal", refreshToken: "", fingerprint: "")))
        XCTAssertFalse(vault.setRemote(RemoteRecord(serviceId: "x", issuer: "https://h:1", kind: "personal", refreshToken: "r", fingerprint: "XYZ")))
        vault.removeRemote(serviceId: "personal:relay.example.com")
        XCTAssertTrue(vault.remotes().isEmpty)
    }

    func testPinsAreKeptPerOrigin() {
        let vault = ConnectionVault(store: MemoryStore())
        XCTAssertTrue(vault.setPin(Pin(origin: "https://192.168.1.8:8443", fingerprint: fp)))
        XCTAssertTrue(vault.setPin(Pin(origin: "https://relay.example.com", fingerprint: String(repeating: "c", count: 64))))
        // 同一个来源重钉是覆盖（端口缺省 443，大小写不敏感）。
        XCTAssertTrue(vault.setPin(Pin(origin: "https://RELAY.example.com:443", fingerprint: fp)))
        let pins = vault.pins()
        XCTAssertEqual(pins.count, 2)
        XCTAssertEqual(pins.first { $0.covers(host: "relay.example.com", port: 443) }?.fingerprint, fp)
        XCTAssertFalse(vault.setPin(Pin(origin: "http://relay.example.com", fingerprint: fp)))
        XCTAssertFalse(vault.setPin(Pin(origin: "https://h:1", fingerprint: "nothex")))
    }

    func testClearAllDropsEverythingButDeviceKey() {
        let store = MemoryStore()
        let vault = ConnectionVault(store: store)
        vault.setSession(session("h1"))
        vault.setPin(Pin(origin: "https://h:1", fingerprint: fp))
        store.write(DeviceKey.account, Data([1]))
        vault.clearAll()
        XCTAssertTrue(vault.sessions().isEmpty)
        XCTAssertTrue(vault.pins().isEmpty)
        XCTAssertNotNil(store.read(DeviceKey.account))
    }
}
