package app.musich;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.widget.RemoteViews;

/**
 * Виджет на главный экран: обложка, название, исполнитель и кнопки назад / играть-пауза / вперёд.
 * Данные — те же, что у шторки (NowPlayingService): служба обновляет виджет при каждом своём обновлении.
 * Приложение не запущено (службы нет) — любое нажатие просто открывает MUSICH
 */
public class MusichWidget extends AppWidgetProvider {

    @Override
    public void onUpdate(Context ctx, AppWidgetManager manager, int[] ids) {
        update(ctx);
    }

    static void update(Context ctx) {
        AppWidgetManager manager = AppWidgetManager.getInstance(ctx);
        int[] ids = manager.getAppWidgetIds(new ComponentName(ctx, MusichWidget.class));
        if (ids == null || ids.length == 0) return;

        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_now_playing);
        boolean live = NowPlayingService.running && !NowPlayingService.title.isEmpty();
        v.setTextViewText(R.id.widget_title, live ? NowPlayingService.title : ctx.getString(R.string.app_name));
        v.setTextViewText(R.id.widget_artist, live ? NowPlayingService.artist : ctx.getString(R.string.widget_idle));
        Bitmap art = live ? NowPlayingService.artwork : null;
        if (art != null) {
            // в виджет — маленькая копия: у RemoteViews ограничение на размер картинки
            int side = Math.min(256, Math.min(art.getWidth(), art.getHeight()));
            v.setImageViewBitmap(R.id.widget_cover, Bitmap.createScaledBitmap(art, side, side, true));
        } else {
            v.setImageViewResource(R.id.widget_cover, R.mipmap.ic_launcher);
        }
        v.setImageViewResource(R.id.widget_play, NowPlayingService.playing && live ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play);
        v.setInt(R.id.widget_play, "setColorFilter", NowPlayingService.color);

        PendingIntent open = PendingIntent.getActivity(ctx, 10,
            new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        v.setOnClickPendingIntent(R.id.widget_root, open);
        if (live) {
            v.setOnClickPendingIntent(R.id.widget_prev, action(ctx, NowPlayingService.ACTION_PREV, 11));
            v.setOnClickPendingIntent(R.id.widget_play, action(ctx, NowPlayingService.playing ? NowPlayingService.ACTION_PAUSE : NowPlayingService.ACTION_PLAY, 12));
            v.setOnClickPendingIntent(R.id.widget_next, action(ctx, NowPlayingService.ACTION_NEXT, 13));
        } else {
            v.setOnClickPendingIntent(R.id.widget_prev, open);
            v.setOnClickPendingIntent(R.id.widget_play, open);
            v.setOnClickPendingIntent(R.id.widget_next, open);
        }
        manager.updateAppWidget(ids, v);
    }

    private static PendingIntent action(Context ctx, String a, int code) {
        Intent i = new Intent(ctx, NowPlayingService.class).setAction(a);
        return PendingIntent.getService(ctx, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
}
