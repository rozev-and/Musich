// Файлы для кода устройства (web/src/lib/device.ts) — то же, что на телефоне делают @capacitor/filesystem
// и свой плагин MusicStore. Путь — либо относительный к папке (EXTERNAL, CACHE), либо file://-адрес или абсолютный
// (так приходят файлы из «Музыка\MUSICH» и своей папки)

use crate::Dirs;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures_util::StreamExt;
use serde::Serialize;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncWriteExt;

type R<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn from_uri(s: &str) -> Option<PathBuf> {
    if s.starts_with("file:") {
        return url::Url::parse(s).ok()?.to_file_path().ok();
    }
    let p = Path::new(s);
    p.is_absolute().then(|| p.to_path_buf())
}

pub fn to_uri(p: &Path) -> String {
    url::Url::from_file_path(p).map(|u| u.to_string()).unwrap_or_default()
}

/// Относительный путь — только внутрь папки: «..» и диски в нём не пропускаем
fn resolve(d: &Dirs, dir: Option<&str>, path: &str) -> R<PathBuf> {
    if let Some(p) = from_uri(path) {
        return Ok(p);
    }
    let base = match dir {
        Some("EXTERNAL") | Some("EXTERNAL_STORAGE") | Some("DOCUMENTS") => &d.external,
        Some("CACHE") => &d.cache,
        _ => &d.data,
    };
    let rel = Path::new(path);
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("путь не внутри папки: {path}"));
    }
    Ok(base.join(rel))
}

fn parent_dirs(p: &Path) -> R<()> {
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    Ok(())
}

/// Переложить файл: на одном диске — переименованием, на другой — копией и удалением
fn move_file(from: &Path, to: &Path) -> R<()> {
    parent_dirs(to)?;
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to).map_err(err)?;
    std::fs::remove_file(from).map_err(err)
}

#[tauri::command]
pub fn fs_write(dirs: State<Dirs>, path: String, dir: Option<String>, data: String, utf8: bool, append: bool) -> R<String> {
    let p = resolve(&dirs, dir.as_deref(), &path)?;
    parent_dirs(&p)?;
    let bytes = if utf8 { data.into_bytes() } else { B64.decode(data.as_bytes()).map_err(err)? };
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(&p)
        .map_err(err)?;
    f.write_all(&bytes).map_err(err)?;
    Ok(to_uri(&p))
}

#[tauri::command]
pub fn fs_read(dirs: State<Dirs>, path: String, dir: Option<String>, utf8: bool) -> R<String> {
    let p = resolve(&dirs, dir.as_deref(), &path)?;
    if utf8 {
        std::fs::read_to_string(&p).map_err(err)
    } else {
        Ok(B64.encode(std::fs::read(&p).map_err(err)?))
    }
}

#[tauri::command]
pub fn fs_delete(dirs: State<Dirs>, path: String, dir: Option<String>) -> R<()> {
    std::fs::remove_file(resolve(&dirs, dir.as_deref(), &path)?).map_err(err)
}

#[tauri::command]
pub fn fs_mkdir(dirs: State<Dirs>, path: String, dir: Option<String>) -> R<()> {
    std::fs::create_dir_all(resolve(&dirs, dir.as_deref(), &path)?).map_err(err)
}

#[tauri::command]
pub fn fs_rmdir(dirs: State<Dirs>, path: String, dir: Option<String>, recursive: bool) -> R<()> {
    let p = resolve(&dirs, dir.as_deref(), &path)?;
    if recursive { std::fs::remove_dir_all(p) } else { std::fs::remove_dir(p) }.map_err(err)
}

#[tauri::command]
pub fn fs_move(dirs: State<Dirs>, from: String, to: String, dir: Option<String>, to_dir: Option<String>, copy: bool) -> R<()> {
    let a = resolve(&dirs, dir.as_deref(), &from)?;
    let b = resolve(&dirs, to_dir.as_deref(), &to)?;
    if copy {
        parent_dirs(&b)?;
        std::fs::copy(a, b).map(|_| ()).map_err(err)
    } else {
        move_file(&a, &b)
    }
}

#[derive(Serialize)]
pub struct Stat {
    r#type: &'static str,
    size: u64,
    mtime: u64,
    uri: String,
}

