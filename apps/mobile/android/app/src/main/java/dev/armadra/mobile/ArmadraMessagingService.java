package dev.armadra.mobile;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import dev.armadra.mobile.core.DeepLink;
import dev.armadra.mobile.core.PushEnvelope;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.json.JSONObject;

/**
 * FCM 数据消息（契约 §19.5）：{@code data.enc} 是端到端信封，用 Keystore 加密存的设备
 * 私钥解开；{@code data.payload} 是 {@code direct} 没带公钥时的明文。解不开就出一条
 * 占位通知（「有新通知」），不丢。正文按契约 §19.4 截断，深链认不出就丢掉。
 */
public class ArmadraMessagingService extends FirebaseMessagingService {
    @Override
    public void onMessageReceived(RemoteMessage message) {
        Map<String, String> data = message.getData();
        JSONObject payload = null;
        try {
            String enc = data.get("enc");
            if (enc != null) {
                JSONObject envelope = new JSONObject(enc);
                byte[] key = new SecureStore(this).readBytes(SecureStore.DEVICE_KEY);
                if (key != null) {
                    byte[] plaintext = PushEnvelope.open(
                            envelope.optInt("v"), envelope.optString("alg"), envelope.optString("epk"),
                            envelope.optString("salt"), envelope.optString("iv"), envelope.optString("ct"), key);
                    payload = new JSONObject(new String(plaintext, StandardCharsets.UTF_8));
                }
            } else if (data.get("payload") != null) {
                payload = new JSONObject(data.get("payload"));
            }
        } catch (Exception undecryptable) {
            payload = null;
        }
        if (payload == null || payload.optInt("v") != 1 || !PushEnvelope.KINDS.contains(payload.optString("kind"))) {
            Notifications.show(this, getString(R.string.push_fallback_title), getString(R.string.push_fallback_body),
                    "", "armadra");
            return;
        }
        String url = payload.optString("url");
        Notifications.show(
                this,
                clip(payload.optString("title"), 64),
                clip(payload.optString("body"), 120),
                DeepLink.parse(url) == null ? "" : url,
                clip(payload.optString("tag", "armadra"), 128));
    }

    @Override
    public void onNewToken(String token) {
        // 令牌换了：App 下次开启推送时重新登记（core 只认登记时交的那一张）。
    }

    private static String clip(String text, int limit) {
        return text.length() <= limit ? text : text.substring(0, limit);
    }
}
