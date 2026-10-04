package dev.armadra.mobile.core;

import java.net.URI;
import java.util.Locale;

/**
 * 原生那一侧对「交出去的地址」的两道判定（与页面 {@code native-bridge.ts}、iOS {@code ExternalUrl.swift} 同义）：
 *
 * <ul>
 *   <li>{@link #browsable}：{@code openExternal} 交给系统浏览器的地址（原生 OAuth 的授权页，R-56）——https，
 *       或回环上的 http（开发与 dev-stack）；不带用户名口令。
 *   <li>{@link #unifiedPushEndpoint}：UnifiedPush 分发器给的端点（契约 §27.2）——https，回环 http 只给测试；
 *       不带用户名口令与片段。
 * </ul>
 */
public final class ExternalUrl {
    private static final int MAX_LENGTH = 4096;

    private ExternalUrl() {}

    public static boolean browsable(String value) {
        URI uri = parse(value);
        return uri != null && uri.getRawUserInfo() == null && (https(uri) || loopbackHttp(uri));
    }

    public static boolean unifiedPushEndpoint(String value) {
        URI uri = parse(value);
        return uri != null
                && uri.getRawUserInfo() == null
                && uri.getRawFragment() == null
                && (https(uri) || loopbackHttp(uri));
    }

    private static URI parse(String value) {
        if (value == null || value.isEmpty() || value.length() > MAX_LENGTH) return null;
        try {
            URI uri = new URI(value);
            return uri.getHost() == null ? null : uri;
        } catch (Exception malformed) {
            return null;
        }
    }

    private static boolean https(URI uri) {
        return "https".equals(scheme(uri));
    }

    private static boolean loopbackHttp(URI uri) {
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        return "http".equals(scheme(uri))
                && (host.equals("127.0.0.1") || host.equals("localhost") || host.equals("[::1]"));
    }

    private static String scheme(URI uri) {
        return uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
    }
}
