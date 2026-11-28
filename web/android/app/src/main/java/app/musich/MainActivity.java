package app.musich;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioManager;
import android.os.Bundle;

import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // Наушники отключили (провод выдернули, Bluetooth отвалился) — система шлёт «звук сейчас пойдёт в динамик».
    // Передаём в приложение событием musich-noisy: там ставим на паузу, как делают все плееры
    private final BroadcastReceiver noisy = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction()) && getBridge() != null) {
                getBridge().triggerWindowJSEvent("musich-noisy");
            }
        }
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // свой плагин: поиск сервера MUSICH в домашней сети
        registerPlugin(DiscoveryPlugin.class);
        // своя шторка «что играет» (NowPlayingService)
        registerPlugin(NowPlayingPlugin.class);
        // где хранить музыку: папка приложения, общая «Музыка/MUSICH» или своя папка
        registerPlugin(MusicStorePlugin.class);
        super.onCreate(savedInstanceState);
        // крупный шрифт системы WebView применяет только к тексту — вёрстка разъезжается; масштаб — в настройках MUSICH
        getBridge().getWebView().getSettings().setTextZoom(100);
        ContextCompat.registerReceiver(this, noisy, new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), ContextCompat.RECEIVER_EXPORTED);
    }

    @Override
    public void onDestroy() {
        try {
            unregisterReceiver(noisy);
        } catch (IllegalArgumentException ignored) {
            // не был зарегистрирован
        }
        super.onDestroy();
    }
}