#[tauri::command]
pub fn fs_stat(dirs: State<Dirs>, path: String, dir: Option<String>) -> R<Stat> {
    let p = resolve(&dirs, dir.as_deref(), &path)?;
    let m = std::fs::metadata(&p).map_err(err)?;
    let mtime = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
    Ok(Stat { r#type: if m.is_dir() { "directory" } else { "file" }, size: m.len(), mtime, uri: to_uri(&p) })
}

#[tauri::command]
pub fn fs_uri(dirs: State<Dirs>, path: String, dir: Option<String>) -> R<String> {
    Ok(to_uri(&resolve(&dirs, dir.as_deref(), &path)?))
}

#[derive(Clone, Serialize)]
pub struct Progress {
    bytes: u64,
    total: u64,
}

/// Скачать в файл потоком: сначала во временный «.dl», готовый — на место (оборванное не притворяется целым)
#[tauri::command]
pub async fn fs_download(dirs: State<'_, Dirs>, url: String, path: String, dir: Option<String>, on_progress: Channel<Progress>) -> R<String> {
    let p = resolve(&dirs, dir.as_deref(), &path)?;
    parent_dirs(&p)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(err)?;
    let res = client.get(&url).send().await.map_err(err)?;
    if !res.status().is_success() {
        return Err(format!("сервер ответил {}", res.status()));
    }
    let total = res.content_length().unwrap_or(0);
    let tmp = p.with_extension("dl");
    let mut f = tokio::fs::File::create(&tmp).await.map_err(err)?;
    let mut bytes = 0u64;
    let mut told = 0u64;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(err)?;
        f.write_all(&chunk).await.map_err(err)?;
        bytes += chunk.len() as u64;
        if bytes - told >= 256 * 1024 {
            told = bytes;
            let _ = on_progress.send(Progress { bytes, total });
        }
    }
    f.flush().await.map_err(err)?;
    drop(f);
    let _ = on_progress.send(Progress { bytes, total });
    let _ = std::fs::remove_file(&p);
    std::fs::rename(&tmp, &p).map_err(err)?;
    Ok(to_uri(&p))
}

/// Своя папка: её файлы плеер берёт по asset-протоколу — разрешаем ей (общая «Музыка\MUSICH» разрешена в настройках)
#[tauri::command]
pub fn allow_dir(app: AppHandle, uri: String) -> R<()> {
    let p = from_uri(&uri).ok_or("не путь")?;
    app.asset_protocol_scope().allow_directory(p, true).map_err(err)
}

// ---------- MusicStore: где лежит музыка ----------

#[derive(Serialize)]
pub struct Shared {
    path: String,
    app: String,
    #[serde(rename = "canRead")]
    can_read: bool,
    free: Option<u64>,
    total: Option<u64>,
}

#[tauri::command]
pub fn store_shared(dirs: State<Dirs>) -> Shared {
    let at = dirs.external.clone();
    Shared {
        path: dirs.shared.to_string_lossy().into(),
        app: at.join("MUSICH").to_string_lossy().into(),
        can_read: true,
        free: fs2::available_space(&at).ok(),
        total: fs2::total_space(&at).ok(),
    }
}

#[derive(Serialize)]
pub struct Picked {
    uri: Option<String>,
    name: Option<String>,
}

/// «Своя папка»: окно выбора папки Windows
#[tauri::command]
pub async fn store_pick(app: AppHandle) -> R<Picked> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(Picked { uri: None, name: None });
    };
    let p = picked.into_path().map_err(err)?;
    app.asset_protocol_scope().allow_directory(&p, true).map_err(err)?;
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string_lossy().into_owned());
    Ok(Picked { uri: Some(to_uri(&p)), name: Some(name) })
}

fn target_dir(dirs: &Dirs, target: &str, tree: Option<&str>) -> R<PathBuf> {
    match target {
        "app" => Ok(dirs.external.join("MUSICH").join("Music")),
        "shared" => Ok(dirs.shared.clone()),
        "tree" => tree.and_then(from_uri).ok_or_else(|| "своя папка не выбрана".to_string()),
        _ => Err(format!("нет такого места: {target}")),
    }
}

#[derive(Serialize)]
pub struct Moved {
    uri: String,
    size: u64,
}

#[tauri::command]
pub fn store_move(app: AppHandle, dirs: State<Dirs>, from: String, target: String, tree: Option<String>, name: String) -> R<Moved> {
    let a = from_uri(&from).ok_or("не путь")?;
    if name.contains(['/', '\\']) || name == ".." {
        return Err("плохое имя".into());
    }
    let dir = target_dir(&dirs, &target, tree.as_deref())?;
    if target == "tree" {
        app.asset_protocol_scope().allow_directory(&dir, true).map_err(err)?;
    }
    let b = dir.join(&name);
    if a != b {
        move_file(&a, &b)?;
    }
    let size = std::fs::metadata(&b).map_err(err)?.len();
    Ok(Moved { uri: to_uri(&b), size })
}

#[derive(Serialize)]
pub struct Renamed {
    uri: String,
}

#[tauri::command]
pub fn store_rename(uri: String, name: String) -> R<Renamed> {
    let a = from_uri(&uri).ok_or("не путь")?;
    if name.contains(['/', '\\']) || name == ".." {
        return Err("плохое имя".into());
    }
    let b = a.with_file_name(&name);
    move_file(&a, &b)?;
    Ok(Renamed { uri: to_uri(&b) })
}

#[tauri::command]
pub fn store_remove(uri: String) -> R<()> {
    std::fs::remove_file(from_uri(&uri).ok_or("не путь")?).map_err(err)
}

#[derive(Serialize)]
pub struct Exists {
    exists: bool,
    size: u64,
}

#[tauri::command]
pub fn store_stat(uri: String) -> Exists {
    match from_uri(&uri).and_then(|p| std::fs::metadata(p).ok()) {
        Some(m) => Exists { exists: true, size: m.len() },
        None => Exists { exists: false, size: 0 },
    }
}

#[derive(Serialize)]
pub struct Listed {
    name: String,
    size: u64,
    uri: String,
}

#[derive(Serialize)]
pub struct List {
    files: Vec<Listed>,
}

#[tauri::command]
pub fn store_list(app: AppHandle, dirs: State<Dirs>, target: String, tree: Option<String>) -> R<List> {
    let dir = target_dir(&dirs, &target, tree.as_deref())?;
    if target == "tree" {
        app.asset_protocol_scope().allow_directory(&dir, true).map_err(err)?;
    }
    let mut files = vec![];
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let Ok(m) = e.metadata() else { continue };
            if m.is_file() {
                files.push(Listed { name: e.file_name().to_string_lossy().into_owned(), size: m.len(), uri: to_uri(&e.path()) });
            }
        }
    }
    Ok(List { files })
}
