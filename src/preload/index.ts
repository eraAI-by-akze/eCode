import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { EcodeApi } from '../shared/types'

function subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: EcodeApi = {
  platform: process.platform,
  pathSep: process.platform === 'win32' ? '\\' : '/',
  runtime: 'electron',

  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.send('win:toggleMaximize'),
  close: () => ipcRenderer.send('win:close'),
  toggleDevTools: () => ipcRenderer.send('win:devtools'),
  onMaximizedChange: (cb) => subscribe('win:maximized', cb),
  setDirty: (dirty) => ipcRenderer.send('app:setDirty', dirty),

  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  saveFileDialog: (name) => ipcRenderer.invoke('dialog:saveFile', name),
  confirm: (message, detail, buttons) => ipcRenderer.invoke('dialog:confirm', message, detail, buttons),
  contextMenu: (items) => ipcRenderer.invoke('menu:context', items),
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),
  revealInFolder: (p) => ipcRenderer.send('shell:reveal', p),

  readDir: (dir) => ipcRenderer.invoke('fs:readDir', dir),
  readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
  writeFile: (p, content) => ipcRenderer.invoke('fs:writeFile', p, content),
  stat: (p) => ipcRenderer.invoke('fs:stat', p),
  createFile: (dir, name) => ipcRenderer.invoke('fs:createFile', dir, name),
  createDir: (dir, name) => ipcRenderer.invoke('fs:createDir', dir, name),
  rename: (p, newName) => ipcRenderer.invoke('fs:rename', p, newName),
  remove: (p) => ipcRenderer.invoke('fs:remove', p),
  listFiles: (root) => ipcRenderer.invoke('fs:listFiles', root),
  search: (root, query, opts) => ipcRenderer.invoke('fs:search', root, query, opts),
  watch: (root) => ipcRenderer.send('fs:watch', root),
  onFsChange: (cb) => subscribe('fs:changed', cb),
  getPathForFile: (file) => webUtils.getPathForFile(file),

  termCreate: (cwd, cols, rows) => ipcRenderer.invoke('term:create', cwd, cols, rows),
  termWrite: (id, data) => ipcRenderer.send('term:write', id, data),
  termResize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
  termKill: (id) => ipcRenderer.send('term:kill', id),
  onTermData: (cb) => subscribe('term:data', cb),
  onTermExit: (cb) => subscribe('term:exit', cb),

  lspStart: (server, root, spec) => ipcRenderer.invoke('lsp:start', server, root, spec),
  lspRequest: (server, method, params) => ipcRenderer.invoke('lsp:request', server, method, params),
  lspNotify: (server, method, params) => ipcRenderer.send('lsp:notify', server, method, params),
  lspStopAll: () => ipcRenderer.invoke('lsp:stopAll'),
  onLspNotification: (cb) => subscribe('lsp:notification', cb),
  onLspExit: (cb) => subscribe('lsp:exit', cb),

  gitStatus: (root) => ipcRenderer.invoke('git:status', root),
  gitInit: (root) => ipcRenderer.invoke('git:init', root),
  gitStage: (repo, paths) => ipcRenderer.invoke('git:stage', repo, paths),
  gitUnstage: (repo, paths) => ipcRenderer.invoke('git:unstage', repo, paths),
  gitDiscard: (repo, tracked, untracked) => ipcRenderer.invoke('git:discard', repo, tracked, untracked),
  gitCommit: (repo, message, all) => ipcRenderer.invoke('git:commit', repo, message, all),
  gitDiffContents: (repo, path, staged) => ipcRenderer.invoke('git:diffContents', repo, path, staged),
  gitBranches: (repo) => ipcRenderer.invoke('git:branches', repo),
  gitCheckout: (repo, ref, create) => ipcRenderer.invoke('git:checkout', repo, ref, create),
  gitSync: (repo, op) => ipcRenderer.invoke('git:sync', repo, op),

  eraDetect: (pythonPath) => ipcRenderer.invoke('era:detect', pythonPath),
  eraStart: (pythonPath) => ipcRenderer.invoke('era:start', pythonPath),
  eraSend: (msg) => ipcRenderer.send('era:send', msg),
  eraStop: () => ipcRenderer.invoke('era:stop'),
  eraListModels: (url) => ipcRenderer.invoke('era:listModels', url),
  eraPickModelFile: () => ipcRenderer.invoke('era:pickModelFile'),
  onEraEvent: (cb) => subscribe('era:event', cb),

  pluginsList: () => ipcRenderer.invoke('plugins:list'),
  pluginsDir: () => ipcRenderer.invoke('plugins:dir'),
  taskRun: (command, cwd) => ipcRenderer.invoke('task:run', command, cwd),
  taskKill: (id) => ipcRenderer.send('task:kill', id),
  onTaskOutput: (cb) => subscribe('task:output', cb),
  onTaskExit: (cb) => subscribe('task:exit', cb),
  which: (command) => ipcRenderer.invoke('tools:which', command),
  listFonts: () => ipcRenderer.invoke('fonts:list'),

  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (patch) => ipcRenderer.send('settings:save', patch)
}

contextBridge.exposeInMainWorld('ecode', api)
