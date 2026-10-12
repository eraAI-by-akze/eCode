//! Terminals via portable-pty (ConPTY on Windows, openpty elsewhere), so no
//! native Node module is needed. Output is streamed as `term:data` events.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::util::{err, CmdResult};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct TermState {
    sessions: Mutex<HashMap<u32, Session>>,
    next_id: AtomicU32,
}

#[derive(Serialize)]
pub struct TermInfo {
    id: u32,
    cwd: String,
    shell: String,
    pty: bool,
}

#[derive(Serialize, Clone)]
struct TermData {
    id: u32,
    data: String,
}

#[derive(Serialize, Clone)]
struct TermExit {
    id: u32,
    code: Option<u32>,
}

fn shell() -> (String, Vec<String>) {
    if let Ok(s) = std::env::var("ECODE_SHELL") {
        return (s, vec![]);
    }
    if cfg!(windows) {
        ("powershell.exe".into(), vec!["-NoLogo".into()])
    } else {
        let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let args = if cfg!(target_os = "macos") { vec!["-l".into()] } else { vec![] };
        (sh, args)
    }
}

/// Decode a byte stream as UTF-8 without splitting multi-byte characters.
fn take_utf8(buf: &mut Vec<u8>) -> String {
    match std::str::from_utf8(buf) {
        Ok(s) => {
            let out = s.to_owned();
            buf.clear();
            out
        }
        Err(e) if e.error_len().is_none() => {
            // Incomplete sequence at the end: keep it for the next read.
            let valid = e.valid_up_to();
            let out = String::from_utf8_lossy(&buf[..valid]).into_owned();
            buf.drain(..valid);
            out
        }
        Err(_) => {
            let out = String::from_utf8_lossy(buf).into_owned();
            buf.clear();
            out
        }
    }
}

#[tauri::command]
pub fn term_create(app: AppHandle, state: State<'_, TermState>, cwd: Option<String>, cols: u16, rows: u16) -> CmdResult<TermInfo> {
    let dir = cwd
        .filter(|c| std::path::Path::new(c).is_dir())
        .or_else(|| std::env::var("HOME").ok().or_else(|| std::env::var("USERPROFILE").ok()))
        .unwrap_or_else(|| ".".into());
    let (program, args) = shell();
    let pair = native_pty_system()
        .openpty(PtySize { rows: rows.max(1), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
        .map_err(err)?;
    let mut cmd = CommandBuilder::new(&program);
    cmd.args(&args);
    cmd.cwd(&dir);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "eCode");
    let mut child = pair.slave.spawn_command(cmd).map_err(err)?;
    drop(pair.slave);

    let id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let writer = pair.master.take_writer().map_err(err)?;
    let killer = child.clone_killer();

    let out = app.clone();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 16 * 1024];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&chunk[..n]);
                    let data = take_utf8(&mut pending);
                    if !data.is_empty() && out.emit("term:data", TermData { id, data }).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let exit_app = app.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        let _ = exit_app.emit("term:exit", TermExit { id, code });
    });

    state
        .sessions
        .lock()
        .map_err(err)?
        .insert(id, Session { master: pair.master, writer, killer });
    Ok(TermInfo { id, cwd: dir, shell: program, pty: true })
}

#[tauri::command]
pub fn term_write(state: State<'_, TermState>, id: u32, data: String) {
    if let Ok(mut map) = state.sessions.lock() {
        if let Some(s) = map.get_mut(&id) {
            let _ = s.writer.write_all(data.as_bytes());
            let _ = s.writer.flush();
        }
    }
}

#[tauri::command]
pub fn term_resize(state: State<'_, TermState>, id: u32, cols: u16, rows: u16) {
    if let Ok(map) = state.sessions.lock() {
        if let Some(s) = map.get(&id) {
            let _ = s.master.resize(PtySize { rows: rows.max(1), cols: cols.max(2), pixel_width: 0, pixel_height: 0 });
        }
    }
}

#[tauri::command]
pub fn term_kill(state: State<'_, TermState>, id: u32) {
    if let Ok(mut map) = state.sessions.lock() {
        if let Some(mut s) = map.remove(&id) {
            let _ = s.killer.kill();
        }
    }
}

pub fn kill_all(state: &TermState) {
    if let Ok(mut map) = state.sessions.lock() {
        for (_, mut s) in map.drain() {
            let _ = s.killer.kill();
        }
    }
}
