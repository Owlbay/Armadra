package dev.armadra.mobile.core;

import java.util.regex.Pattern;

/**
 * 多连接钥匙串里各条记录的形状校验（与 iOS {@code ConnectionVault.swift} 同义）。页面传来的东西不信，
 * Keystore 里只落合格的：会话按 {@code sourceId} + {@code via} 一条（键 {@link #sessionKey}），远程服务按
 * {@code serviceId} 一条（键 {@link #remoteKey}），钉扎按来源一条（键 {@link #pinKey}）。
 */
public final class ConnectionRules {
    public static final String SESSION_PREFIX = "session.";
    public static final String REMOTE_PREFIX = "remote.";
    public static final String PIN_PREFIX = "pin.";

    /** 会话密钥：{@code <32 位十六进制标识>.<43 位 base64url>}（core {@code identity/tokens.ts}）。 */
    private static final Pattern SECRET = Pattern.compile("^[0-9a-f]{32}\\.[A-Za-z0-9_-]{43}$");
    private static final Pattern NAME = Pattern.compile("^[A-Za-z0-9._:-]{1,128}$");
    private static final int MAX_REMOTE_TOKEN = 4096;

    private ConnectionRules() {}

    public static boolean isSecret(String text) {
        return text != null && SECRET.matcher(text).matches();
    }

    public static boolean isName(String text) {
        return text != null && NAME.matcher(text).matches();
    }

    public static boolean isVia(String text) {
        return "direct".equals(text) || "relayed".equals(text);
    }

    /** 会话记录是否合格（{@code expiresAtMs} 不知道是 0）。 */
    public static boolean validSession(String sourceId, String origin, String via, String access, String refresh,
            double expiresAtMs) {
        return isName(sourceId) && isVia(via) && PinPolicy.isIssuer(origin) && isSecret(access) && isSecret(refresh)
                && expiresAtMs >= 0 && !Double.isNaN(expiresAtMs) && !Double.isInfinite(expiresAtMs);
    }

    public static boolean validRemote(String serviceId, String issuer, String kind, String refreshToken,
            String fingerprint) {
        return isName(serviceId)
                && PinPolicy.isIssuer(issuer)
                && ("personal".equals(kind) || "saas".equals(kind))
                && refreshToken != null && !refreshToken.isEmpty() && refreshToken.length() <= MAX_REMOTE_TOKEN
                && fingerprint != null && (fingerprint.isEmpty() || PinPolicy.isFingerprint(fingerprint));
    }

    public static String sessionKey(String sourceId, String via) {
        return SESSION_PREFIX + sourceId + "." + via;
    }

    public static String remoteKey(String serviceId) {
        return REMOTE_PREFIX + serviceId;
    }

    /** 钉扎的键；来源认不出是 {@code null}。 */
    public static String pinKey(String origin) {
        String key = Pin.originKey(origin);
        return key == null ? null : PIN_PREFIX + key;
    }
}
