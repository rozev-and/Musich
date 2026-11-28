package app.musich;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Поиск MUSICH в домашней сети (mDNS, _musich._tcp) системным NsdManager: сервер на ПК объявляет себя сам,
 * приложение находит его без ввода адреса. Отдаёт адрес, порт и TXT-записи (node — id сервера, addr — все его адреса)
 */
@CapacitorPlugin(name = "Discovery")
public class DiscoveryPlugin extends Plugin {

    @PluginMethod
    public void discover(PluginCall call) {
        final int timeout = call.getInt("timeout", 4000);
        final Context ctx = getContext().getApplicationContext();
        final NsdManager nsd = (NsdManager) ctx.getSystemService(Context.NSD_SERVICE);
        final WifiManager wifi = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
        if (nsd == null) {
            call.reject("Поиск в сети недоступен");
            return;
        }
        // без этого замка часть телефонов отбрасывает многоадресные пакеты ради экономии батареи
        final WifiManager.MulticastLock lock = wifi != null ? wifi.createMulticastLock("musich-discovery") : null;
        if (lock != null) {
            lock.setReferenceCounted(false);
            lock.acquire();
        }

        final JSArray found = new JSArray();
        final Set<String> seen = new HashSet<>();
        // старые Android умеют только одно разрешение адреса за раз — ставим в очередь
        final ArrayDeque<NsdServiceInfo> queue = new ArrayDeque<>();
        final boolean[] resolving = { false };
        final boolean[] done = { false };

        final Runnable[] next = new Runnable[1];
        next[0] = () -> {
            NsdServiceInfo info;
            synchronized (queue) {
                if (resolving[0] || done[0] || queue.isEmpty()) return;
                info = queue.poll();
                resolving[0] = true;
            }
            nsd.resolveService(info, new NsdManager.ResolveListener() {
                @Override
                public void onResolveFailed(NsdServiceInfo s, int errorCode) {
                    synchronized (queue) { resolving[0] = false; }
                    next[0].run();
                }

                @Override
                public void onServiceResolved(NsdServiceInfo s) {
                    JSObject o = new JSObject();
                    o.put("host", s.getHost() != null ? s.getHost().getHostAddress() : "");
                    o.put("port", s.getPort());
                    o.put("name", s.getServiceName());
                    for (Map.Entry<String, byte[]> e : s.getAttributes().entrySet()) {
                        if (e.getValue() != null) o.put(e.getKey(), new String(e.getValue(), StandardCharsets.UTF_8));
                    }
                    synchronized (queue) {
                        found.put(o);
                        resolving[0] = false;
                    }
                    next[0].run();
                }
            });
        };

        final NsdManager.DiscoveryListener listener = new NsdManager.DiscoveryListener() {
            @Override public void onStartDiscoveryFailed(String type, int errorCode) {}
            @Override public void onStopDiscoveryFailed(String type, int errorCode) {}
            @Override public void onDiscoveryStarted(String type) {}
            @Override public void onDiscoveryStopped(String type) {}
            @Override public void onServiceLost(NsdServiceInfo info) {}

            @Override
            public void onServiceFound(NsdServiceInfo info) {
                synchronized (queue) {
                    if (!seen.add(info.getServiceName())) return;
                    queue.add(info);
                }
                next[0].run();
            }
        };

        try {
            nsd.discoverServices("_musich._tcp", NsdManager.PROTOCOL_DNS_SD, listener);
        } catch (Exception e) {
            if (lock != null) lock.release();
            call.reject("Поиск в сети не запустился: " + e.getMessage());
            return;
        }

        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            synchronized (queue) { done[0] = true; }
            try {
                nsd.stopServiceDiscovery(listener);
            } catch (Exception ignored) {
                // уже остановлен
            }
            if (lock != null) lock.release();
            JSObject ret = new JSObject();
            synchronized (queue) { ret.put("servers", found); }
            call.resolve(ret);
        }, timeout);
    }
}
