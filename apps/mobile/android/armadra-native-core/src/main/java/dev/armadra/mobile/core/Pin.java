package dev.armadra.mobile.core;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Locale;

/**
 * 一个 Gateway 的钉扎记录：来源、二维码里的信任锚指纹、以及（取得到时）信任锚的 DER。
 * 与 iOS `ArmadraNativeKit/PinPolicy.swift` 的 {@code Pin} 同义。
 */
public final class Pin {
    public final String origin;
    public final String fingerprint;
    public final byte[] anchor;

    public Pin(String origin, String fingerprint, byte[] anchor) {
        this.origin = origin;
        this.fingerprint = fingerprint;
        this.anchor = anchor;
    }

    public Pin withAnchor(byte[] value) {
        return new Pin(origin, fingerprint, value);
    }

    /** 这次握手是不是发往被钉的来源（主机与端口都要对上，端口缺省 443）。 */
    public boolean covers(String host, int port) {
        try {
            URI uri = new URI(origin);
            int pinnedPort = uri.getPort() < 0 ? 443 : uri.getPort();
            int askedPort = port < 0 ? 443 : port;
            return uri.getHost() != null
                    && uri.getHost().toLowerCase(Locale.ROOT).equals(host.toLowerCase(Locale.ROOT))
                    && pinnedPort == askedPort;
        } catch (Exception error) {
            return false;
        }
    }

    /** 存进加密偏好的那一行：三段，换行分隔，信任锚是 base64。 */
    public String encode() {
        String anchorText = anchor == null ? "" : Base64.getEncoder().encodeToString(anchor);
        return origin + "\n" + fingerprint + "\n" + anchorText;
    }

    public static Pin decode(String text) {
        if (text == null) return null;
        String[] parts = text.split("\n", -1);
        if (parts.length != 3 || !PinPolicy.isOrigin(parts[0]) || !PinPolicy.isFingerprint(parts[1])) {
            return null;
        }
        byte[] anchor = parts[2].isEmpty() ? null : Base64.getDecoder().decode(parts[2].getBytes(StandardCharsets.US_ASCII));
        return new Pin(parts[0], parts[1], anchor);
    }
}
