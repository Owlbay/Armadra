package dev.armadra.mobile;

import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import android.os.SystemClock;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * B 档 UI 用例「连接 → 配对 → 画布」（补全计划 G3-1），由
 * {@code tools/probes/mobile-shell-e2e.mjs} 驱动：探针起 core、在回环上开 Gateway、
 * {@code adb reverse} 把模拟器的回环端口接到宿主，再把原生深链
 * {@code armadra://pair?host=…&ticket=…&fp=…} 作为插桩参数 {@code armadraPairLink} 传进来。
 *
 * <p>页面在 WebView 里，按页面自己的标记判断（{@code data-slot}），不依赖文案语言。
 */
@RunWith(AndroidJUnit4.class)
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
                + "return location.href+' | '+(n?n.innerText:document.body.innerText).slice(0,600);})()");
        throw new AssertionError("timed out waiting for " + what + ": " + page);
    }

    @Test
    public void withoutAGatewayTheAppOpensOnTheConnectScreen() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            waitFor(scenario, "document.querySelector('[data-slot=\"mobile-connect\"]')", "connect screen");
            assertTrue("plugin registered", "true".equals(eval(scenario,
                    "!!(window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.ArmadraNative)")));
        }
    }

    @Test
    public void pairsThroughThePinnedGatewayAndOpensTheCanvas() throws Exception {
        String link = InstrumentationRegistry.getArguments().getString("armadraPairLink");
        assumeTrue("armadraPairLink not given (run through tools/probes/mobile-shell-e2e.mjs)", link != null);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            waitFor(scenario, "document.querySelector('[data-slot=\"mobile-connect\"] input')", "connect screen");
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
    }
}
