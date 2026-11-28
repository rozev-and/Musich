// Поиск MUSICH в домашней сети: сервер объявляет себя по mDNS (_musich._tcp, server/src/discovery.ts),
// в TXT — node, name и все адреса. Ответ — как у плагина Discovery на телефоне (web/src/lib/discovery.ts)

use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::Serialize;
use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Serialize)]
pub struct Found {
    host: String,
    port: u16,
    name: Option<String>,
    node: Option<String>,
    addr: Option<String>,
}

#[derive(Serialize)]
pub struct Servers {
    servers: Vec<Found>,
}

fn browse(timeout: Duration) -> Result<Vec<Found>, String> {
    let mdns = ServiceDaemon::new().map_err(|e| e.to_string())?;
    let rx = mdns.browse("_musich._tcp.local.").map_err(|e| e.to_string())?;
    let until = Instant::now() + timeout;
    let mut found: HashMap<String, Found> = HashMap::new();
    while let Some(left) = until.checked_duration_since(Instant::now()) {
        let Ok(ev) = rx.recv_timeout(left) else { break };
        if let ServiceEvent::ServiceResolved(info) = ev {
            let mut ips: Vec<String> = info.get_addresses().iter().filter(|a| a.is_ipv4()).map(|a| a.to_string()).collect();
            ips.sort();
            let Some(host) = ips.first().cloned() else { continue };
            let txt = |k: &str| info.get_property_val_str(k).map(str::to_string);
            let addr = txt("addr").or_else(|| Some(ips.join(",")));
            found.insert(
                info.get_fullname().to_string(),
                Found { host, port: info.get_port(), name: txt("name"), node: txt("node"), addr },
            );
        }
    }
    let _ = mdns.shutdown();
    Ok(found.into_values().collect())
}

#[tauri::command]
pub async fn discover(timeout_ms: u64) -> Result<Servers, String> {
    let t = Duration::from_millis(timeout_ms.clamp(500, 10_000));
    let servers = tauri::async_runtime::spawn_blocking(move || browse(t)).await.map_err(|e| e.to_string())??;
    Ok(Servers { servers })
}
