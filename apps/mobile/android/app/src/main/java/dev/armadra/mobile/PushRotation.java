package dev.armadra.mobile;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 「推送令牌换过、还没重新登记」的标记（R-54）。FCM 的 {@code onNewToken}、UnifiedPush 的新端点都记它；
 * 页面经插件的 {@code pushRotated} 查、重新登记成功后 {@code ackPushRotation} 清。插件开着时另发
 * {@code pushTokenRotated} 事件。标记不是密钥，放普通的 SharedPreferences。
 */
final class PushRotation {
    interface Listener {
        void rotated();
    }

    private static final String PREFERENCES = "armadra.push";
    private static final String ROTATED = "rotated";
    private static final String ENDPOINT = "unifiedpush.endpoint";
    private static volatile Listener listener;

    private PushRotation() {}

    static void setListener(Listener next) {
        listener = next;
    }

    static void mark(Context context) {
        preferences(context).edit().putBoolean(ROTATED, true).apply();
        Listener current = listener;
        if (current != null) current.rotated();
    }

    static boolean pending(Context context) {
        return preferences(context).getBoolean(ROTATED, false);
    }

    static void clear(Context context) {
        preferences(context).edit().putBoolean(ROTATED, false).apply();
    }

    /** UnifiedPush 上一次给的端点；没有是 {@code null}。 */
    static String endpoint(Context context) {
        return preferences(context).getString(ENDPOINT, null);
    }

    static void setEndpoint(Context context, String endpoint) {
        SharedPreferences.Editor editor = preferences(context).edit();
        if (endpoint == null) editor.remove(ENDPOINT);
        else editor.putString(ENDPOINT, endpoint);
        editor.apply();
    }

    private static SharedPreferences preferences(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }
}
