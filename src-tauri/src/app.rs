//! Window-level commands: unsaved-changes guard, devtools, confirm dialogs.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

#[derive(Default)]
pub struct AppState {
    pub dirty: AtomicBool,
    /// Set once the user confirmed quitting with unsaved changes.
    pub allow_close: AtomicBool,
}

#[tauri::command]
pub fn set_dirty(state: State<'_, AppState>, dirty: bool) {
    state.dirty.store(dirty, Ordering::SeqCst);
}

#[tauri::command]
pub fn toggle_devtools(window: WebviewWindow) {
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
}

#[tauri::command]
pub fn platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

/// Native message box; returns the index of the pressed button
/// (the last button doubles as "cancel" / dialog closed).
#[tauri::command]
pub async fn confirm_dialog(app: AppHandle, message: String, detail: Option<String>, buttons: Option<Vec<String>>) -> usize {
    let buttons = buttons.unwrap_or_else(|| vec!["OK".into(), "Отмена".into()]);
    let last = buttons.len().saturating_sub(1);
    let kind = match buttons.len() {
        0 | 1 => MessageDialogButtons::OkCustom(buttons.first().cloned().unwrap_or_else(|| "OK".into())),
        2 => MessageDialogButtons::OkCancelCustom(buttons[0].clone(), buttons[1].clone()),
        _ => MessageDialogButtons::YesNoCancelCustom(buttons[0].clone(), buttons[1].clone(), buttons[2].clone()),
    };
    let mut dialog = app.dialog().message(detail.unwrap_or_default()).title(message).kind(MessageDialogKind::Info).buttons(kind);
    if let Some(w) = app.get_webview_window("main") {
        dialog = dialog.parent(&w);
    }
    let result = tauri::async_runtime::spawn_blocking(move || dialog.blocking_show_with_result()).await.unwrap_or_default();
    match result {
        MessageDialogResult::Custom(label) => buttons.iter().position(|b| *b == label).unwrap_or(last),
        MessageDialogResult::Yes | MessageDialogResult::Ok => 0,
        MessageDialogResult::No => 1.min(last),
        MessageDialogResult::Cancel => last,
    }
}

/// Called from the close handler: ask before discarding unsaved work.
pub fn confirm_quit(app: AppHandle) {
    std::thread::spawn(move || {
        let ok = app
            .dialog()
            .message("Если выйти сейчас, изменения будут потеряны.")
            .title("Есть несохранённые изменения")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Выйти без сохранения".into(), "Отмена".into()))
            .blocking_show_with_result();
        let quit = matches!(ok, MessageDialogResult::Ok) || matches!(&ok, MessageDialogResult::Custom(l) if l == "Выйти без сохранения");
        if quit {
            app.state::<AppState>().allow_close.store(true, Ordering::SeqCst);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.close();
            }
        }
    });
}
