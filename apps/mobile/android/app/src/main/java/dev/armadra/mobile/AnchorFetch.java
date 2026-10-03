package dev.armadra.mobile;

import dev.armadra.mobile.core.Pin;
import dev.armadra.mobile.core.PinPolicy;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * 配对时取信任锚（补全架构 §7）：Gateway 在本地 CA 模式下只发叶证书，CA 要从
 * {@code GET /ca.crt}（匿名路径）取，再按二维码里的指纹核对。
 *
 * <p>两步，都不是「信任一切」：先握一次手只为看清服务端发的叶证书（信任管理器
 * 记下链后照样抛错）；再只信任「刚才那一张叶证书」去取 {@code /ca.crt}。取回的
 * 东西只有指纹对得上、且叶证书确实由它签发（{@link PinPolicy#evaluate}）才会被存。
 */
final class AnchorFetch {
    private static final int TIMEOUT_MS = 10_000;

    private AnchorFetch() {}

    /** 结果：服务端发的链（叶在前）与 /ca.crt 里的证书；连不上是 {@code null}。 */
    static List<X509Certificate> run(String origin) {
        List<X509Certificate> presented = handshake(origin);
        if (presented == null || presented.isEmpty()) return null;
        List<X509Certificate> out = new ArrayList<>(presented);
        out.addAll(caCertificate(origin, presented.get(0)));
        return out;
    }

    /** 判定：结果里有没有指纹对得上的锚，叶证书能不能验到它（不看有效期之外的系统信任）。 */
    static X509Certificate anchorFor(List<X509Certificate> fetched, Pin pin, String host) {
        X509Certificate anchor = PinPolicy.anchor(fetched, pin);
        if (anchor == null) return null;
        try {
            Pin withAnchor = pin.withAnchor(anchor.getEncoded());
            return PinPolicy.evaluate(List.of(fetched.get(0)), withAnchor, host, new java.util.Date()) ? anchor : null;
        } catch (Exception error) {
            return null;
        }
    }

    private static List<X509Certificate> handshake(String origin) {
        final List<X509Certificate> seen = new ArrayList<>();
        X509TrustManager recorder = new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                throw new CertificateException("client certificates are not used");
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                seen.addAll(Arrays.asList(chain));
                throw new CertificateException("recorded");
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        };
        try {
            HttpsURLConnection connection = open(origin + "/ca.crt", factory(recorder));
            connection.setHostnameVerifier((hostname, session) -> false);
            try {
                connection.connect();
            } catch (Exception expected) {
                // 握手按设计失败；链已经记下了。
            } finally {
                connection.disconnect();
            }
        } catch (Exception error) {
            return null;
        }
        return seen;
    }

    private static List<X509Certificate> caCertificate(String origin, X509Certificate leaf) {
        X509TrustManager exactLeaf = new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                throw new CertificateException("client certificates are not used");
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                if (chain == null || chain.length == 0 || !chain[0].equals(leaf)) {
                    throw new CertificateException("not the certificate seen a moment ago");
                }
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        };
        try {
            URL url = new URL(origin + "/ca.crt");
            HttpsURLConnection connection = open(url.toString(), factory(exactLeaf));
            connection.setHostnameVerifier((hostname, session) -> {
                try {
                    return PinPolicy.hostMatches((X509Certificate) session.getPeerCertificates()[0], hostname);
                } catch (Exception error) {
                    return false;
                }
            });
            try (InputStream input = connection.getInputStream()) {
                if (connection.getResponseCode() != 200) return List.of();
                ByteArrayOutputStream body = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int read;
                while ((read = input.read(buffer)) > 0 && body.size() < 64 * 1024) body.write(buffer, 0, read);
                return PinPolicy.certificates(body.toByteArray());
            } finally {
                connection.disconnect();
            }
        } catch (Exception error) {
            return List.of();
        }
    }

    private static HttpsURLConnection open(String url, SSLSocketFactory factory) throws Exception {
        HttpsURLConnection connection = (HttpsURLConnection) new URL(url).openConnection();
        connection.setSSLSocketFactory(factory);
        connection.setConnectTimeout(TIMEOUT_MS);
        connection.setReadTimeout(TIMEOUT_MS);
        connection.setUseCaches(false);
        connection.setInstanceFollowRedirects(false);
        return connection;
    }

    private static SSLSocketFactory factory(X509TrustManager manager) throws Exception {
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[] {manager}, null);
        return context.getSocketFactory();
    }
}
