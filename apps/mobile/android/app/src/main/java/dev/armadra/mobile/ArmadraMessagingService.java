package dev.armadra.mobile;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/**
 * FCM 数据消息（契约 §19.5）：{@code data.enc} 是端到端信封，{@code data.payload} 是 {@code direct} 没带
 * 公钥时的明文；处理在 {@link PushDisplay}。
 */
public class ArmadraMessagingService extends FirebaseMessagingService {
    @Override
    public void onMessageReceived(RemoteMessage message) {
        Map<String, String> data = message.getData();
        PushDisplay.show(this, data.get("enc"), data.get("payload"));
    }

    /**
     * 令牌换了（R-54）：core 只认登记时交的那一张，记一笔「换过」并告诉开着的页面；页面对开过推送的设备
     * 重新 {@code PUT /api/push/devices}（{@code apps/web/src/mobile/push-rotation.ts}）。
     */
    @Override
    public void onNewToken(String token) {
        PushRotation.mark(this);
    }
}
