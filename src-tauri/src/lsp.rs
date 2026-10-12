//! Language Server Protocol host. Mirrors src/main/lsp.ts: the servers are
//! the same npm packages, run on Node (Tauri has no bundled Node, so it uses
//! the system `node` or $ECODE_NODE).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::util::{command, err, resource, to_string_lossy, CmdResult};

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>;

struct Server {
    /// Distinguishes this process from a later restart of the same server id.
    token: u64,
    root: String,
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    next_id: Arc<AtomicU64>,
    capabilities: Value,
}

#[derive(Default)]
pub struct LspState {
    servers: Arc<Mutex<HashMap<String, Server>>>,
    /// Serializes start/stop so two lsp_start calls can't race.
    lifecycle: Mutex<()>,
}

static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize, Clone)]
struct LspNotification {
    server: String,
    method: String,
    params: Value,
}

#[derive(Serialize, Clone)]
struct LspExit {
    server: String,
    code: Option<i32>,
}

struct ServerDef {
    script: &'static str,
    args: &'static [&'static str],
}

fn def(id: &str) -> Option<ServerDef> {
    match id {
        "typescript" => Some(ServerDef { script: "node_modules/typescript-language-server/lib/cli.mjs", args: &["--stdio"] }),
        "python" => Some(ServerDef { script: "node_modules/pyright/langserver.index.js", args: &["--stdio"] }),
        _ => None,
    }
}

fn node_binary() -> String {
    std::env::var("ECODE_NODE").unwrap_or_else(|_| "node".into())
}

fn file_uri(p: &str) -> String {
    let path = Path::new(p);
    let mut s = String::from("file://");
    let raw = to_string_lossy(path).replace('\\', "/");
    if !raw.starts_with('/') {
        s.push('/');
    }
    for ch in raw.chars() {
        match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '/' | '-' | '_' | '.' | '~' | ':' => s.push(ch),
            _ => {
                let mut buf = [0u8; 4];
                for b in ch.encode_utf8(&mut buf).bytes() {
                    s.push_str(&format!("%{b:02X}"));
                }
            }
        }
    }
    s
}

fn write_message(stdin: &Mutex<ChildStdin>, msg: &Value) -> CmdResult<()> {
    let body = serde_json::to_string(msg).map_err(err)?;
    let mut w = stdin.lock().map_err(err)?;
    write!(w, "Content-Length: {}\r\n\r\n{}", body.len(), body).map_err(err)?;
    w.flush().map_err(err)
}

/// Answers for the few requests servers send to the client.
fn answer_server_request(method: &str, params: &Value, root_uri: &str, root_name: &str) -> Result<Value, String> {
    match method {
        "workspace/configuration" => {
            let n = params.get("items").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
            Ok(Value::Array(vec![Value::Null; n]))
        }
        "workspace/workspaceFolders" => Ok(json!([{ "uri": root_uri, "name": root_name }])),
        "window/workDoneProgress/create" | "client/registerCapability" | "client/unregisterCapability" | "window/showMessageRequest" => {
            Ok(Value::Null)
        }
        "workspace/applyEdit" => Ok(json!({ "applied": false })),
        _ => Err(format!("Unhandled method {method}")),
    }
}

fn read_loop(
    app: AppHandle,
    id: String,
    stdout: impl Read,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    root_uri: String,
    root_name: String,
) {
    let mut reader = BufReader::new(stdout);
    loop {
        // Headers until an empty line.
        let mut len: Option<usize> = None;
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            let line = line.trim_end();
            if line.is_empty() {
                break;
            }
            if let Some(v) = line.strip_prefix("Content-Length:").or_else(|| line.strip_prefix("content-length:")) {
                len = v.trim().parse().ok();
            }
        }
        let Some(len) = len else { continue };
        let mut body = vec![0u8; len];
        if reader.read_exact(&mut body).is_err() {
            return;
        }
        let Ok(msg) = serde_json::from_slice::<Value>(&body) else { continue };
        let method = msg.get("method").and_then(Value::as_str);
        let msg_id = msg.get("id");
        match (method, msg_id) {
            (Some(m), Some(rid)) => {
                let reply = match answer_server_request(m, msg.get("params").unwrap_or(&Value::Null), &root_uri, &root_name) {
                    Ok(result) => json!({ "jsonrpc": "2.0", "id": rid, "result": result }),
                    Err(e) => json!({ "jsonrpc": "2.0", "id": rid, "error": { "code": -32601, "message": e } }),
                };
                let _ = write_message(&stdin, &reply);
            }
            (Some(m), None) => {
                if m != "window/logMessage" && m != "telemetry/event" {
                    let _ = app.emit(
                        "lsp:notification",
                        LspNotification { server: id.clone(), method: m.to_string(), params: msg.get("params").cloned().unwrap_or(Value::Null) },
                    );
                }
            }
            (None, Some(rid)) => {
                let Some(n) = rid.as_u64() else { continue };
                if let Some(tx) = pending.lock().ok().and_then(|mut p| p.remove(&n)) {
                    let res = match msg.get("error") {
                        Some(e) => Err(e.get("message").and_then(Value::as_str).unwrap_or("LSP error").to_string()),
                        None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    let _ = tx.send(res);
                }
            }
            _ => {}
        }
    }
}

