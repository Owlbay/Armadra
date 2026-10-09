package dev.armadra.mobile;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import android.webkit.WebView;
import com.getcapacitor.JSArray;
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
import dev.armadra.mobile.core.ConnectionRules;
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
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import kotlin.Unit;
import org.json.JSONObject;
import org.unifiedpush.android.connector.UnifiedPush;

/**
 * 原生插件 {@code ArmadraNative}：页面一半在 {@code apps/web/src/mobile/native-bridge.ts}，
 * 约定写在那个文件头里；与 iOS {@code ArmadraNativePlugin.swift} 一一对应。
 *
 * <ul>
 *   <li>{@code getSessions / setSession / removeSession}：Keystore 加密的会话，一个连接一份（{@code sourceId} +
 *       {@code via} 为键）；
 *   <li>{@code getRemotes / setRemote / removeRemote}：远程服务（个人中转）的刷新令牌，{@code serviceId} 为键；
 *   <li>{@code peek}：不带凭据取一次信任锚指纹（{@code /ca.crt} 或握手链），什么也不存；
 *   <li>{@code pin}：取 {@code /ca.crt} 按指纹核对后存为信任锚，之后由
 *       {@link PinningWebViewClient} 只认它，每个来源各存一份；失败必须 reject；
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
    /** 等 UnifiedPush 分发器给端点的上限；过了退回 FCM。 */
    private static final long UNIFIEDPUSH_TIMEOUT_MS = 30_000;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private SecureStore store;
    /** 每个来源一份钉扎（Gateway 与个人中转各钉各的）；握手时按主机与端口找。 */
    private volatile List<Pin> pins = List.of();
    private boolean pageLoaded = false;
    private String pendingScript;
    /** 已经交过深链的那个启动 intent。 */
    private static WeakReference<Intent> handledLaunch = new WeakReference<>(null);

    @Override
    public void load() {
        store = new SecureStore(getContext());
        pins = loadPins();
        getBridge().setWebViewClient(new PinningWebViewClient(getBridge(), () -> pins));
        PushRotation.setListener(() -> notifyListeners("pushTokenRotated", new JSObject()));
        // 冷启动时带来的深链（App 在系统浏览器里走 OAuth 时被系统回收了）：页面加载完再交。同一个
        // intent 只交一次（活动重建时 getIntent() 还是它）；不改 intent 本身——测试框架按它认活动。
        Intent launch = getActivity() == null ? null : getActivity().getIntent();
        DeepLink launchLink = launch == null || launch.getData() == null ? null : DeepLink.parse(launch.getData().toString());
        if (launchLink != null && handledLaunch.get() != launch) {
            handledLaunch = new WeakReference<>(launch);
            Log.i(TAG, "deep link at launch: " + launchLink.kind);
            deliver(launchLink.script());
        }
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageStarted(WebView webView) {
                pageLoaded = false;
            }

            @Override
            public void onPageLoaded(WebView webView) {
                pageLoaded = true;
                flushPending();
            }
        });
    }

    // ------------------------------------------------------ 会话（多连接）

    @PluginMethod
    public void getSessions(PluginCall call) {
        JSArray sessions = new JSArray();
        for (String name : store.names(ConnectionRules.SESSION_PREFIX)) {
            JSObject record = readRecord(name);
            if (record == null) continue;
            String sourceId = record.getString("sourceId");
            String via = record.getString("via");
            // 键与内容对不上的丢掉，不张冠李戴。
            if (sourceId == null || via == null || !name.equals(ConnectionRules.sessionKey(sourceId, via))) continue;
            if (!ConnectionRules.validSession(sourceId, record.getString("origin"), via,
                    record.getString("accessToken"), record.getString("refreshToken"), record.optDouble("expiresAtMs", 0))) {
                continue;
            }
            sessions.put(record);
        }
        JSObject result = new JSObject();
        result.put("sessions", sessions);
        call.resolve(result);
    }

    @PluginMethod
    public void setSession(PluginCall call) {
        JSObject session = call.getObject("session");
        String sourceId = session == null ? null : session.getString("sourceId");
        String origin = session == null ? null : session.getString("origin");
        String via = session == null ? null : session.getString("via");
        String access = session == null ? null : session.getString("accessToken");
        String refresh = session == null ? null : session.getString("refreshToken");
        double expires = session == null ? 0 : session.optDouble("expiresAtMs", 0);
        if (!ConnectionRules.validSession(sourceId, origin, via, access, refresh, expires)) {
            call.reject("invalid session");
            return;
        }
        JSObject value = new JSObject();
        value.put("sourceId", sourceId);
        value.put("origin", origin);
        value.put("via", via);
        value.put("accessToken", access);
        value.put("refreshToken", refresh);
        value.put("expiresAtMs", expires);
        if (store.write(ConnectionRules.sessionKey(sourceId, via), value.toString())) call.resolve();
        else call.reject("keystore unavailable");
    }

    /** 删这个源的会话；给了 {@code origin} 只删发往它的那份。别的源不动。 */
    @PluginMethod
    public void removeSession(PluginCall call) {
        String sourceId = call.getString("sourceId");
        String origin = call.getString("origin");
        if (!ConnectionRules.isName(sourceId)) {
            call.reject("invalid session");
            return;
        }
        for (String via : new String[] {"direct", "relayed"}) {
            String key = ConnectionRules.sessionKey(sourceId, via);
            JSObject record = readRecord(key);
            if (record == null) continue;
            if (origin != null && !origin.equals(record.getString("origin"))) continue;
            store.delete(key);
        }
        call.resolve();
    }

    // -------------------------------------------------------------- 远程服务

    @PluginMethod
    public void getRemotes(PluginCall call) {
        JSArray remotes = new JSArray();
        for (String name : store.names(ConnectionRules.REMOTE_PREFIX)) {
            JSObject record = readRecord(name);
            if (record == null) continue;
            String serviceId = record.getString("serviceId");
            if (serviceId == null || !name.equals(ConnectionRules.remoteKey(serviceId))) continue;
            if (!ConnectionRules.validRemote(serviceId, record.getString("issuer"), record.getString("kind"),
                    record.getString("refreshToken"), record.getString("fingerprint"))) {
                continue;
            }
            remotes.put(record);
        }
        JSObject result = new JSObject();
        result.put("remotes", remotes);
        call.resolve(result);
    }

    @PluginMethod
    public void setRemote(PluginCall call) {
        JSObject remote = call.getObject("remote");
        String serviceId = remote == null ? null : remote.getString("serviceId");
        String issuer = remote == null ? null : remote.getString("issuer");
        String kind = remote == null ? null : remote.getString("kind");
        String refresh = remote == null ? null : remote.getString("refreshToken");
        String fingerprint = remote == null ? null : remote.getString("fingerprint");
        if (!ConnectionRules.validRemote(serviceId, issuer, kind, refresh, fingerprint)) {
            call.reject("invalid remote");
            return;
        }
        JSObject value = new JSObject();
        value.put("serviceId", serviceId);
        value.put("issuer", issuer);
        value.put("kind", kind);
        value.put("refreshToken", refresh);
        value.put("fingerprint", fingerprint);
        if (store.write(ConnectionRules.remoteKey(serviceId), value.toString())) call.resolve();
        else call.reject("keystore unavailable");
    }

    @PluginMethod
    public void removeRemote(PluginCall call) {
        String serviceId = call.getString("serviceId");
        if (!ConnectionRules.isName(serviceId)) {
            call.reject("invalid remote");
            return;
        }
        store.delete(ConnectionRules.remoteKey(serviceId));
        call.resolve();
    }

    private JSObject readRecord(String name) {
        String stored = store.read(name);
        if (stored == null) return null;
        try {
            return new JSObject(stored);
        } catch (Exception ignored) {
            store.delete(name);
            return null;
        }
    }

    private List<Pin> loadPins() {
        List<Pin> out = new ArrayList<>();
        for (String name : store.names(ConnectionRules.PIN_PREFIX)) {
            Pin loaded = Pin.decode(store.read(name));
            if (loaded != null && name.equals(ConnectionRules.pinKey(loaded.origin))) out.add(loaded);
        }
        return out;
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
            if (!store.write(ConnectionRules.pinKey(origin), next.encode())) {
                call.reject("keystore unavailable");
                return;
            }
            // 同一个来源重钉是替换，别的来源的钉扎不动。
            List<Pin> updated = new ArrayList<>();
            String key = Pin.originKey(origin);
            for (Pin existing : pins) {
                if (!key.equals(Pin.originKey(existing.origin))) updated.add(existing);
            }
            updated.add(next);
            pins = updated;
            call.resolve();
        });
    }

    /**
     * 不带凭据取一次信任锚指纹，让页面把它给人核对（个人中转自签 CA 的首次信任）。什么也不存：真正的钉扎
     * 要等人确认之后页面再调 {@code pin}。指纹取服务端发的 {@code /ca.crt}（与中转启动日志打印的同一个），
     * 没有就取握手链最后一张。{@code trusted} 是系统本来就信这条链，{@code pinned} 是已经钉过、而且服务端
     * 仍发着那一张。
     */
    @PluginMethod
    public void peek(PluginCall call) {
        String origin = call.getString("origin");
        if (!PinPolicy.isOrigin(origin)) {
            call.reject("bad origin");
            return;
        }
        worker.execute(() -> {
            AnchorFetch.Fetched fetched = AnchorFetch.fetch(origin);
            JSObject result = new JSObject();
            if (fetched == null) {
                call.resolve(result);
                return;
            }
            List<X509Certificate> candidates = fetched.body.isEmpty() ? fetched.presented : fetched.body;
            try {
                String fingerprint = PinPolicy.fingerprint(candidates.get(candidates.size() - 1).getEncoded());
                Pin existing = null;
                String key = Pin.originKey(origin);
                for (Pin candidate : pins) {
                    if (key.equals(Pin.originKey(candidate.origin))) existing = candidate;
                }
                boolean pinned = existing != null && PinPolicy.anchor(fetched.all(), existing) != null;
                result.put("fingerprint", pinned ? existing.fingerprint : fingerprint);
                result.put("trusted", AnchorFetch.systemTrusts(origin));
                result.put("pinned", pinned);
            } catch (Exception error) {
                call.resolve(new JSObject());
                return;
            }
            call.resolve(result);
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

    /**
     * App 自己的版本名与构建号（{@code versionName} / {@code versionCode}，来自
     * {@code app/version.properties}）。移动端有独立的版本线，与所连主机的版本无关。
     */
    @PluginMethod
    public void appInfo(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
            JSObject result = new JSObject();
            result.put("version", info.versionName == null ? "" : info.versionName);
            result.put("build", String.valueOf(code));
            call.resolve(result);
        } catch (PackageManager.NameNotFoundException missing) {
            call.reject("no package info");
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

    /**
     * 页面还在加载（冷启动）时先记着，加载完再执行。「加载完」不只靠 {@code onPageLoaded}：Capacitor 只在
     * {@code onPageFinished} 时进度恰为 100 才回调，冷启动时会漏，所以另外每 250ms 看一次进度，至多 30 秒。
     */
    private void deliver(String script) {
        getBridge().executeOnMainThread(() -> {
            pendingScript = script;
            flushPending();
            if (pendingScript != null) pollPending(120);
        });
    }

    /** 主线程上：页面在就交出去。 */
    private void flushPending() {
        WebView webView = getBridge().getWebView();
        if (pendingScript == null || webView == null) return;
        boolean ready = pageLoaded || (webView.getUrl() != null && webView.getProgress() == 100);
        if (!ready) return;
        String script = pendingScript;
        pendingScript = null;
        Log.i(TAG, "deep link handed to the page");
        webView.evaluateJavascript(script, null);
    }

    private void pollPending(int remaining) {
        WebView webView = getBridge().getWebView();
        if (pendingScript == null || remaining <= 0 || webView == null) return;
        webView.postDelayed(() -> {
            flushPending();
            pollPending(remaining - 1);
        }, 250);
    }
}
