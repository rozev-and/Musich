package app.musich;

import android.content.Context;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.util.Base64;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Мост к NowPlayingService. update — одним вызовом всё, что показать (обложка — только когда сменилась, JPEG в base64),
 * stop — убрать шторку. Нажатия приходят в приложение событием «action»: { action, seekTime? }
 */
@CapacitorPlugin(name = "NowPlaying")
public class NowPlayingPlugin extends Plugin {
    private static final String TAG = "NowPlaying";
    private static NowPlayingPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    static void emit(String action, Double seekTime) {
        NowPlayingPlugin p = instance;
        if (p == null) return;
        JSObject d = new JSObject();
        d.put("action", action);
        if (seekTime != null) d.put("seekTime", seekTime);
        p.notifyListeners("action", d, true);
    }

    @PluginMethod
    public void update(PluginCall call) {
        NowPlayingService.title = call.getString("title", "");
        NowPlayingService.artist = call.getString("artist", "");
        NowPlayingService.album = call.getString("album", "");
        NowPlayingService.playing = Boolean.TRUE.equals(call.getBoolean("playing", false));
        NowPlayingService.durationMs = Math.round(call.getDouble("duration", 0.0) * 1000);
        NowPlayingService.positionMs = Math.round(call.getDouble("position", 0.0) * 1000);
        String color = call.getString("color");
        if (color != null) {
            try {
                NowPlayingService.color = Color.parseColor(color);
            } catch (IllegalArgumentException ignored) {
                // цвет не разобрали — оставляем прежний
            }
        }
        if (call.hasOption("artwork")) {
            String art = call.getString("artwork");
            try {
                byte[] bytes = art == null || art.isEmpty() ? null : Base64.decode(art, Base64.DEFAULT);
                NowPlayingService.artwork = bytes == null ? null : BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            } catch (IllegalArgumentException e) {
                NowPlayingService.artwork = null;
            }
        }

        Context ctx = getContext();
        Intent i = new Intent(ctx, NowPlayingService.class).setAction(NowPlayingService.ACTION_UPDATE);
        try {
            // первый раз — только когда заиграло (сервису сразу нужна шторка), дальше просто обновляем
            if (NowPlayingService.running) ctx.startService(i);
            else if (NowPlayingService.playing) ContextCompat.startForegroundService(ctx, i);
        } catch (RuntimeException e) {
            Log.w(TAG, "Не удалось показать шторку", e);
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (NowPlayingService.running) {
            Context ctx = getContext();
            try {
                ctx.startService(new Intent(ctx, NowPlayingService.class).setAction(NowPlayingService.ACTION_STOP));
            } catch (RuntimeException e) {
                Log.w(TAG, "Не удалось убрать шторку", e);
            }
        }
        call.resolve();
    }
}