fn send_request(stdin: &Mutex<ChildStdin>, pending: &Pending, next_id: &AtomicU64, method: &str, params: Value) -> CmdResult<mpsc::Receiver<Result<Value, String>>> {
    let id = next_id.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = mpsc::channel();
    pending.lock().map_err(err)?.insert(id, tx);
    write_message(stdin, &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
    Ok(rx)
}

fn initialize_params(app: &AppHandle, id: &str, root: &str) -> Value {
    let root_uri = file_uri(root);
    let name = Path::new(root).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let init_options = if id == "typescript" {
        resource(app, "node_modules/typescript/lib/tsserver.js").map(|p| {
            json!({
                "tsserver": { "path": to_string_lossy(&p) },
                "preferences": { "includeCompletionsForModuleExports": true, "includeCompletionsWithInsertText": true }
            })
        })
    } else {
        None
    };
    json!({
        "processId": std::process::id(),
        "clientInfo": { "name": "eCode" },
        "rootUri": root_uri,
        "rootPath": root,
        "workspaceFolders": [{ "uri": root_uri, "name": name }],
        "initializationOptions": init_options,
        "capabilities": {
            "general": { "positionEncodings": ["utf-16"] },
            "textDocument": {
                "synchronization": { "didSave": true, "willSave": false, "dynamicRegistration": false },
                "completion": {
                    "contextSupport": true,
                    "completionItem": {
                        "snippetSupport": true,
                        "documentationFormat": ["markdown", "plaintext"],
                        "deprecatedSupport": true,
                        "tagSupport": { "valueSet": [1] },
                        "labelDetailsSupport": true,
                        "insertReplaceSupport": true,
                        "resolveSupport": { "properties": ["documentation", "detail", "additionalTextEdits"] }
                    },
                    "completionItemKind": { "valueSet": (1..=25).collect::<Vec<u32>>() }
                },
                "hover": { "contentFormat": ["markdown", "plaintext"] },
                "signatureHelp": {
                    "contextSupport": true,
                    "signatureInformation": {
                        "documentationFormat": ["markdown", "plaintext"],
                        "parameterInformation": { "labelOffsetSupport": true },
                        "activeParameterSupport": true
                    }
                },
                "definition": { "linkSupport": true },
                "typeDefinition": { "linkSupport": true },
                "documentSymbol": { "hierarchicalDocumentSymbolSupport": true, "symbolKind": { "valueSet": (1..=26).collect::<Vec<u32>>() } },
                "formatting": {},
                "rangeFormatting": {},
                "rename": { "prepareSupport": false },
                "publishDiagnostics": { "relatedInformation": false, "tagSupport": { "valueSet": [1, 2] }, "versionSupport": false }
            },
            "workspace": { "configuration": true, "workspaceFolders": true, "applyEdit": false },
            "window": { "workDoneProgress": true, "showMessage": {} }
        }
    })
}

fn stop_server(mut s: Server) {
    if let Ok(mut p) = s.pending.lock() {
        for (_, tx) in p.drain() {
            let _ = tx.send(Err("Language server stopped".into()));
        }
    }
    let _ = write_message(&s.stdin, &json!({ "jsonrpc": "2.0", "id": 0, "method": "shutdown", "params": null }));
    let _ = write_message(&s.stdin, &json!({ "jsonrpc": "2.0", "method": "exit", "params": null }));
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        let _ = s.child.kill();
        let _ = s.child.wait();
    });
}

