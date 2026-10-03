package dev.armadra.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/** Capacitor 的活动，多装一个 App 自己的插件 {@link ArmadraNativePlugin}（补全架构 §10）。 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ArmadraNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
