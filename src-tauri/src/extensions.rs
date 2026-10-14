//! VS Code / VSCodium extensions (.vsix = zip with an extension/ folder) and
//! the small HTTP helpers the gallery needs. Mirrors src/main/extensions.ts.

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::tasks::home;
use crate::util::{err, to_string_lossy, CmdResult};

#[derive(Serialize)]
pub struct ExtensionFolder {
    dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    nls: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn base_dir() -> PathBuf {
    let dir = Path::new(&home()).join(".ecode").join("extensions");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

fn read_folder(dir: &Path) -> ExtensionFolder {
    let d = to_string_lossy(dir);
    let Some(manifest) = read_json(&dir.join("package.json")) else {
        return ExtensionFolder {
            dir: d,
            manifest: None,
            nls: None,
            error: Some("нет package.json".into()),
        };
    };
    let mut nls = Map::new();
    for name in ["package.nls.json", "package.nls.ru.json"] {
        if let Some(Value::Object(m)) = read_json(&dir.join(name)) {
            nls.extend(m);
        }
    }
    ExtensionFolder {
        dir: d,
        manifest: Some(manifest),
        nls: Some(Value::Object(nls)),
        error: None,
    }
}

#[tauri::command]
pub fn ext_dir() -> String {
    to_string_lossy(&base_dir())
}

#[tauri::command]
pub async fn ext_list() -> Vec<ExtensionFolder> {
    tauri::async_runtime::spawn_blocking(|| {
        let Ok(rd) = std::fs::read_dir(base_dir()) else {
            return Vec::new();
        };
        rd.flatten()
            .filter(|e| e.path().is_dir() && !e.file_name().to_string_lossy().starts_with('.'))
            .map(|e| read_folder(&e.path()))
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Content sniffing for binaries whose exec bit the archive didn't carry.
fn looks_executable(data: &[u8]) -> bool {
    data.starts_with(b"\x7fELF")
        || data.starts_with(&[0xcf, 0xfa, 0xed, 0xfe])
        || data.starts_with(&[0xca, 0xfe, 0xba, 0xbe])
        || data.starts_with(b"#!")
}

fn install_blocking(vsix: &str) -> CmdResult<ExtensionFolder> {
    let file = std::fs::File::open(vsix).map_err(err)?;
    let mut zip = zip::ZipArchive::new(file).map_err(err)?;
    let pkg: Value = {
        let mut entry = zip
            .by_name("extension/package.json")
            .map_err(|_| "Это не расширение VS Code: в .vsix нет extension/package.json")?;
        let mut text = String::new();
        entry.read_to_string(&mut text).map_err(err)?;
        serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(err)?
    };
    let name = pkg["name"]
        .as_str()
        .ok_or("В package.json нет имени расширения")?;
    let publisher = pkg["publisher"].as_str().unwrap_or("unknown");
    let version = pkg["version"].as_str().unwrap_or("0.0.0");
    let id = format!("{publisher}.{name}").to_lowercase();
    let base = base_dir();
    let target = base.join(format!("{id}-{version}"));
    // Replace any installed version of the same extension.
    if let Ok(rd) = std::fs::read_dir(&base) {
        for e in rd.flatten() {
            if e.file_name()
                .to_string_lossy()
                .to_lowercase()
                .starts_with(&format!("{id}-"))
            {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    let staging = base.join(format!("{id}-{version}.part"));
    let _ = std::fs::remove_dir_all(&staging);
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(err)?;
        let Some(path) = entry.enclosed_name() else {
            continue;
        };
        let Ok(rel) = path.strip_prefix("extension") else {
            continue;
        };
        if rel.as_os_str().is_empty()
            || entry.is_dir()
            || rel.components().any(|c| !matches!(c, Component::Normal(_)))
        {
            continue;
        }
        let out = staging.join(rel);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(err)?;
        }
        let mut data = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut data).map_err(err)?;
        std::fs::write(&out, &data).map_err(err)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let exec = entry.unix_mode().map(|m| m & 0o111 != 0).unwrap_or(false)
                || looks_executable(&data);
            let _ = std::fs::set_permissions(
                &out,
                std::fs::Permissions::from_mode(if exec { 0o755 } else { 0o644 }),
            );
        }
        #[cfg(not(unix))]
        let _ = looks_executable(&data);
    }
    std::fs::rename(&staging, &target).map_err(err)?;
    Ok(read_folder(&target))
}

#[tauri::command]
pub async fn ext_install(vsix: String) -> CmdResult<ExtensionFolder> {
    tauri::async_runtime::spawn_blocking(move || install_blocking(&vsix))
        .await
        .map_err(err)?
}

#[tauri::command]
pub fn ext_uninstall(dir: String) -> CmdResult<()> {
    let base = base_dir().canonicalize().map_err(err)?;
    let dir = Path::new(&dir).canonicalize().map_err(err)?;
    if dir == base || !dir.starts_with(&base) {
        return Err("Папка вне каталога расширений".into());
    }
    std::fs::remove_dir_all(dir).map_err(err)
}

fn agent(url: &str) -> CmdResult<ureq::Agent> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Разрешены только http(s)-адреса".into());
    }
    let tls = native_tls::TlsConnector::new().map_err(err)?;
    let local = ["://localhost", "://127.0.0.1", "://[::1]"]
        .iter()
        .any(|h| url.contains(h));
    Ok(ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(120))
        .tls_connector(Arc::new(tls))
        // HTTPS_PROXY & co., except for local addresses.
        .try_proxy_from_env(!local)
        .user_agent("eCode")
        .build())
}

#[tauri::command]
pub async fn net_get(url: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        agent(&url)?
            .get(&url)
            .set("Accept", "application/json, */*")
            .call()
            .map_err(err)?
            .into_string()
            .map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn net_download(url: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let res = agent(&url)?.get(&url).call().map_err(err)?;
        let mut data = Vec::new();
        res.into_reader()
            .take(512 * 1024 * 1024)
            .read_to_end(&mut data)
            .map_err(err)?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("ecode-{stamp}.vsix"));
        std::fs::write(&path, data).map_err(err)?;
        Ok(to_string_lossy(&path))
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn data_url(path: String) -> Option<String> {
    let ext = Path::new(&path)
        .extension()?
        .to_string_lossy()
        .to_lowercase();
    let mime = match ext.as_str() {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        _ => return None,
    };
    let meta = std::fs::metadata(&path).ok()?;
    if meta.len() > 2 * 1024 * 1024 {
        return None;
    }
    let data = std::fs::read(&path).ok()?;
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(data)
    ))
}
