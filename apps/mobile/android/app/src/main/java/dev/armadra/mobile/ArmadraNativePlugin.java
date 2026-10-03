package dev.armadra.mobile;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.messaging.FirebaseMessaging;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;
import dev.armadra.mobile.core.DeepLink;
import dev.armadra.mobile.core.Pin;
import dev.armadra.mobile.core.PinPolicy;
import dev.armadra.mobile.core.PushEnvelope;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * 原生插件 {@code ArmadraNative}：页面一半在 {@code apps/web/src/mobile/native-bridge.ts}，
 * 约定写在那个文件头里；与 iOS {@code ArmadraNativePlugin.swift} 一一对应。
 *
 * <ul>
 *   <li>{@code getSession / setSession / clearSession}：Keystore 加密的一份会话；
 *   <li>{@code pin}：取 {@code /ca.crt} 按指纹核对后存为信任锚，之后由
 *       {@link PinningWebViewClient} 只认它；失败必须 reject；
 *   <li>{@code scan}：Google 代码扫描器（Play 服务提供界面，不要相机权限）；
 *   <li>{@code pushRegistration}：FCM 令牌 + 设备 X25519 公钥；配了中继时先换中继令牌。
 * </ul>
 *
 * 深链（{@code armadra://…}，含点通知）改写页面的地址片段（{@link DeepLink#script()}）。
 */
@CapacitorPlugin(
        name = "ArmadraNative",
        permissions = {@Permission(alias = "notifications", strings = {Manifest.permission.POST_NOTIFICATIONS})})
public class ArmadraNativePlugin extends Plugin {
    private static final Pattern SECRET = Pattern.compile("^[A-Za-z0-9_-]{43}$");

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private SecureStore store;
    private volatile Pin pin;
    private boolean pageLoaded = false;
    private String pendingScript;

    @Override
    public void load() {
        store = new SecureStore(getContext());
        pin = Pin.decode(store.read(SecureStore.PIN));
        getBridge().setWebViewClient(new PinningWebViewClient(getBridge(), () -> pin));
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageStarted(WebView webView) {
                pageLoaded = false;
            }

            @Override
            public void onPageLoaded(WebView webView) {
                pageLoaded = true;
                if (pendingScript != null) {
                    String script = pendingScript;
                    pendingScript = null;
                    webView.evaluateJavascript(script, null);
                }
            }
        });
    }

    // ---------------------------------------------------------------- 会话

    @PluginMethod
    public void getSession(PluginCall call) {
        String stored = store.read(SecureStore.SESSION);
        JSObject result = new JSObject();
        if (stored != null) {
            try {
                result.put("session", new JSObject(stored));
            } catch (Exception ignored) {
                store.delete(SecureStore.SESSION);
            }
        }
        call.resolve(result);
    }

    @PluginMethod
    public void setSession(PluginCall call) {
        JSObject session = call.getObject("session");
        String origin = session == null ? null : session.getString("origin");
        String access = session == null ? null : session.getString("accessToken");
        String refresh = session == null ? null : session.getString("refreshToken");
        if (!PinPolicy.isOrigin(origin) || !isSecret(access) || !isSecret(refresh)) {
            call.reject("invalid session");
            return;
        }
        JSObject value = new JSObject();
        value.put("origin", origin);
        value.put("accessToken", access);
        value.put("refreshToken", refresh);
        if (store.write(SecureStore.SESSION, value.toString())) call.resolve();
        else call.reject("keystore unavailable");
    }

    @PluginMethod
    public void clearSession(PluginCall call) {
        store.delete(SecureStore.SESSION);
        call.resolve();
    }

    private static boolean isSecret(String text) {
        return text != null && SECRET.matcher(text).matches();
    }

    // ------------------------------------------------------------ 证书钉扎

    /**
     * 失败必须 reject：参数不像样、取到了信任锚但指纹对不上（或叶证书验不到它）、写不进。
     * 连不上不算失败——只存指纹；之后握手时链里自带信任锚的仍能判。
     */
    @PluginMethod
    public void pin(PluginCall call) {
        String origin = call.getString("origin");
        String fingerprint = call.getString("fingerprint");
        if (!PinPolicy.isOrigin(origin) || !PinPolicy.isFingerprint(fingerprint)) {
            call.reject("bad pin");
            return;
        }
        worker.execute(() -> {
            Pin next = new Pin(origin, fingerprint, null);
            List<X509Certificate> fetched = AnchorFetch.run(origin);
            if (fetched != null) {
                X509Certificate anchor = AnchorFetch.anchorFor(fetched, next, Uri.parse(origin).getHost());
                if (anchor == null) {
                    call.reject("fingerprint mismatch");
                    return;
                }
                try {
                    next = next.withAnchor(anchor.getEncoded());
                } catch (Exception error) {
                    call.reject("fingerprint mismatch");
                    return;
                }
            }
            if (!store.write(SecureStore.PIN, next.encode())) {
                call.reject("keystore unavailable");
                return;
            }
            pin = next;
            call.resolve();
        });
    }

    // ---------------------------------------------------------------- 扫码

    @PluginMethod
    public void scan(PluginCall call) {
        GmsBarcodeScannerOptions options =
                new GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build();
        GmsBarcodeScanning.getClient(getActivity(), options)
                .startScan()
                .addOnSuccessListener(barcode -> {
                    JSObject result = new JSObject();
                    String text = barcode.getRawValue();
                    if (text != null && !text.isEmpty()) result.put("text", text);
                    call.resolve(result);
                })
                .addOnCanceledListener(() -> call.resolve(new JSObject()))
                .addOnFailureListener(error -> call.resolve(new JSObject()));
    }

    // ---------------------------------------------------------------- 推送

    @PluginMethod
    public void pushRegistration(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationsPermission");
            return;
        }
        register(call);
    }

    @PermissionCallback
    private void notificationsPermission(PluginCall call) {
        if (getPermissionState("notifications") == PermissionState.GRANTED) register(call);
        else call.reject("denied");
    }

    private void register(PluginCall call) {
        Notifications.ensureChannel(getContext());
        FirebaseMessaging messaging;
        try {
            messaging = FirebaseMessaging.getInstance();
        } catch (IllegalStateException notConfigured) {
            // 没有 google-services.json 的构建（CI 的 debug 包）：Firebase 没初始化。
            call.reject("push unavailable");
            return;
        }
        messaging.getToken().addOnCompleteListener(task -> {
            if (!task.isSuccessful() || task.getResult() == null) {
                call.reject("registration failed");
                return;
            }
            String token = task.getResult();
            worker.execute(() -> finishRegistration(call, token));
        });
    }

    private void finishRegistration(PluginCall call, String token) {
        byte[] key = store.readBytes(SecureStore.DEVICE_KEY);
        if (key == null || key.length != 32) {
            key = PushEnvelope.generatePrivateKey(new SecureRandom());
            if (!store.writeBytes(SecureStore.DEVICE_KEY, key)) {
                call.reject("keystore unavailable");
                return;
            }
        }
        String publicKey = PushEnvelope.publicKey(key);
        String relay = getConfig().getString("relayUrl", "").trim();
        String transport = "direct";
        if (!relay.isEmpty()) {
            token = relayToken(relay, token);
            transport = "relay";
            if (token == null) {
                call.reject("relay registration failed");
                return;
            }
        }
        JSObject registration = new JSObject();
        registration.put("platform", "android");
        registration.put("transport", transport);
        registration.put("token", token);
        registration.put("publicKey", publicKey);
        JSObject result = new JSObject();
        result.put("registration", registration);
        call.resolve(result);
    }

    /** 商店版：FCM 令牌换中继令牌（{@code apps/push-relay} 的 {@code /v1/register}），走系统信任库。 */
    private static String relayToken(String relay, String token) {
        try {
            URL url = new URL(relay.replaceAll("/+$", "") + "/v1/register");
            if (!"https".equals(url.getProtocol())) return null;
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(15_000);
            connection.setDoOutput(true);
            connection.setRequestProperty("content-type", "application/json");
            JSONObject body = new JSONObject().put("platform", "android").put("token", token);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            if (connection.getResponseCode() != 200) return null;
            try (InputStream input = connection.getInputStream()) {
                String text = new String(input.readAllBytes(), StandardCharsets.UTF_8);
                String relayToken = new JSONObject(text).optString("relayToken", "");
                return relayToken.isEmpty() ? null : relayToken;
            }
        } catch (Exception error) {
            return null;
        }
    }

    // ---------------------------------------------------------------- 深链

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        Uri data = intent == null ? null : intent.getData();
        if (data == null) return;
        DeepLink link = DeepLink.parse(data.toString());
        if (link == null) return;
        deliver(link.script());
    }

    /** 页面还在加载（冷启动）时先记着，加载完再执行。 */
    private void deliver(String script) {
        getBridge().executeOnMainThread(() -> {
            WebView webView = getBridge().getWebView();
            if (webView == null || !pageLoaded) {
                pendingScript = script;
                return;
            }
            webView.evaluateJavascript(script, null);
        });
    }
}
