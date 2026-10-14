//! Debug Adapter Protocol host. Mirrors src/main/dap.ts: starts an adapter on
//! stdio and relays framed JSON; the renderer owns the protocol.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::tasks::which_path;
use crate::util::{command, err, to_string_lossy, CmdResult};

struct Adapter {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct DapState {
    adapters: Arc<Mutex<HashMap<u32, Adapter>>>,
    next: AtomicU32,
}

#[derive(Deserialize)]
pub struct DapAdapterSpec {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    cwd: Option<String>,
    #[serde(default)]
    env: HashMap<String, String>,
}

#[derive(Serialize, Clone)]
struct DapMessage {
    id: u32,
    msg: Value,
}

#[derive(Serialize, Clone)]
struct DapText {
    id: u32,
    data: String,
}

#[derive(Serialize, Clone)]
struct DapExit {
    id: u32,
    code: Option<i32>,
}

/// Reads one `Content-Length` framed message; None at EOF.
fn read_message(r: &mut impl BufRead) -> Option<Vec<u8>> {
    let mut len = None;
    loop {
        let mut line = String::new();
        if r.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let line = line.trim_end();
        if line.is_empty() {
            if len.is_some() {
                break;
            }
            continue;
        }
        if let Some(v) = line
            .split_once(':')
            .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        {
            len = v.1.trim().parse::<usize>().ok();
        }
    }
    let mut body = vec![0u8; len?];
    r.read_exact(&mut body).ok()?;
    Some(body)
}

#[tauri::command]
pub fn dap_start(
    app: AppHandle,
    state: State<'_, DapState>,
    spec: DapAdapterSpec,
) -> CmdResult<u32> {
    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    let program = which_path(&spec.command)
        .map(|p| to_string_lossy(&p))
        .unwrap_or_else(|| spec.command.clone());
    let mut cmd = command(&program);
    cmd.args(&spec.args)
        .envs(&spec.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = spec.cwd.as_deref().filter(|c| !c.is_empty()) {
        cmd.current_dir(cwd);
    }
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("{}: не найден", spec.command)
        } else {
            err(e)
        }
    })?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    state
        .adapters
        .lock()
        .map_err(err)?
        .insert(id, Adapter { child, stdin });

    {
        let app = app.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = stderr.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                let _ = app.emit("dap:stderr", DapText { id, data });
            }
        });
    }
    let adapters = state.adapters.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Some(body) = read_message(&mut reader) {
            if let Ok(msg) = serde_json::from_slice::<Value>(&body) {
                let _ = app.emit("dap:message", DapMessage { id, msg });
            }
        }
        let code = adapters
            .lock()
            .ok()
            .and_then(|mut a| a.remove(&id))
            .and_then(|mut a| a.child.wait().ok())
            .and_then(|s| s.code());
        let _ = app.emit("dap:exit", DapExit { id, code });
    });
    Ok(id)
}

#[tauri::command]
pub fn dap_send(state: State<'_, DapState>, id: u32, msg: Value) -> CmdResult<()> {
    let body = serde_json::to_string(&msg).map_err(err)?;
    let mut adapters = state.adapters.lock().map_err(err)?;
    let a = adapters
        .get_mut(&id)
        .ok_or("Debug adapter is not running")?;
    write!(a.stdin, "Content-Length: {}\r\n\r\n{}", body.len(), body).map_err(err)?;
    a.stdin.flush().map_err(err)
}

fn kill(a: &mut Adapter) {
    if cfg!(windows) {
        let _ = command("taskkill")
            .args(["/pid", &a.child.id().to_string(), "/T", "/F"])
            .status();
    } else {
        let _ = a.child.kill();
    }
}

#[tauri::command]
pub fn dap_stop(state: State<'_, DapState>, id: u32) {
    if let Ok(mut adapters) = state.adapters.lock() {
        if let Some(a) = adapters.get_mut(&id) {
            kill(a);
        }
    }
}

pub fn stop_all(state: &DapState) {
    if let Ok(mut adapters) = state.adapters.lock() {
        for a in adapters.values_mut() {
            kill(a);
        }
    }
}
