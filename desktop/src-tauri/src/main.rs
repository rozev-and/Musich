// MUSICH для ПК: своё окно (WebView2) с интерфейсом в режиме устройства — своя копия музыки и библиотеки,
// как у телефона; с сервером синхронизируется, когда он доступен. Интерфейс — web/ (--mode desktop),
// вызовы Capacitor подменяет web/src/platform/desktop и шлёт сюда.
//
// Здесь: файлы (папка приложения, «Музыка\MUSICH», своя папка), скачивание, поиск сервера в сети (mDNS),
// номер и имя устройства, запасная копия настроек, значок в трее (закрыл окно — музыка играет дальше).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod fs;
mod net;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};

/// Папки приложения
pub struct Dirs {
    /// папка приложения (на телефоне — Android/data/…/files): там MUSICH\Music, Covers, library.json
    pub external: PathBuf,
    /// временная: «Поделиться», картинки итогов
    pub cache: PathBuf,
    /// служебное: номер устройства, запасные настройки
    pub data: PathBuf,
    /// общая папка «Музыка\MUSICH» — переживает удаление приложения
    pub shared: PathBuf,
}

struct Prefs(Mutex<BTreeMap<String, String>>);

fn prefs_file(d: &Dirs) -> PathBuf {
    d.data.join("prefs.json")
}

fn save_prefs(d: &Dirs, p: &BTreeMap<String, String>) -> Result<(), String> {
    let s = serde_json::to_string(p).map_err(|e| e.to_string())?;
    std::fs::write(prefs_file(d), s).map_err(|e| e.to_string())
}

#[tauri::command]
fn prefs_get(prefs: State<Prefs>, key: String) -> Option<String> {
    prefs.0.lock().unwrap().get(&key).cloned()
}

#[tauri::command]
fn prefs_set(prefs: State<Prefs>, dirs: State<Dirs>, key: String, value: String) -> Result<(), String> {
    let mut p = prefs.0.lock().unwrap();
    p.insert(key, value);
    save_prefs(&dirs, &p)
}

#[tauri::command]
fn prefs_remove(prefs: State<Prefs>, dirs: State<Dirs>, key: String) -> Result<(), String> {
    let mut p = prefs.0.lock().unwrap();
    p.remove(&key);
    save_prefs(&dirs, &p)
}

#[tauri::command]
fn prefs_keys(prefs: State<Prefs>) -> Vec<String> {
    prefs.0.lock().unwrap().keys().cloned().collect()
}

/// Постоянный номер установки: по нему сервер узнаёт этот ПК, а не заводит новый после переустановки интерфейса
#[tauri::command]
fn device_id(dirs: State<Dirs>) -> Result<String, String> {
    let f = dirs.data.join("device-id");
    if let Ok(id) = std::fs::read_to_string(&f) {
        let id = id.trim().to_string();
        if id.len() >= 4 {
            return Ok(id);
        }
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    std::fs::write(&f, &id).map_err(|e| e.to_string())?;
    Ok(id)
}

/// Как назвать ПК на сервере: имя компьютера в Windows
#[tauri::command]
fn device_name() -> String {
    gethostname::gethostname().to_string_lossy().trim().to_string()
}

/// «Поделиться» на ПК: показать файл в Проводнике
#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(format!("/select,{}", path.replace('/', "\\")))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Подписи пунктов в трее — на языке интерфейса (его знает только страница)
#[tauri::command]
fn tray_labels(app: AppHandle, show: String, quit: String) -> Result<(), String> {
    let menu = tray_menu(&app, &show, &quit).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn tray_menu(app: &AppHandle, show: &str, quit: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItem::with_id(app, "show", show, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", quit, true, None::<&str>)?;
    Menu::with_items(app, &[&show, &quit])
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        // второй запуск — открываем уже работающий: два MUSICH с одним журналом перепутали бы события
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let path = app.path();
            let external = path.app_local_data_dir()?;
            let dirs = Dirs {
                cache: path.temp_dir()?.join("MUSICH"),
                data: external.join("app"),
                shared: path.audio_dir().unwrap_or_else(|_| external.clone()).join("MUSICH"),
                external,
            };
            for d in [&dirs.external, &dirs.cache, &dirs.data] {
                std::fs::create_dir_all(d)?;
            }
            let _ = app.asset_protocol_scope().allow_directory(&dirs.cache, true);
            let prefs: BTreeMap<String, String> = std::fs::read_to_string(prefs_file(&dirs))
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            app.manage(Prefs(Mutex::new(prefs)));
            app.manage(dirs);

            let handle = app.handle().clone();
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().ok_or("нет значка")?)
                .tooltip("MUSICH")
                .menu(&tray_menu(&handle, "MUSICH", "Выход")?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id().as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        // крестик прячет окно в трей: музыка играет дальше. Выйти — «Выход» в трее
        .on_window_event(|w, e| {
            if let WindowEvent::CloseRequested { api, .. } = e {
                api.prevent_close();
                let _ = w.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            prefs_get,
            prefs_set,
            prefs_remove,
            prefs_keys,
            device_id,
            device_name,
            reveal,
            tray_labels,
            fs::fs_write,
            fs::fs_read,
            fs::fs_delete,
            fs::fs_mkdir,
            fs::fs_rmdir,
            fs::fs_move,
            fs::fs_stat,
            fs::fs_uri,
            fs::fs_download,
            fs::allow_dir,
            fs::store_shared,
            fs::store_pick,
            fs::store_move,
            fs::store_rename,
            fs::store_remove,
            fs::store_stat,
            fs::store_list,
            net::discover,
        ])
        .run(tauri::generate_context!())
        .expect("MUSICH не запустился");
}
