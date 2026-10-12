import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open, save } from '@tauri-apps/plugin-dialog'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import {
  DEFAULT_ERA,
  DEFAULT_SETTINGS,
  type ContextMenuItem,
  type EcodeApi,
  type LspServerId,
  type Settings
} from '@shared/types'
import { showContextMenu } from './contextMenu'

/**
 * `window.ecode` for the Tauri build: same contract as the Electron preload,
 * backed by Rust commands (src-tauri/src) and Tauri events.
 */

function detectPlatform(): NodeJS.Platform {
  const p = `${navigator.platform} ${navigator.userAgent}`
  if (/Mac/i.test(p)) return 'darwin'
  if (/Win/i.test(p)) return 'win32'
  return 'linux'
}

/** Tauri's listen() is async; hand back a synchronous unsubscribe like ipcRenderer. */
function subscribe<T>(event: string, cb: (payload: T) => void): () => void {
  let unlisten: UnlistenFn | null = null
  let cancelled = false
  listen<T>(event, (e) => cb(e.payload)).then((fn) => {
    if (cancelled) fn()
    else unlisten = fn
  })
  return () => {
    cancelled = true
    unlisten?.()
  }
}

export function createTauriApi(): EcodeApi {
  const platform = detectPlatform()
  const win = getCurrentWindow()

  // Keep the OS window title in sync with document.title like Electron does.
  const titleEl = document.querySelector('title')
  if (titleEl) {
    new MutationObserver(() => void win.setTitle(document.title)).observe(titleEl, { childList: true })
  }

  return {
    platform,
    pathSep: platform === 'win32' ? '\\' : '/',
    runtime: 'tauri',

    minimize: () => void win.minimize(),
    toggleMaximize: () => void win.toggleMaximize(),
    close: () => void win.close(),
    toggleDevTools: () => void invoke('toggle_devtools'),
    onMaximizedChange: (cb) => {
      let unlisten: UnlistenFn | null = null
      let cancelled = false
      win
        .onResized(async () => cb(await win.isMaximized()))
        .then((fn) => (cancelled ? fn() : (unlisten = fn)))
      return () => {
        cancelled = true
        unlisten?.()
      }
    },
    setDirty: (dirty) => void invoke('set_dirty', { dirty }),

    openFolderDialog: async () => ((await open({ directory: true })) as string | null) ?? null,
    openFileDialog: async () => ((await open({ multiple: false })) as string | null) ?? null,
    saveFileDialog: async (defaultPath) => (await save({ defaultPath })) ?? null,
    confirm: (message, detail, buttons) => invoke<number>('confirm_dialog', { message, detail, buttons }),
    contextMenu: (items: ContextMenuItem[]) => showContextMenu(items),
    openExternal: (url) => {
      if (/^https?:/.test(url)) void openUrl(url)
    },
    revealInFolder: (p) => void revealItemInDir(p),

    readDir: (dir) => invoke('read_dir', { dir }),
    readFile: (path) => invoke('read_file', { path }),
    writeFile: (path, content) => invoke('write_file', { path, content }),
    stat: (path) => invoke('stat', { path }),
    createFile: (dir, name) => invoke('create_file', { dir, name }),
    createDir: (dir, name) => invoke('create_dir', { dir, name }),
    rename: (path, newName) => invoke('rename', { path, newName }),
    remove: (path) => invoke('remove', { path }),
    listFiles: (root) => invoke('list_files', { root }),
    search: (root, query, opts) => invoke('search', { root, query, opts }),
    watch: (root) => void invoke('watch', { root }),
    onFsChange: (cb) => subscribe<string[]>('fs:changed', cb),
    // File paths from DOM drops aren't exposed in Tauri; drops arrive via onFileDrop.
    getPathForFile: () => '',
    onFileDrop: (cb) => {
      let unlisten: UnlistenFn | null = null
      let cancelled = false
      getCurrentWebview()
        .onDragDropEvent((e) => {
          if (e.payload.type === 'drop') cb(e.payload.paths)
        })
        .then((fn) => (cancelled ? fn() : (unlisten = fn)))
      return () => {
        cancelled = true
        unlisten?.()
      }
    },

    termCreate: (cwd, cols, rows) => invoke('term_create', { cwd, cols, rows }),
    termWrite: (id, data) => void invoke('term_write', { id, data }),
    termResize: (id, cols, rows) => void invoke('term_resize', { id, cols, rows }),
    termKill: (id) => void invoke('term_kill', { id }),
    onTermData: (cb) => subscribe<{ id: number; data: string }>('term:data', (p) => cb(p.id, p.data)),
    onTermExit: (cb) => subscribe<{ id: number; code: number | null }>('term:exit', (p) => cb(p.id, p.code)),

    lspStart: (server, root, spec) => invoke('lsp_start', { server, root, spec: spec ?? null }),
    lspRequest: (server, method, params) => invoke('lsp_request', { server, method, params: params ?? null }),
    lspNotify: (server, method, params) => void invoke('lsp_notify', { server, method, params: params ?? null }),
    lspStopAll: () => invoke('lsp_stop_all'),
    onLspNotification: (cb) =>
      subscribe<{ server: LspServerId; method: string; params: unknown }>('lsp:notification', (p) =>
        cb(p.server, p.method, p.params)
      ),
    onLspExit: (cb) => subscribe<{ server: LspServerId; code: number | null }>('lsp:exit', (p) => cb(p.server, p.code)),

    gitStatus: (root) => invoke('git_status', { root }),
    gitInit: (root) => invoke('git_init', { root }),
    gitStage: (repo, paths) => invoke('git_stage', { repo, paths }),
    gitUnstage: (repo, paths) => invoke('git_unstage', { repo, paths }),
    gitDiscard: (repo, tracked, untracked) => invoke('git_discard', { repo, tracked, untracked }),
    gitCommit: (repo, message, all) => invoke('git_commit', { repo, message, all }),
    gitDiffContents: (repo, path, staged) => invoke('git_diff_contents', { repo, path, staged }),
    gitBranches: (repo) => invoke('git_branches', { repo }),
    gitCheckout: (repo, ref, create) => invoke('git_checkout', { repo, ref, create }),
    gitSync: (repo, op) => invoke('git_sync', { repo, op }),

    eraDetect: (pythonPath) => invoke('era_detect', { pythonPath }),
    eraStart: (pythonPath) => invoke('era_start', { pythonPath }),
    eraSend: (msg) => void invoke('era_send', { msg }),
    eraStop: () => invoke('era_stop'),
    eraListModels: (url) => invoke('era_list_models', { url }),
    eraPickModelFile: async () =>
      ((await open({
        title: 'Файл модели GGUF',
        multiple: false,
        filters: [
          { name: 'GGUF', extensions: ['gguf'] },
          { name: 'Все файлы', extensions: ['*'] }
        ]
      })) as string | null) ?? null,
    onEraEvent: (cb) => subscribe<Record<string, unknown>>('era:event', cb),

    pluginsList: () => invoke('plugins_list'),
    pluginsDir: () => invoke('plugins_dir'),
    taskRun: (command, cwd) => invoke('task_run', { command, cwd }),
    taskKill: (id) => void invoke('task_kill', { id }),
    onTaskOutput: (cb) => subscribe<{ id: number; data: string }>('task:output', (p) => cb(p.id, p.data)),
    onTaskExit: (cb) => subscribe<{ id: number; code: number | null }>('task:exit', (p) => cb(p.id, p.code)),
    which: (command) => invoke('which', { command }),
    listFonts: () => invoke('list_fonts'),

    loadSettings: async () => {
      const saved = await invoke<Partial<Settings>>('settings_load')
      return { ...DEFAULT_SETTINGS, ...saved, era: { ...DEFAULT_ERA, ...(saved.era ?? {}) } }
    },
    saveSettings: (patch) => void invoke('settings_save', { patch })
  }
}
