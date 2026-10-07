package dev.armadra.mobile;

import android.net.Uri;
import android.net.http.SslCertificate;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.SslErrorHandler;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import dev.armadra.mobile.core.Pin;
import dev.armadra.mobile.core.PinPolicy;
import java.io.ByteArrayInputStream;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.Date;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Supplier;

/**
 * 证书钉扎（补全架构 §10）：系统不认 Gateway 的证书时 WebView 问
 * {@link #onReceivedSslError}；只有发往被钉来源、且叶证书能验到指纹等于钉住值的
 * 信任锚（{@link PinPolicy#evaluate}）时才 {@code proceed()}，其余一律 {@code cancel()}——
 * 不自动信任新证书，页面提示重新扫码（§7「证书轮换」）。页面的 fetch 与 WebSocket
 * 握手都经过这里。
 *
 * <p>系统本来就信任的证书（ACME、反向代理的真证书）WebView 不会问，Android 也没有
 * 别的钩子：那条链由系统校验，指纹不再参与。
 */
final class PinningWebViewClient extends BridgeWebViewClient {
    private final Supplier<List<Pin>> pins;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    PinningWebViewClient(Bridge bridge, Supplier<List<Pin>> pins) {
        super(bridge);
        this.pins = pins;
    }

    @Override
    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        Uri url = Uri.parse(error.getUrl());
        String host = url.getHost();
        X509Certificate leaf = leafOf(error.getCertificate());
        // 每个来源各钉各的：按主机与端口找发往的那一份。
        Pin pin = null;
        if (host != null) {
            for (Pin candidate : pins.get()) {
                if (candidate.covers(host, url.getPort())) {
                    pin = candidate;
                    break;
                }
            }
        }
        if (pin == null || host == null || leaf == null) {
            Log.w(ArmadraNativePlugin.TAG, "tls: not a pinned origin, refused (" + error.getPrimaryError() + ")");
            handler.cancel();
            return;
        }
        final Pin covering = pin;
        worker.execute(() -> {
            boolean trusted = PinPolicy.evaluate(List.of(leaf), covering, host, new Date());
            Log.i(ArmadraNativePlugin.TAG, "tls: pinned origin " + (trusted ? "trusted" : "refused"));
            main.post(() -> {
                if (trusted) handler.proceed();
                else handler.cancel();
            });
        });
    }

    private static X509Certificate leafOf(SslCertificate certificate) {
        if (certificate == null) return null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return certificate.getX509Certificate();
        try {
            Bundle state = SslCertificate.saveState(certificate);
            byte[] der = state.getByteArray("x509-certificate");
            if (der == null) return null;
            return (X509Certificate) CertificateFactory.getInstance("X.509")
                    .generateCertificate(new ByteArrayInputStream(der));
        } catch (Exception failure) {
            return null;
        }
    }
}
