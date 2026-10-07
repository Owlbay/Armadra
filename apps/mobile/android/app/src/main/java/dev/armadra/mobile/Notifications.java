package dev.armadra.mobile;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/** 出一条通知；点开按深链回到 {@link MainActivity}（{@code singleTask}，走 {@code onNewIntent}）。 */
final class Notifications {
    static final String CHANNEL = "armadra";

    private Notifications() {}

    static void ensureChannel(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL) != null) return;
        manager.createNotificationChannel(new NotificationChannel(
                CHANNEL, context.getString(R.string.notification_channel), NotificationManager.IMPORTANCE_HIGH));
    }

    static void show(Context context, String title, String body, String url, String tag) {
        ensureChannel(context);
        Intent open = new Intent(Intent.ACTION_VIEW, url.isEmpty() ? null : Uri.parse(url), context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(
                context, tag.hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_armadra)
                .setContentTitle(title)
                .setContentText(body)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(pending);
        try {
            NotificationManagerCompat.from(context).notify(tag, 0, builder.build());
        } catch (SecurityException denied) {
            // 用户关了通知权限：不出。
        }
    }
}
