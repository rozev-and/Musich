package app.musich;

import android.Manifest;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Где лежит музыка на телефоне (Настройки → «Где хранить музыку»):
 *  app    — папка приложения (Android/data/app.musich/files/MUSICH): удаляется вместе с приложением;
 *  shared — общая папка «Музыка/MUSICH»: остаётся после удаления, после переустановки подхватывается (нужно чтение аудио);
 *  tree   — своя папка, выбранная в системном окне (SAF): остаётся всегда.
 * Скачивает приложение всегда в свою папку, а сюда файл переносится уже целым (copy) — так оборванная загрузка
 * не оставляет обрывков в общей папке. Обложки остаются в папке приложения: это кэш
 */
@CapacitorPlugin(
    name = "MusicStore",
    permissions = {
        @Permission(alias = "audio", strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE }),
    }
)
public class MusicStorePlugin extends Plugin {

    private File sharedDir() {
        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), "MUSICH");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private File appDir() {
        File base = getContext().getExternalFilesDir(null);
        File dir = new File(base, "MUSICH/Music");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private String alias() {
        return Build.VERSION.SDK_INT >= 33 ? "audio" : "storage";
    }

    /** Общая папка: где она и можно ли читать чужие (оставшиеся от прошлой установки) файлы */
    @PluginMethod
    public void shared(PluginCall call) {
        JSObject r = new JSObject();
        r.put("path", sharedDir().getAbsolutePath());
        r.put("app", appDir().getAbsolutePath());
        r.put("canRead", getPermissionState(alias()) == PermissionState.GRANTED);
        // место на телефоне (раздел с данными) — для «Экосистемы» на странице сервера
        android.os.StatFs fs = new android.os.StatFs(Environment.getDataDirectory().getAbsolutePath());
        r.put("free", fs.getAvailableBytes());
        r.put("total", fs.getTotalBytes());
        call.resolve(r);
    }

    /** Разрешение читать музыку: без него после переустановки приложение не увидит оставленные файлы */
    @PluginMethod
    public void requestRead(PluginCall call) {
        if (getPermissionState(alias()) == PermissionState.GRANTED) {
            JSObject r = new JSObject();
            r.put("granted", true);
            call.resolve(r);
            return;
        }
        requestPermissionForAlias(alias(), call, "readResult");
    }

    @PermissionCallback
    private void readResult(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", getPermissionState(alias()) == PermissionState.GRANTED);
        call.resolve(r);
    }

    /** Системное окно выбора папки; доступ к ней сохраняется и после перезапуска */
    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, i, "pickResult");
    }

    @ActivityCallback
    private void pickResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (data == null || data.getData() == null) {
            call.resolve(new JSObject()); // передумали
            return;
        }
        Uri tree = data.getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (SecurityException e) {
            call.reject("Нет доступа к папке");
            return;
        }
        JSObject r = new JSObject();
        r.put("uri", tree.toString());
        r.put("name", displayName(DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))));
        call.resolve(r);
    }

    /** Перенести файл: from — file:// или content://, target — app | shared | tree. Старый файл удаляется */
    @PluginMethod
    public void move(PluginCall call) {
        String from = call.getString("from");
        String target = call.getString("target", "app");
        String name = call.getString("name");
        if (from == null || name == null) {
            call.reject("Нужны from и name");
            return;
        }
        Uri src = Uri.parse(from);
        Uri dst = null;
        try (InputStream in = open(src)) {
            if ("tree".equals(target)) {
                Uri tree = Uri.parse(call.getString("tree", ""));
                Uri dir = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
                Uri old = findChild(tree, name);
                if (old != null) DocumentsContract.deleteDocument(getContext().getContentResolver(), old);
                dst = DocumentsContract.createDocument(getContext().getContentResolver(), dir, mime(name), name);
                if (dst == null) throw new IOException("Не удалось создать файл в папке");
                try (OutputStream out = getContext().getContentResolver().openOutputStream(dst)) {
                    copy(in, out);
                }
            } else {
                File f = new File("shared".equals(target) ? sharedDir() : appDir(), name);
                try (OutputStream out = new FileOutputStream(f)) {
                    copy(in, out);
                }
                dst = Uri.fromFile(f);
            }
        } catch (Exception e) {
            if (dst != null) remove(dst);
            call.reject("Не удалось перенести: " + e.getMessage());
            return;
        }
        if (!src.equals(dst)) remove(src);
        JSObject r = new JSObject();
        r.put("uri", dst.toString());
        r.put("size", size(dst));
        call.resolve(r);
    }

    /** Переименовать на месте (трек с телефона ушёл на сервер — файл получает серверное имя), без копирования */
    @PluginMethod
    public void rename(PluginCall call) {
        Uri u = Uri.parse(call.getString("uri", ""));
        String name = call.getString("name");
        if (name == null) {
            call.reject("Нужно name");
            return;
        }
        try {
            Uri out;
            if ("file".equals(u.getScheme())) {
                File f = new File(u.getPath());
                File to = new File(f.getParentFile(), name);
                if (to.exists() && !to.equals(f)) to.delete();
                if (!f.renameTo(to)) throw new IOException("renameTo");
                out = Uri.fromFile(to);
            } else {
                Uri r = DocumentsContract.renameDocument(getContext().getContentResolver(), u, name);
                out = r != null ? r : u;
            }
            JSObject res = new JSObject();
            res.put("uri", out.toString());
            call.resolve(res);
        } catch (Exception e) {
            call.reject("Не удалось переименовать: " + e.getMessage());
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String uri = call.getString("uri");
        if (uri != null) remove(Uri.parse(uri));
        call.resolve();
    }

    /** Есть ли файл и какого размера (проверка скачанного) */
    @PluginMethod
    public void stat(PluginCall call) {
        Uri u = Uri.parse(call.getString("uri", ""));
        JSObject r = new JSObject();
        long s = size(u);
        r.put("exists", s >= 0);
        r.put("size", Math.max(s, 0));
        call.resolve(r);
    }

    /** Что уже лежит в папке (target shared | tree): после переустановки так подхватываем оставленную музыку */
    @PluginMethod
    public void list(PluginCall call) {
        String target = call.getString("target", "shared");
        JSArray out = new JSArray();
        if ("tree".equals(target)) {
            Uri tree = Uri.parse(call.getString("tree", ""));
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
            String[] cols = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_SIZE };
            try (Cursor c = getContext().getContentResolver().query(children, cols, null, null, null)) {
                while (c != null && c.moveToNext()) {
                    JSObject o = new JSObject();
                    o.put("name", c.getString(1));
                    o.put("size", c.getLong(2));
                    o.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0)).toString());
                    out.put(o);
                }
            } catch (Exception ignored) {
                // доступ к папке пропал — пусто
            }
        } else {
            File[] files = sharedDir().listFiles();
            if (files != null)
                for (File f : files) {
                    if (!f.isFile()) continue;
                    JSObject o = new JSObject();
                    o.put("name", f.getName());
                    o.put("size", f.length());
                    o.put("uri", Uri.fromFile(f).toString());
                    out.put(o);
                }
        }
        JSObject r = new JSObject();
        r.put("files", out);
        call.resolve(r);
    }

    // ---------- помощники ----------

    private InputStream open(Uri u) throws IOException {
        if ("file".equals(u.getScheme())) return new FileInputStream(new File(u.getPath()));
        InputStream in = getContext().getContentResolver().openInputStream(u);
        if (in == null) throw new IOException("Файл не открывается");
        return in;
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        if (out == null) throw new IOException("Некуда писать");
        byte[] buf = new byte[256 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    private void remove(Uri u) {
        try {
            if ("file".equals(u.getScheme())) new File(u.getPath()).delete();
            else DocumentsContract.deleteDocument(getContext().getContentResolver(), u);
        } catch (Exception ignored) {
            // уже нет — тоже хорошо
        }
    }

    /** Размер файла, -1 — нет такого */
    private long size(Uri u) {
        if ("file".equals(u.getScheme())) {
            File f = new File(u.getPath());
            return f.exists() ? f.length() : -1;
        }
        try (Cursor c = getContext().getContentResolver().query(u, new String[] { OpenableColumns.SIZE }, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getLong(0);
        } catch (Exception ignored) {
            // нет доступа или файла
        }
        return -1;
    }

    private Uri findChild(Uri tree, String name) {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
        String[] cols = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME };
        try (Cursor c = getContext().getContentResolver().query(children, cols, null, null, null)) {
            while (c != null && c.moveToNext()) if (name.equals(c.getString(1))) return DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0));
        } catch (Exception ignored) {
            // нет доступа
        }
        return null;
    }

    private String displayName(Uri doc) {
        ContentResolver cr = getContext().getContentResolver();
        try (Cursor c = cr.query(doc, new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {
            // без имени — покажем адрес
        }
        return doc.getLastPathSegment();
    }

    private static String mime(String name) {
        int dot = name.lastIndexOf('.');
        String ext = dot >= 0 ? name.substring(dot + 1).toLowerCase() : "";
        String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return m != null ? m : "audio/*";
    }
}
