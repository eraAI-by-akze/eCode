//! Background tasks (build/check/test), plugin discovery, PATH lookup and
//! font enumeration. Mirrors src/main/tasks.ts and src/main/shellEnv.ts.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::util::{command, err, resource, to_string_lossy, CmdResult};

#[derive(Default)]
pub struct TaskState {
    tasks: Arc<Mutex<HashMap<u32, Child>>>,
    next: AtomicU32,
}

#[derive(Serialize, Clone)]
struct TaskOutput {
    id: u32,
    data: String,
}

#[derive(Serialize, Clone)]
struct TaskExit {
    id: u32,
    code: Option<i32>,
}

fn shell_command(cmd: &str) -> std::process::Command {
    if cfg!(windows) {
        let mut c = command("cmd");
        c.args(["/C", &format!("chcp 65001>nul & {cmd}")]);
        c
    } else {
        let mut c = command("sh");
        c.args(["-c", cmd]);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Own process group, so Stop kills the whole tree (cargo → rustc …).
            c.process_group(0);
        }
        c
    }
}

#[tauri::command]
pub fn task_run(
    app: AppHandle,
    state: State<'_, TaskState>,
    command: String,
    cwd: String,
) -> CmdResult<u32> {
    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    let mut child = shell_command(&command)
        .current_dir(&cwd)
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .env("CARGO_TERM_COLOR", "never")
        .env("DOTNET_CLI_UI_LANGUAGE", "en")
        .env("DOTNET_NOLOGO", "1")
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(err)?;
    let pipes: Vec<Box<dyn Read + Send>> = vec![
        Box::new(child.stdout.take().ok_or("no stdout")?),
        Box::new(child.stderr.take().ok_or("no stderr")?),
    ];
    state.tasks.lock().map_err(err)?.insert(id, child);

    let open = Arc::new(AtomicU32::new(pipes.len() as u32));
    for mut pipe in pipes {
        let (app, open) = (app.clone(), open.clone());
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                let _ = app.emit("task:output", TaskOutput { id, data });
            }
            open.fetch_sub(1, Ordering::SeqCst);
        });
    }
    // Wait for the process itself, not its pipes: build servers (MSBuild node reuse,
    // Roslyn, Gradle…) inherit them and outlive the build.
    let tasks = state.tasks.clone();
    std::thread::spawn(move || {
        let code = loop {
            let status = match tasks.lock() {
                Ok(mut t) => match t.get_mut(&id) {
                    Some(c) => c.try_wait(),
                    None => break None,
                },
                Err(_) => break None,
            };
            match status {
                Ok(Some(s)) => break s.code(),
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => break None,
            }
        };
        if let Ok(mut t) = tasks.lock() {
            t.remove(&id);
        }
        // Let the readers drain what's already buffered.
        let deadline = Instant::now() + Duration::from_millis(400);
        while open.load(Ordering::SeqCst) > 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = app.emit("task:exit", TaskExit { id, code });
    });
    Ok(id)
}

#[tauri::command]
pub fn task_kill(state: State<'_, TaskState>, id: u32) {
    let Ok(tasks) = state.tasks.lock() else {
        return;
    };
    let Some(child) = tasks.get(&id) else { return };
    let pid = child.id().to_string();
    if cfg!(windows) {
        let _ = command("taskkill")
            .args(["/pid", &pid, "/T", "/F"])
            .status();
    } else {
        let _ = command("kill").args(["-TERM", &format!("-{pid}")]).status();
    }
}

pub fn kill_all(state: &TaskState) {
    if let Ok(mut tasks) = state.tasks.lock() {
        for (_, mut c) in tasks.drain() {
            let _ = c.kill();
        }
    }
}

// ─────────────────────────── tools ───────────────────────────

pub fn which_path(name: &str) -> Option<PathBuf> {
    if name.is_empty() {
        return None;
    }
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
            .split(';')
            .map(|e| e.to_lowercase())
            .collect()
    } else {
        vec![String::new()]
    };
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for ext in &exts {
            let p = dir.join(format!("{name}{ext}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

#[tauri::command]
pub fn which(command: String) -> Option<String> {
    which_path(&command).map(|p| to_string_lossy(&p))
}

/// GUI launches get a minimal PATH; take the login shell's and add the usual tool folders.
pub fn fix_path() {
    if cfg!(windows) {
        return;
    }
    let mut parts: Vec<PathBuf> = Vec::new();
    let shell = std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "macos") {
            "/bin/zsh".into()
        } else {
            "/bin/bash".into()
        }
    });
    let child = std::process::Command::new(&shell)
        .args(["-ilc", "printf '__ECODE_PATH__%s__ECODE_PATH__' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    if let Ok(mut child) = child {
        // Bounded wait: a slow or broken shell rc mustn't block startup.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(30))
                }
                _ => {
                    let _ = child.kill();
                    break;
                }
            }
        }
        let mut out = String::new();
        if let Some(mut so) = child.stdout.take() {
            let _ = so.read_to_string(&mut out);
        }
        if let Some(inner) = out.split("__ECODE_PATH__").nth(1) {
            parts.extend(std::env::split_paths(inner));
        }
    }
    if let Some(cur) = std::env::var_os("PATH") {
        parts.extend(std::env::split_paths(&cur));
    }
    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        for p in [
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            home.join(".cargo/bin"),
            home.join(".dotnet/tools"),
            PathBuf::from("/usr/local/share/dotnet"),
            home.join(".dotnet"),
            home.join(".local/bin"),
        ] {
            if p.is_dir() {
                parts.push(p);
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    parts.retain(|p| seen.insert(p.clone()));
    if let Ok(joined) = std::env::join_paths(parts) {
        std::env::set_var("PATH", joined);
    }
}

// ─────────────────────────── plugins ───────────────────────────

#[derive(Serialize)]
pub struct PluginEntry {
    dir: String,
    builtin: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn user_plugins_dir() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".into());
    let dir = Path::new(&home).join(".ecode").join("plugins");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

#[tauri::command]
pub fn plugins_dir() -> String {
    to_string_lossy(&user_plugins_dir())
}

#[tauri::command]
pub fn plugins_list(app: AppHandle) -> Vec<PluginEntry> {
    let mut out = Vec::new();
    let bases = [
        (resource(&app, "plugins"), true),
        (Some(user_plugins_dir()), false),
    ];
    for (base, builtin) in bases {
        let Some(base) = base else { continue };
        let Ok(rd) = std::fs::read_dir(&base) else {
            continue;
        };
        let mut dirs: Vec<PathBuf> = rd
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.join("plugin.json").is_file())
            .collect();
        dirs.sort();
        for dir in dirs {
            let parsed = std::fs::read_to_string(dir.join("plugin.json"))
                .map_err(|e| e.to_string())
                .and_then(|s| serde_json::from_str::<Value>(&s).map_err(|e| e.to_string()));
            let (manifest, error) = match parsed {
                Ok(v) => (Some(v), None),
                Err(e) => (None, Some(e)),
            };
            out.push(PluginEntry {
                dir: to_string_lossy(&dir),
                builtin,
                manifest,
                error,
            });
        }
    }
    out
}

// ─────────────────────────── fonts ───────────────────────────

#[tauri::command]
pub async fn list_fonts() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        let mut names: Vec<String> = db
            .faces()
            .filter_map(|f| f.families.first().map(|(n, _)| n.clone()))
            .collect();
        names.sort();
        names.dedup();
        names
    })
    .await
    .unwrap_or_default()
}
