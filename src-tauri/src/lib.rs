//! eCode on Tauri. The React UI is shared with the Electron build; this crate
//! implements the same `window.ecode` backend (see src/renderer/src/platform/tauri.ts).

mod app;
mod era;
mod fs;
mod git;
mod lsp;
mod settings;
mod terminal;
mod util;

use std::sync::atomic::Ordering;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(app::AppState::default())
        .manage(fs::FsState::default())
        .manage(terminal::TermState::default())
        .manage(lsp::LspState::default())
        .manage(era::EraState::default())
        .manage(settings::SettingsState::default())
        .setup(|app| {
            let mut win = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("eCode")
                .inner_size(1440.0, 900.0)
                .min_inner_size(760.0, 480.0)
                .background_color(tauri::window::Color(12, 10, 20, 255));
            #[cfg(target_os = "macos")]
            {
                // Native traffic lights over our own title bar.
                win = win.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
            }
            #[cfg(not(target_os = "macos"))]
            {
                win = win.decorations(false);
            }
            win.build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<app::AppState>();
                if state.dirty.load(Ordering::SeqCst) && !state.allow_close.load(Ordering::SeqCst) {
                    api.prevent_close();
                    app::confirm_quit(window.app_handle().clone());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            app::set_dirty,
            app::toggle_devtools,
            app::platform,
            app::confirm_dialog,
            fs::read_dir,
            fs::read_file,
            fs::write_file,
            fs::stat,
            fs::create_file,
            fs::create_dir,
            fs::rename,
            fs::remove,
            fs::list_files,
            fs::search,
            fs::watch,
            terminal::term_create,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_kill,
            lsp::lsp_start,
            lsp::lsp_request,
            lsp::lsp_notify,
            lsp::lsp_stop_all,
            git::git_status,
            git::git_init,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_diff_contents,
            git::git_branches,
            git::git_checkout,
            git::git_sync,
            era::era_detect,
            era::era_start,
            era::era_send,
            era::era_stop,
            era::era_list_models,
            settings::settings_load,
            settings::settings_save,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build eCode")
        .run(|handle, event| {
            if let tauri::RunEvent::Exit = event {
                terminal::kill_all(&handle.state::<terminal::TermState>());
                lsp::stop_all(&handle.state::<lsp::LspState>());
                era::stop_all(&handle.state::<era::EraState>());
            }
        });
}
