package dev.armadra.mobile;

import dev.armadra.mobile.core.ExternalUrl;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;
import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

/**
 * UnifiedPush（契约 §27.2）：没有 Google 服务的手机经用户自己挑的分发器（自托管 ntfy 等）收推送。
 *
 * <ul>
 *   <li>{@code onNewEndpoint}：插件在等登记就交给它（{@link #await}）；否则是分发器换了端点——记下并标「换过」，
 *       页面重新登记（R-54 同一条路）。
 *   <li>{@code onMessage}：core POST 的正文就是 §19.5 的信封 JSON（分发器只见密文）；连接库按 RFC 8291 解不开
 *       时原样给出字节，交给 {@link PushDisplay}。
 *   <li>{@code onUnregistered}：分发器卸载或撤销了登记——清掉端点并标「换过」。
 * </ul>
 */
public class ArmadraUnifiedPushService extends PushService {
    static final String INSTANCE = "default";

    private static final Object LOCK = new Object();
    private static Consumer<String> waiter;

    /** 插件发起登记时挂一个等端点的回调；端点是 {@code null} 表示失败。再挂一次会顶掉上一个（答失败）。 */
    static void await(Consumer<String> next) {
        Consumer<String> previous;
        synchronized (LOCK) {
            previous = waiter;
            waiter = next;
        }
        if (previous != null) previous.accept(null);
    }

    /** 等的那一个还在就交出去（只交一次）。 */
    static boolean deliver(String endpoint) {
        Consumer<String> current;
        synchronized (LOCK) {
            current = waiter;
            waiter = null;
        }
        if (current == null) return false;
        current.accept(endpoint);
        return true;
    }

    @Override
    public void onNewEndpoint(PushEndpoint endpoint, String instance) {
        String url = endpoint.getUrl();
        if (!ExternalUrl.unifiedPushEndpoint(url)) {
            deliver(null);
            return;
        }
        String previous = PushRotation.endpoint(this);
        PushRotation.setEndpoint(this, url);
        if (deliver(url)) return;
        if (!url.equals(previous)) PushRotation.mark(this);
    }

    @Override
    public void onMessage(PushMessage message, String instance) {
        PushDisplay.show(this, new String(message.getContent(), StandardCharsets.UTF_8), null);
    }

    @Override
    public void onRegistrationFailed(FailedReason reason, String instance) {
        deliver(null);
    }

    @Override
    public void onUnregistered(String instance) {
        boolean had = PushRotation.endpoint(this) != null;
        PushRotation.setEndpoint(this, null);
        if (!deliver(null) && had) PushRotation.mark(this);
    }
}
