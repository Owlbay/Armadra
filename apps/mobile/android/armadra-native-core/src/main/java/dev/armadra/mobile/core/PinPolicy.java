package dev.armadra.mobile.core;

import java.io.ByteArrayInputStream;
import java.net.InetAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collection;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 证书钉扎的判定（补全架构 §7、§10）：只在「服务端链能验到指纹等于钉住值的那张
 * 信任锚、主机名对得上、都在有效期内」时放行，系统信任库不参与。
 *
 * <p>Android 的 {@code WebViewClient.onReceivedSslError} 只给叶证书，所以本地 CA
 * 模式下信任锚来自配对时按指纹核对过的 {@code /ca.crt}（{@link Pin#anchor}）。
 */
public final class PinPolicy {
    private static final Pattern FINGERPRINT = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern PEM = Pattern.compile(
            "-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\\s]+?)-----END CERTIFICATE-----");
    private static final Pattern IPV4 = Pattern.compile("^\\d{1,3}(\\.\\d{1,3}){3}$");
    private static final String SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
    private static final int MAX_DEPTH = 4;

    private PinPolicy() {}

    /** DER 的 SHA-256，小写十六进制——与 core {@code gateway/tls.ts::fingerprintOf} 同一拼法。 */
    public static String fingerprint(byte[] der) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(der);
            StringBuilder out = new StringBuilder(64);
            for (byte value : digest) out.append(String.format(Locale.ROOT, "%02x", value));
            return out.toString();
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    public static boolean isFingerprint(String text) {
        return text != null && FINGERPRINT.matcher(text).matches();
    }

    /** {@code https://host[:port]}，别的一律不认（钉扎只给 Gateway）。 */
    public static boolean isOrigin(String text) {
        if (text == null) return false;
        try {
            URI uri = new URI(text);
            String path = uri.getRawPath();
            return "https".equals(uri.getScheme())
                    && uri.getHost() != null && !uri.getHost().isEmpty()
                    && (path == null || path.isEmpty() || path.equals("/"))
                    && uri.getRawQuery() == null && uri.getRawFragment() == null
                    && uri.getRawUserInfo() == null;
        } catch (Exception error) {
            return false;
        }
    }

    /** 远程服务的签发方：HTTPS 来源；回环上的 HTTP 只给本机开发联调。 */
    public static boolean isIssuer(String text) {
        if (isOrigin(text)) return true;
        if (text == null) return false;
        try {
            URI uri = new URI(text);
            String host = uri.getHost();
            String path = uri.getRawPath();
            return "http".equals(uri.getScheme())
                    && host != null
                    && (host.equals("127.0.0.1") || host.equals("localhost") || host.equals("[::1]"))
                    && (path == null || path.isEmpty() || path.equals("/"))
                    && uri.getRawQuery() == null && uri.getRawFragment() == null
                    && uri.getRawUserInfo() == null;
        } catch (Exception error) {
            return false;
        }
    }

    /** PEM（可多张）或单张 DER → 证书。认不出的跳过。 */
    public static List<X509Certificate> certificates(byte[] data) {
        List<X509Certificate> out = new ArrayList<>();
        try {
            CertificateFactory factory = CertificateFactory.getInstance("X.509");
            String text = new String(data, StandardCharsets.UTF_8);
            if (text.contains("-----BEGIN CERTIFICATE-----")) {
                Matcher matcher = PEM.matcher(text);
                while (matcher.find()) {
                    byte[] der = Base64.getMimeDecoder().decode(matcher.group(1));
                    out.add((X509Certificate) factory.generateCertificate(new ByteArrayInputStream(der)));
                }
            } else if (data.length > 0) {
                out.add((X509Certificate) factory.generateCertificate(new ByteArrayInputStream(data)));
            }
        } catch (Exception ignored) {
            // 不是证书：交给调用方按「没有」处理。
        }
        return out;
    }

    /** 握手链与已存的信任锚里，指纹等于钉住值的那一张。 */
    public static X509Certificate anchor(List<X509Certificate> presented, Pin pin) {
        List<X509Certificate> candidates = new ArrayList<>(presented);
        if (pin.anchor != null) candidates.addAll(certificates(pin.anchor));
        for (X509Certificate candidate : candidates) {
            try {
                if (fingerprint(candidate.getEncoded()).equals(pin.fingerprint)) return candidate;
            } catch (Exception ignored) {
                // 编码不出来的证书不可能是锚。
            }
        }
        return null;
    }

    /**
     * 判定。{@code presented} 叶在前（Android WebView 只给叶，这时信任锚必须来自
     * {@link Pin#anchor}）；{@code now} 是验证时刻。
     */
    public static boolean evaluate(List<X509Certificate> presented, Pin pin, String host, Date now) {
        if (presented == null || presented.isEmpty() || pin == null || !isFingerprint(pin.fingerprint)) {
            return false;
        }
        X509Certificate anchor = anchor(presented, pin);
        if (anchor == null) return false;
        X509Certificate leaf = presented.get(0);
        try {
            if (!hostMatches(leaf, host) || !serverAuth(leaf)) return false;
            leaf.checkValidity(now);
            if (Arrays.equals(leaf.getEncoded(), anchor.getEncoded())) return true;
            anchor.checkValidity(now);
            X509Certificate current = leaf;
            for (int depth = 0; depth < MAX_DEPTH; depth++) {
                if (signedBy(current, anchor)) return true;
                X509Certificate next = issuerOf(current, presented);
                if (next == null || next.getBasicConstraints() < 0) return false;
                next.checkValidity(now);
                current = next;
            }
        } catch (Exception error) {
            return false;
        }
        return false;
    }

    private static boolean signedBy(X509Certificate child, X509Certificate issuer) {
        if (!child.getIssuerX500Principal().equals(issuer.getSubjectX500Principal())) return false;
        if (issuer.getBasicConstraints() < 0) return false;
        try {
            child.verify(issuer.getPublicKey());
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    private static X509Certificate issuerOf(X509Certificate child, List<X509Certificate> presented) {
        for (X509Certificate candidate : presented) {
            if (candidate != child && signedBy(child, candidate)) return candidate;
        }
        return null;
    }

    private static boolean serverAuth(X509Certificate leaf) throws Exception {
        List<String> usages = leaf.getExtendedKeyUsage();
        return usages == null || usages.contains(SERVER_AUTH);
    }

    /** 叶证书的 SAN 是否覆盖这个主机：IP 逐字（规范化后）比较，DNS 名不分大小写、通配符只吃一段。 */
    public static boolean hostMatches(X509Certificate leaf, String host) {
        if (host == null || host.isEmpty()) return false;
        String asked = host.startsWith("[") && host.endsWith("]") ? host.substring(1, host.length() - 1) : host;
        asked = asked.toLowerCase(Locale.ROOT);
        if (asked.endsWith(".")) asked = asked.substring(0, asked.length() - 1);
        boolean literal = IPV4.matcher(asked).matches() || asked.contains(":");
        try {
            Collection<List<?>> names = leaf.getSubjectAlternativeNames();
            if (names == null) return false;
            for (List<?> entry : names) {
                if (entry.size() < 2 || !(entry.get(1) instanceof String)) continue;
                int type = (Integer) entry.get(0);
                String name = ((String) entry.get(1)).toLowerCase(Locale.ROOT);
                if (literal && type == 7 && sameAddress(name, asked)) return true;
                if (!literal && type == 2 && dnsMatches(name, asked)) return true;
            }
        } catch (Exception error) {
            return false;
        }
        return false;
    }

    private static boolean sameAddress(String a, String b) {
        try {
            // 只对字面量调用：不会触发 DNS 查询。
            return Arrays.equals(InetAddress.getByName(a).getAddress(), InetAddress.getByName(b).getAddress());
        } catch (Exception error) {
            return false;
        }
    }

    private static boolean dnsMatches(String pattern, String host) {
        if (pattern.endsWith(".")) pattern = pattern.substring(0, pattern.length() - 1);
        if (!pattern.startsWith("*.")) return pattern.equals(host);
        String suffix = pattern.substring(1);
        if (!host.endsWith(suffix)) return false;
        String label = host.substring(0, host.length() - suffix.length());
        return !label.isEmpty() && !label.contains(".");
    }
}
