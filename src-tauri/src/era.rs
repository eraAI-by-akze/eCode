//! Runs resources/era/bridge.py (the eraCore agent) in the user's Python and
//! relays its JSON lines as `era:event`. Mirrors src/main/era.ts.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::util::{command, err, resource, CmdResult};

struct Bridge {
    child: Child,
    stdin: ChildStdin,
    token: u64,
}

#[derive(Default)]
pub struct EraState {
    bridge: Arc<Mutex<Option<Bridge>>>,
}

static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[derive(Serialize, Clone)]
pub struct PythonInfo {
    path: String,
    version: String,
    eracore: bool,
}

fn candidates(preferred: &str) -> Vec<String> {
    let mut list = Vec::new();
    if !preferred.trim().is_empty() {
        list.push(preferred.trim().to_string());
    }
    let defaults: &[&str] = if cfg!(windows) {
        &["py", "python", "python3"]
    } else {
        &["python3", "python"]
    };
    list.extend(defaults.iter().map(|s| s.to_string()));
    list
}

fn python_args(python: &str) -> Vec<&'static str> {
    if python == "py" {
        vec!["-3"]
    } else {
        vec![]
    }
}

fn probe(python: &str) -> Option<PythonInfo> {
    let out = command(python)
        .args(python_args(python))
        .args(["-c", "import sys, importlib.util as u; print(sys.version.split()[0]); print(1 if u.find_spec('eraCore') else 0)"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut it = text.lines();
    let version = it.next()?.trim().to_string();
    let eracore = it.next().map(|l| l.trim() == "1").unwrap_or(false);
    Some(PythonInfo {
        path: python.to_string(),
        version,
        eracore,
    })
}

fn detect(preferred: &str) -> Option<PythonInfo> {
    candidates(preferred).iter().find_map(|c| probe(c))
}

#[tauri::command]
pub async fn era_detect(python_path: String) -> Option<PythonInfo> {
    tauri::async_runtime::spawn_blocking(move || detect(&python_path))
        .await
        .ok()
        .flatten()
}

fn stop(state: &EraState) {
    if let Ok(mut slot) = state.bridge.lock() {
        if let Some(mut b) = slot.take() {
            drop(b.stdin); // EOF lets the bridge exit on its own
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(500));
                let _ = b.child.kill();
                let _ = b.child.wait();
            });
        }
    }
}

#[tauri::command]
pub async fn era_start(
    app: AppHandle,
    state: State<'_, EraState>,
    python_path: String,
) -> CmdResult<Value> {
    stop(&state);
    let slot = state.bridge.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let python = detect(&python_path)
            .ok_or("Python 3 не найден. Укажите путь к интерпретатору в настройках eraAI.")?;
        let script =
            resource(&app, "era/bridge.py").ok_or("Не найден мост eraCore (era/bridge.py)")?;
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".into());
        let mut child = command(&python.path)
            .args(python_args(&python.path))
            .arg(&script)
            .current_dir(home)
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(err)?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let mut stderr = child.stderr.take().ok_or("no stderr")?;
        let token = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        let tail = Arc::new(Mutex::new(String::new()));
        {
            let tail = tail.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = stderr.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    if let Ok(mut t) = tail.lock() {
                        t.push_str(&String::from_utf8_lossy(&buf[..n]));
                        let len = t.len();
                        if len > 4000 {
                            let cut = t
                                .char_indices()
                                .map(|(i, _)| i)
                                .find(|&i| i >= len - 4000)
                                .unwrap_or(0);
                            t.drain(..cut);
                        }
                    }
                }
            });
        }

        let (hello_tx, hello_rx) = mpsc::channel::<Value>();
        {
            let (app, slot, tail) = (app.clone(), slot.clone(), tail.clone());
            std::thread::spawn(move || {
                let mut greeted = false;
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if !greeted && msg.get("type").and_then(Value::as_str) == Some("hello") {
                        greeted = true;
                        let _ = hello_tx.send(msg);
                        continue;
                    }
                    let _ = app.emit("era:event", msg);
                }
                // Exited: report only if it was the live bridge (not a deliberate restart).
                let live = slot
                    .lock()
                    .map(|s| s.as_ref().map(|b| b.token) == Some(token))
                    .unwrap_or(false);
                if live {
                    if let Ok(mut s) = slot.lock() {
                        if let Some(mut b) = s.take() {
                            let _ = b.child.wait();
                        }
                    }
                    let log = tail
                        .lock()
                        .map(|t| {
                            t.trim()
                                .lines()
                                .rev()
                                .take(8)
                                .collect::<Vec<_>>()
                                .into_iter()
                                .rev()
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .unwrap_or_default();
                    let _ = app.emit(
                        "era:event",
                        serde_json::json!({ "type": "exit", "code": null, "log": log }),
                    );
                }
            });
        }

        *slot.lock().map_err(err)? = Some(Bridge {
            child,
            stdin,
            token,
        });
        match hello_rx.recv_timeout(Duration::from_secs(20)) {
            Ok(mut hello) => {
                hello["pythonPath"] = Value::String(python.path.clone());
                Ok(hello)
            }
            Err(_) => {
                let msg = tail
                    .lock()
                    .map(|t| {
                        t.trim()
                            .lines()
                            .rev()
                            .take(5)
                            .collect::<Vec<_>>()
                            .into_iter()
                            .rev()
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                if let Ok(mut s) = slot.lock() {
                    if let Some(mut b) = s.take() {
                        let _ = b.child.kill();
                    }
                }
                Err(if msg.is_empty() {
                    "Мост eraCore не ответил за 20 секунд".into()
                } else {
                    msg
                })
            }
        }
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn era_send(state: State<'_, EraState>, msg: Value) {
    if let Ok(mut slot) = state.bridge.lock() {
        if let Some(b) = slot.as_mut() {
            let _ = writeln!(b.stdin, "{msg}");
            let _ = b.stdin.flush();
        }
    }
}

#[tauri::command]
pub fn era_stop(state: State<'_, EraState>) {
    stop(&state);
}

pub fn stop_all(state: &EraState) {
    stop(state);
}

/// Ollama's /api/tags, falling back to the OpenAI-style /models.
#[tauri::command]
pub async fn era_list_models(url: String) -> CmdResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = url.trim_end_matches('/').to_string();
        let root = base.strip_suffix("/v1").unwrap_or(&base).to_string();
        let tls = native_tls::TlsConnector::new().map_err(err)?;
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(4))
            .tls_connector(Arc::new(tls))
            .build();
        if let Ok(r) = agent.get(&format!("{root}/api/tags")).call() {
            if let Ok(v) = r.into_json::<Value>() {
                let names: Vec<String> = v["models"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|m| m["name"].as_str().map(String::from))
                    .collect();
                if !names.is_empty() {
                    return Ok(names);
                }
            }
        }
        let v: Value = agent
            .get(&format!("{base}/models"))
            .call()
            .map_err(err)?
            .into_json()
            .map_err(err)?;
        Ok(v["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| m["id"].as_str().map(String::from))
            .collect())
    })
    .await
    .map_err(err)?
}