fn start_blocking(app: AppHandle, state: &LspState, id: String, root: String) -> CmdResult<Value> {
    let _guard = state.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
    {
        let mut servers = state.servers.lock().map_err(err)?;
        if let Some(s) = servers.get(&id) {
            if s.root == root {
                return Ok(json!({ "capabilities": s.capabilities }));
            }
        }
        if let Some(old) = servers.remove(&id) {
            stop_server(old);
        }
    }
    let d = def(&id).ok_or_else(|| format!("Unknown language server {id}"))?;
    let script: PathBuf = resource(&app, d.script).ok_or_else(|| format!("Не найден языковой сервер: {}", d.script))?;
    let mut child = command(&node_binary())
        .arg(&script)
        .args(d.args)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Node.js не найден ({e}). Установите Node.js или укажите путь в ECODE_NODE."))?;

    let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or("no stdin")?));
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let pending: Pending = Arc::default();
    let next_id = Arc::new(AtomicU64::new(0));
    let name = Path::new(&root).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let token = NEXT_TOKEN.fetch_add(1, Ordering::SeqCst);
    {
        let (app, id, stdin, pending, root_uri) = (app.clone(), id.clone(), stdin.clone(), pending.clone(), file_uri(&root));
        let servers = state.servers.clone();
        std::thread::spawn(move || {
            read_loop(app.clone(), id.clone(), stdout, stdin, pending.clone(), root_uri, name);
            // stdout closed: the server is gone.
            if let Ok(mut p) = pending.lock() {
                for (_, tx) in p.drain() {
                    let _ = tx.send(Err("Language server exited".into()));
                }
            }
            // Only a crash is news; a deliberate stop already removed it.
            let crashed = servers
                .lock()
                .map(|mut map| match map.get(&id) {
                    Some(s) if s.token == token => map.remove(&id).map(|mut s| s.child.wait().is_ok()).is_some(),
                    _ => false,
                })
                .unwrap_or(false);
            if crashed {
                let _ = app.emit("lsp:exit", LspExit { server: id, code: None });
            }
        });
    }

    let rx = send_request(&stdin, &pending, &next_id, "initialize", initialize_params(&app, &id, &root))?;
    let result = rx.recv_timeout(Duration::from_secs(60)).map_err(|_| "Языковой сервер не ответил".to_string())??;
    write_message(&stdin, &json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }))?;
    write_message(&stdin, &json!({ "jsonrpc": "2.0", "method": "workspace/didChangeConfiguration", "params": { "settings": {} } }))?;
    let capabilities = result.get("capabilities").cloned().unwrap_or_else(|| json!({}));
    state.servers.lock().map_err(err)?.insert(
        id,
        Server { token, root, child, stdin, pending, next_id, capabilities: capabilities.clone() },
    );
    Ok(json!({ "capabilities": capabilities }))
}

#[tauri::command]
pub async fn lsp_start(app: AppHandle, server: String, root: String) -> CmdResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let state: State<'_, LspState> = tauri::Manager::state(&app);
        start_blocking(app.clone(), &state, server, root)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn lsp_request(state: State<'_, LspState>, server: String, method: String, params: Value) -> CmdResult<Value> {
    let rx = {
        let servers = state.servers.lock().map_err(err)?;
        let s = servers.get(&server).ok_or("Language server is not running")?;
        send_request(&s.stdin, &s.pending, &s.next_id, &method, params)?
    };
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(120)).map_err(|_| "Языковой сервер не ответил".to_string())?
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn lsp_notify(state: State<'_, LspState>, server: String, method: String, params: Value) {
    if let Ok(servers) = state.servers.lock() {
        if let Some(s) = servers.get(&server) {
            let _ = write_message(&s.stdin, &json!({ "jsonrpc": "2.0", "method": method, "params": params }));
        }
    }
}

#[tauri::command]
pub fn lsp_stop_all(state: State<'_, LspState>) {
    stop_all(&state);
}

pub fn stop_all(state: &LspState) {
    let _guard = state.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
    if let Ok(mut servers) = state.servers.lock() {
        for (_, s) in servers.drain() {
            stop_server(s);
        }
    }
}
