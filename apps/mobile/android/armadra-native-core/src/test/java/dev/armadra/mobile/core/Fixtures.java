package dev.armadra.mobile.core;

import java.io.File;
import java.nio.file.Files;
import java.security.cert.X509Certificate;
import java.util.Date;

/** {@code apps/mobile/fixtures/}：与 iOS 的 XCTest 共用（说明见 {@code apps/mobile/src/fixtures.test.ts}）。 */
final class Fixtures {
    private Fixtures() {}

    static File directory() {
        String configured = System.getProperty("armadra.fixtures");
        return new File(configured != null ? configured : "../../fixtures");
    }

    static byte[] bytes(String name) throws Exception {
        return Files.readAllBytes(new File(directory(), name).toPath());
    }

    static String text(String name) throws Exception {
        return new String(bytes(name), java.nio.charset.StandardCharsets.UTF_8);
    }

    static X509Certificate certificate(String name) throws Exception {
        return PinPolicy.certificates(bytes(name)).get(0);
    }

    /** 2027-01-01：证书全都在有效期内。 */
    static final Date VALID = new Date(1_798_761_600_000L);
}
