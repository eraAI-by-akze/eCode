import { createTauriApi } from './tauri'

// Electron's preload defines window.ecode before any script runs. Under Tauri
// there is no preload, so install the Rust-backed implementation here. This
// module must be the first import of main.tsx: other modules read
// window.ecode at load time.
if (!window.ecode && '__TAURI_INTERNALS__' in window) {
  window.ecode = createTauriApi()
}
