package dev.armadra.mobile;

import android.content.Context;
import dev.armadra.mobile.core.DeepLink;
import dev.armadra.mobile.core.PushEnvelope;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * 推送到了之后的同一段处理（契约 §19.4、§19.5），FCM 与 UnifiedPush 共用：端到端信封用 Keystore 加密存的
 * 设备私钥解开；解不开就出一条占位通知（「有新通知」），不丢。正文按契约截断，深链认不出就丢掉。
 */
final class PushDisplay {
    private PushDisplay() {}

    /** {@code envelope}：信封的 JSON 文本；{@code plaintext}：{@code direct} 没带公钥时的明文载荷。 */
    static void show(Context context, String envelope, String plaintext) {
        JSONObject payload = null;
        try {
            if (envelope != null) {
                JSONObject sealed = new JSONObject(envelope);
                byte[] key = new SecureStore(context).readBytes(SecureStore.DEVICE_KEY);
                if (key != null) {
                    byte[] opened = PushEnvelope.open(
                            sealed.optInt("v"), sealed.optString("alg"), sealed.optString("epk"),
                            sealed.optString("salt"), sealed.optString("iv"), sealed.optString("ct"), key);
                    payload = new JSONObject(new String(opened, StandardCharsets.UTF_8));
                }
            } else if (plaintext != null) {
                payload = new JSONObject(plaintext);
            }
        } catch (Exception undecryptable) {
            payload = null;
        }
        if (payload == null || payload.optInt("v") != 1 || !PushEnvelope.KINDS.contains(payload.optString("kind"))) {
            Notifications.show(context, context.getString(R.string.push_fallback_title),
                    context.getString(R.string.push_fallback_body), "", "armadra");
            return;
        }
        String url = payload.optString("url");
        Notifications.show(
                context,
                clip(payload.optString("title"), 64),
                clip(payload.optString("body"), 120),
                DeepLink.parse(url) == null ? "" : url,
                clip(payload.optString("tag", "armadra"), 128));
    }

    private static String clip(String text, int limit) {
        return text.length() <= limit ? text : text.substring(0, limit);
    }
}
