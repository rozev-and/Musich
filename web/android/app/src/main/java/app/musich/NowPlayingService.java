package app.musich;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;

/**
 * Что играет — в шторку, на экран блокировки и наушникам. Свой вместо готового плагина: у того кнопки «пауза/играть»
 * в шторке были без действия (составной код кнопки), обложка грузилась по http без входа и оставалась от прошлого трека,
 * а позиция обновлялась только при смене трека.
 *
 * Состояние лежит в статических полях: его пишет NowPlayingPlugin, сервис только показывает. Кнопки шторки приходят
 * сюда же (PendingIntent на сервис), кнопки наушников и экрана блокировки — в колбэк MediaSession; и то и другое
 * уходит в приложение событием «action»
 */
public class NowPlayingService extends Service {
    static final String ACTION_UPDATE = "app.musich.np.UPDATE";
    static final String ACTION_STOP = "app.musich.np.STOP";
    static final String ACTION_PLAY = "app.musich.np.PLAY";
    static final String ACTION_PAUSE = "app.musich.np.PAUSE";
    static final String ACTION_NEXT = "app.musich.np.NEXT";
    static final String ACTION_PREV = "app.musich.np.PREV";
    private static final String CHANNEL = "playback";
    private static final int NOTIFICATION_ID = 1;

    static volatile boolean running = false;
    static String title = "";
    static String artist = "";
    static String album = "";
    static Bitmap artwork;
    static boolean playing = false;
    static long durationMs = 0;
    static long positionMs = 0;
    static int color = 0xFFD71921;

    private MediaSession session;

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, getString(R.string.playback_channel), NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        session = new MediaSession(this, "MUSICH");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { press("play"); }
            @Override public void onPause() { press("pause"); }
            @Override public void onSkipToNext() { NowPlayingPlugin.emit("nexttrack", null); }
            @Override public void onSkipToPrevious() { NowPlayingPlugin.emit("previoustrack", null); }
            @Override public void onStop() { press("pause"); }
            @Override public void onSeekTo(long pos) {
                positionMs = pos;
                refresh();
                NowPlayingPlugin.emit("seekto", pos / 1000.0);
            }
        });
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        session.setSessionActivity(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        session.setActive(true);
    }

    /** Пауза/играть: сразу показываем новое состояние (шторка не ждёт приложение), приложение подтвердит своим update */
    private void press(String action) {
        playing = "play".equals(action);
        refresh();
        NowPlayingPlugin.emit(action, null);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String a = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(a)) {
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_PLAY.equals(a)) press("play");
        else if (ACTION_PAUSE.equals(a)) press("pause");
        else if (ACTION_NEXT.equals(a)) NowPlayingPlugin.emit("nexttrack", null);
        else if (ACTION_PREV.equals(a)) NowPlayingPlugin.emit("previoustrack", null);
        refresh();
        return START_NOT_STICKY;
    }

    private void refresh() {
        if (session == null) return;
        MediaMetadata.Builder meta = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
            .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs);
        // обложку отдаём всегда, даже пустую: иначе система оставит картинку прошлого трека
        meta.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, artwork);
        session.setMetadata(meta.build());
        session.setPlaybackState(new PlaybackState.Builder()
            .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
                | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_SEEK_TO
                | PlaybackState.ACTION_STOP)
            // скорость 0 на паузе: система не «докручивает» полоску сама
            .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, positionMs, playing ? 1f : 0f)
            .build());

        Notification n = build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(NOTIFICATION_ID, n);
        MusichWidget.update(this); // виджет на главном экране — то же самое
    }

    private PendingIntent action(String a, int code) {
        Intent i = new Intent(this, NowPlayingService.class).setAction(a);
        return PendingIntent.getService(this, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification build() {
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_stat_musich) // слева сверху — логотип MUSICH
            .setColor(color) // цвет темы: значок и акценты шторки
            .setContentTitle(title)
            .setContentText(artist)
            .setSubText(album)
            .setLargeIcon(artwork) // на Android 13+ это и фон плеера в шторке
            .setShowWhen(false)
            .setOngoing(playing)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setContentIntent(session.getController().getSessionActivity())
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_previous, getString(R.string.np_prev), action(ACTION_PREV, 1)).build())
            .addAction(playing
                ? new Notification.Action.Builder(android.R.drawable.ic_media_pause, getString(R.string.np_pause), action(ACTION_PAUSE, 2)).build()
                : new Notification.Action.Builder(android.R.drawable.ic_media_play, getString(R.string.np_play), action(ACTION_PLAY, 3)).build())
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_next, getString(R.string.np_next), action(ACTION_NEXT, 4)).build())
            .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2));
        return b.build();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // приложение смахнули из недавних — музыки больше нет, убираем и шторку
        stopForeground(true);
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        MusichWidget.update(this);
        if (session != null) {
            session.setActive(false);
            session.release();
            session = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
