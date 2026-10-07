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
  gitBranch: (root) => ipcRenderer.invoke('fs:gitBranch', root),
  getPathForFile: (file) => webUtils.getPathForFile(file),

  termCreate: (cwd) => ipcRenderer.invoke('term:create', cwd),
  termWrite: (id, data) => ipcRenderer.send('term:write', id, data),
  termKill: (id) => ipcRenderer.send('term:kill', id),
  onTermData: (cb) => subscribe('term:data', cb),
  onTermExit: (cb) => subscribe('term:exit', cb),

  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (patch) => ipcRenderer.send('settings:save', patch)
}

contextBridge.exposeInMainWorld('ecode', api)
