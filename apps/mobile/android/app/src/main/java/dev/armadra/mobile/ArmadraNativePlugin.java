package dev.armadra.mobile;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
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
import dev.armadra.mobile.core.ExternalUrl;
import dev.armadra.mobile.core.Pin;
import dev.armadra.mobile.core.PinPolicy;
import dev.armadra.mobile.core.PushEnvelope;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;
import kotlin.Unit;
import org.json.JSONObject;
import org.unifiedpush.android.connector.UnifiedPush;

/**
 * 原生插件 {@code ArmadraNative}：页面一半在 {@code apps/web/src/mobile/native-bridge.ts}，
 * 约定写在那个文件头里；与 iOS {@code ArmadraNativePlugin.swift} 一一对应。
 *
 * <ul>
 *   <li>{@code getSession / setSession / clearSession}：Keystore 加密的一份会话；
 *   <li>{@code pin}：取 {@code /ca.crt} 按指纹核对后存为信任锚，之后由
 *       {@link PinningWebViewClient} 只认它；失败必须 reject；
 *   <li>{@code scan}：Google 代码扫描器（Play 服务提供界面，不要相机权限）；
 *   <li>{@code pushRegistration}：装了 UnifiedPush 分发器时向它要端点（契约 §27.2），否则 FCM 令牌 + 设备
 *       X25519 公钥，配了中继时先换中继令牌；
 *   <li>{@code pushRotated / ackPushRotation}：令牌或端点换过的标记（R-54，{@link PushRotation}）；换的那一刻
 *       插件开着就发 {@code pushTokenRotated} 事件；
 *   <li>{@code openExternal}：系统浏览器打开原生 OAuth 的授权页（R-56），只开 https 与回环 http。
 * </ul>
 *
 * 深链（{@code armadra://…}，含点通知与 OAuth 回调）改写页面的地址片段（{@link DeepLink#script()}）。
 */
@CapacitorPlugin(
        name = "ArmadraNative",
        permissions = {@Permission(alias = "notifications", strings = {Manifest.permission.POST_NOTIFICATIONS})})
public class ArmadraNativePlugin extends Plugin {
    static final String TAG = "ArmadraNative";
    /** 会话密钥：{@code <32 位十六进制标识>.<43 位 base64url>}（core {@code identity/tokens.ts}）。 */
    private static final Pattern SECRET = Pattern.compile("^[0-9a-f]{32}\\.[A-Za-z0-9_-]{43}$");
    /** 等 UnifiedPush 分发器给端点的上限；过了退回 FCM。 */
    private static final long UNIFIEDPUSH_TIMEOUT_MS = 30_000;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private SecureStore store;
    private volatile Pin pin;
    private boolean pageLoaded = false;
    private String pendingScript;
    /** 已经交过深链的那个启动 intent。 */
    private static WeakReference<Intent> handledLaunch = new WeakReference<>(null);

    @Override
    public void load() {
        store = new SecureStore(getContext());
        pin = Pin.decode(store.read(SecureStore.PIN));
        getBridge().setWebViewClient(new PinningWebViewClient(getBridge(), () -> pin));
        PushRotation.setListener(() -> notifyListeners("pushTokenRotated", new JSObject()));
        // 冷启动时带来的深链（App 在系统浏览器里走 OAuth 时被系统回收了）：页面加载完再交。同一个
        // intent 只交一次（活动重建时 getIntent() 还是它）；不改 intent 本身——测试框架按它认活动。
        Intent launch = getActivity() == null ? null : getActivity().getIntent();
        DeepLink launchLink = launch == null || launch.getData() == null ? null : DeepLink.parse(launch.getData().toString());
        if (launchLink != null && handledLaunch.get() != launch) {
            handledLaunch = new WeakReference<>(launch);
            pendingScript = launchLink.script();
        }
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
            Log.i(TAG, "pin: fetched " + (fetched == null ? "nothing" : fetched.size() + " certificate(s)"));
            if (fetched != null) {
                X509Certificate anchor = AnchorFetch.anchorFor(fetched, next, Uri.parse(origin).getHost());
                if (anchor == null) {
                    Log.w(TAG, "pin: no fetched certificate matches the pinned fingerprint");
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
        // 用户装了 UnifiedPush 分发器（多半是没有 Google 服务的手机）：走它，不看 FCM。
        if (!UnifiedPush.getDistributors(getContext()).isEmpty()) {
            registerUnifiedPush(call);
            return;
        }
        registerFcm(call);
    }

    private void registerUnifiedPush(PluginCall call) {
        AtomicBoolean settled = new AtomicBoolean(false);
        UnifiedPush.tryUseCurrentOrDefaultDistributor(getActivity(), linked -> {
            if (!linked) {
                if (settled.compareAndSet(false, true)) registerFcm(call);
                return Unit.INSTANCE;
            }
            ArmadraUnifiedPushService.await(endpoint -> {
                if (!settled.compareAndSet(false, true)) return;
                if (endpoint == null) registerFcm(call);
                else worker.execute(() -> finishRegistration(call, null, endpoint));
            });
            getBridge().executeOnMainThread(() -> getBridge().getWebView().postDelayed(() -> {
                if (settled.compareAndSet(false, true)) {
                    ArmadraUnifiedPushService.deliver(null);
                    registerFcm(call);
                }
            }, UNIFIEDPUSH_TIMEOUT_MS));
            UnifiedPush.register(getContext(), ArmadraUnifiedPushService.INSTANCE, null, null);
            return Unit.INSTANCE;
        });
    }

    private void registerFcm(PluginCall call) {
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
            worker.execute(() -> finishRegistration(call, token, null));
        });
    }

    /** {@code token} 与 {@code endpoint} 二选一：FCM（或中继）令牌，或 UnifiedPush 端点。 */
    private void finishRegistration(PluginCall call, String token, String endpoint) {
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
        if (endpoint != null) {
            // UnifiedPush 一律端到端加密到设备公钥，不经中继。
            JSObject registration = new JSObject();
            registration.put("platform", "android");
            registration.put("transport", transport);
            registration.put("publicKey", publicKey);
            JSObject unifiedpush = new JSObject();
            unifiedpush.put("endpoint", endpoint);
            registration.put("unifiedpush", unifiedpush);
            JSObject result = new JSObject();
            result.put("registration", registration);
            call.resolve(result);
            return;
        }
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

    @PluginMethod
    public void pushRotated(PluginCall call) {
        JSObject result = new JSObject();
        result.put("rotated", PushRotation.pending(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void ackPushRotation(PluginCall call) {
        PushRotation.clear(getContext());
        call.resolve();
    }

    // ------------------------------------------------------------ 系统浏览器

    /** 原生 OAuth 的授权页（R-56）：系统浏览器里走完，回调经 {@code armadra://oauth} 深链回来。 */
    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        if (!ExternalUrl.browsable(url)) {
            call.reject("bad url");
            return;
        }
        try {
            Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    .addCategory(Intent.CATEGORY_BROWSABLE)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(view);
            call.resolve();
        } catch (Exception noBrowser) {
            call.reject("no browser");
        }
    }

    // ---------------------------------------------------------------- 深链

    @Override
    protected void handleOnDestroy() {
        PushRotation.setListener(null);
        super.handleOnDestroy();
    }

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
