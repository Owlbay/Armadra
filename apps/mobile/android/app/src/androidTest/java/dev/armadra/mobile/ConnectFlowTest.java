package dev.armadra.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import android.content.Intent;
import android.net.Uri;
import android.os.SystemClock;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.FixMethodOrder;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.MethodSorters;

/**
 * B 档 UI 用例「连接 → 配对 → 画布」（补全计划 G3-1），由
 * {@code tools/probes/mobile-shell-e2e.mjs} 驱动：探针起 core、在回环上开 Gateway、
 * {@code adb reverse} 把模拟器的回环端口接到宿主，再把原生深链
 * {@code armadra://pair?host=…&ticket=…&fp=…} 作为插桩参数 {@code armadraPairLink} 传进来。
 *
 * <p>页面在 WebView 里，按页面自己的标记判断（{@code data-slot}），不依赖文案语言。按名字顺序跑：
 * 还没有连接时连接页先列出添加方式（扫码、配对链接、个人中转），输入框要点「配对链接」才出来
 * （{@code data-connect-method="link"}）。配对之后 App 记住了 Gateway，「没有 Gateway」那条必须在前；第三条（G5-22）要已配对的 App 与探针
 * 上传的那张资产（插桩参数 {@code armadraAssetUrl}）。
 */
@RunWith(AndroidJUnit4.class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
public class ConnectFlowTest {
    private static final long TIMEOUT_MS = 60_000;

    private static String eval(ActivityScenario<MainActivity> scenario, String script) throws Exception {
        AtomicReference<String> result = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        scenario.onActivity(activity -> {
            WebView webView = activity.getBridge().getWebView();
            webView.evaluateJavascript(script, value -> {
                result.set(value);
                done.countDown();
            });
        });
        assertTrue("script timed out", done.await(10, TimeUnit.SECONDS));
        return result.get();
    }

    private static void waitFor(ActivityScenario<MainActivity> scenario, String condition, String what)
            throws Exception {
        long deadline = SystemClock.elapsedRealtime() + TIMEOUT_MS;
        while (SystemClock.elapsedRealtime() < deadline) {
            if ("true".equals(eval(scenario, "(function(){try{return !!(" + condition + ");}catch(e){return false;}})()"))) {
                return;
            }
            SystemClock.sleep(500);
        }
        // 失败时把页面上看得到的字（连接页的错误提示）带进断言，CI 日志里就能看出卡在哪。
        String page = eval(scenario, "(function(){var n=document.querySelector('[data-slot=\"mobile-connect\"]');"
                + "return location.href+' | oauth='+localStorage.getItem('armadra.oauth.native')+' | '"
                + "+(n?n.innerText:document.body.innerText).slice(0,600);})()");
        throw new AssertionError("timed out waiting for " + what + ": " + page);
    }

    @Test
    public void a_withoutAGatewayTheAppOpensOnTheConnectScreen() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            waitFor(scenario, "document.querySelector('[data-slot=\"mobile-connect\"]')", "connect screen");
            assertTrue("plugin registered", "true".equals(eval(scenario,
                    "!!(window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.ArmadraNative)")));
        }
    }

    @Test
    public void b_pairsThroughThePinnedGatewayAndOpensTheCanvas() throws Exception {
        String link = InstrumentationRegistry.getArguments().getString("armadraPairLink");
        assumeTrue("armadraPairLink not given (run through tools/probes/mobile-shell-e2e.mjs)", link != null);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            // 多连接的连接页（还没有连接时）先列出添加方式，输入框在「配对链接」后面：点它再等输入框。
            waitFor(scenario, "document.querySelector('[data-slot=\"mobile-connect\"] input')"
                    + " || document.querySelector('[data-slot=\"mobile-connect\"] [data-connect-method=\"link\"]')",
                    "connect screen");
            eval(scenario, "(function(){if(document.querySelector('[data-slot=\"mobile-connect\"] input'))return true;"
                    + "document.querySelector('[data-slot=\"mobile-connect\"] [data-connect-method=\"link\"]').click();"
                    + "return true;})()");
            waitFor(scenario, "document.querySelector('[data-slot=\"mobile-connect\"] input')", "pairing link input");
            // React 受控输入框：用原型上的 setter 写值再发 input 事件，然后提交表单。
            eval(scenario, "(function(){var input=document.querySelector('[data-slot=\"mobile-connect\"] input');"
                    + "Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,"
                    + JSONObject.quote(link) + ");input.dispatchEvent(new Event('input',{bubbles:true}));"
                    + "return true;})()");
            waitFor(scenario, "document.querySelector('[data-slot=\"mobile-connect\"] button[type=\"submit\"]:not([disabled])')",
                    "connect button enabled");
            eval(scenario, "document.querySelector('[data-slot=\"mobile-connect\"] form').requestSubmit();true");
            waitFor(scenario, "document.querySelector('[data-slot=\"mobile-bottom-nav\"]')"
                    + " && !document.querySelector('[data-slot=\"mobile-connect\"]')", "canvas after pairing");
        }
        // 重开 App：会话从 Keystore 读回，直接进画布、不再问配对。
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            waitFor(scenario, "document.querySelector('[data-slot=\"mobile-bottom-nav\"]')"
                    + " && !document.querySelector('[data-slot=\"mobile-connect\"]')", "canvas after relaunch");
        }
    }

    @Test
    public void c_bearerAssetsAndTheNativeOAuthLink() throws Exception {
        String asset = InstrumentationRegistry.getArguments().getString("armadraAssetUrl");
        assumeTrue("armadraAssetUrl not given (run through tools/probes/mobile-shell-e2e.mjs)", asset != null);
        String canvas = "document.querySelector('[data-slot=\"mobile-bottom-nav\"]')"
                + " && !document.querySelector('[data-slot=\"mobile-connect\"]')";
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            waitFor(scenario, canvas, "canvas");
            // R-55：直接 <img> 带不了 Bearer（401）；带上这台 Gateway 的访问密钥再取就取得到——useAssetUrl
            // 经本机源的 fetch 走的那条。页面自 2026-10-06 起不再改写全局 fetch（凭据装在源上，
            // api/source.ts），所以用例从 Keystore 读回同一份会话、自己带 Authorization。
            eval(scenario, "(function(){window.__e2e={};var url=" + JSONObject.quote(asset) + ";var i=new Image();"
                    + "i.onload=function(){__e2e.img='load'};i.onerror=function(){__e2e.img='error'};"
                    + "i.src=url;var origin=new URL(url).origin;"
                    + "Capacitor.Plugins.ArmadraNative.getSessions().then(function(r){"
                    + "var s=(r.sessions||[]).filter(function(x){return x.origin===origin})[0];"
                    + "if(!s){__e2e.fetch='no session';return;}"
                    + "return fetch(url,{headers:{Authorization:'Bearer '+s.accessToken}}).then(function(res){"
                    + "return res.blob().then(function(b){__e2e.fetch=res.status+' '+b.type})});"
                    + "}).catch(function(e){__e2e.fetch='failed '+e});return true;})()");
            waitFor(scenario, "window.__e2e && __e2e.img && __e2e.fetch", "asset requests");
            assertEquals("\"error|200 image/png\"", eval(scenario, "__e2e.img+'|'+__e2e.fetch"));
            // R-56：记一条挂起的原生 OAuth（与页面 startNativeOAuth 记的同形）。
            eval(scenario, "localStorage.setItem('armadra.oauth.native',JSON.stringify({providerId:'e2e',"
                    + "state:'e2e-state',nativeState:'e2e-native',expiresAtMs:Date.now()+600000}));true");
        }
        // 深链冷启动 App（在系统浏览器里走授权时 App 被回收的那种）：插件在页面加载后交出深链，页面重载、
        // 入口带着 nativeState 去 core 收尾（state 不认识，答 oauth_state_invalid），结果打开「安全」页。
        Intent link = new Intent(Intent.ACTION_VIEW, Uri.parse("armadra://oauth?state=e2e-state&code=e2e-code"),
                InstrumentationRegistry.getInstrumentation().getTargetContext(), MainActivity.class);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(link)) {
            waitFor(scenario, "localStorage.getItem('armadra.oauth.native')===null", "the oauth link completed");
            waitFor(scenario, "document.querySelector('[data-slot=\"security-page\"]') && location.hash===''",
                    "security page after the oauth link");
        }
    }
}
