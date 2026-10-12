//! settings.json in the app config dir. Defaults live in the renderer
//! (src/shared/types.ts); this side only stores and merges the JSON.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct SettingsState {
    cache: Mutex<Option<Map<String, Value>>>,
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

fn load(app: &AppHandle) -> Map<String, Value> {
    file(app)
        .and_then(|f| fs::read_to_string(f).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

#[tauri::command]
pub fn settings_load(app: AppHandle, state: State<'_, SettingsState>) -> Value {
    let mut cache = state.cache.lock().unwrap_or_else(|e| e.into_inner());
    let map = cache.get_or_insert_with(|| load(&app));
    Value::Object(map.clone())
}

#[tauri::command]
pub fn settings_save(app: AppHandle, state: State<'_, SettingsState>, patch: Map<String, Value>) {
    let mut cache = state.cache.lock().unwrap_or_else(|e| e.into_inner());
    let map = cache.get_or_insert_with(|| load(&app));
    map.extend(patch);
    if let Some(f) = file(&app) {
        if let Some(dir) = f.parent() {
            let _ = fs::create_dir_all(dir);
        }
        // Settings are a convenience; never fail the app over them.
        let _ = fs::write(f, serde_json::to_string_pretty(&Value::Object(map.clone())).unwrap_or_default());
    }
}
