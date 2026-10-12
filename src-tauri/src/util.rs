//! Small helpers shared by the backend modules.

use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::{AppHandle, Manager};

/// A `Command` that never flashes a console window on Windows.
pub fn command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Locate a bundled resource: the packaged resource dir first, then the repo
/// checkout (for `tauri dev`, where resources are not copied).
pub fn resource(app: &AppHandle, rel: &str) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join(rel);
        if p.exists() {
            return Some(p);
        }
    }
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    for base in [repo.clone(), repo.join("resources")] {
        let p = base.join(rel);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

pub fn to_string_lossy(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Errors cross the IPC boundary as plain strings.
pub type CmdResult<T> = Result<T, String>;

pub fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}
