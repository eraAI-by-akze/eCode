import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { join } from 'path'
import { registerFsHandlers } from './fs'
import { registerTerminalHandlers, killAllTerminals } from './terminal'
import { registerSettingsHandlers, flushSettings } from './settings'
import { registerLspHandlers, stopAllLanguageServers } from './lsp'
import { registerGitHandlers } from './git'

const isMac = process.platform === 'darwin'

let mainWindow: BrowserWindow | null = null
let hasUnsaved = false

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 480,
    show: false,
    backgroundColor: '#0c0a14',
    title: 'eCode',
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : undefined,
    trafficLightPosition: isMac ? { x: 14, y: 12 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  mainWindow = win

  win.once('ready-to-show', () => win.show())
  win.on('maximize', () => win.webContents.send('win:maximized', true))
  win.on('unmaximize', () => win.webContents.send('win:maximized', false))
  win.on('close', (e) => {
    if (!hasUnsaved) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Выйти без сохранения', 'Отмена'],
      defaultId: 1,
      cancelId: 1,
      message: 'Есть несохранённые изменения',
      detail: 'Если выйти сейчас, изменения будут потеряны.'
    })
    if (choice !== 0) e.preventDefault()
  })
  win.on('closed', () => {
    mainWindow = null
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function buildMenu(): void {
  if (!isMac) {
    // The renderer draws its own title bar and handles shortcuts itself.
    Menu.setApplicationMenu(null)
    return
  }
  // macOS needs an Edit menu for native clipboard shortcuts in inputs.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [{ role: 'toggleDevTools' }, { role: 'togglefullscreen' }]
      },
      { role: 'windowMenu' }
    ])
  )
}

function registerWindowHandlers(): void {
  const fromEvent = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender)

  ipcMain.on('win:minimize', (e) => fromEvent(e)?.minimize())
  ipcMain.on('win:toggleMaximize', (e) => {
    const w = fromEvent(e)
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.on('win:close', (e) => fromEvent(e)?.close())
  ipcMain.on('win:devtools', (e) => e.sender.toggleDevTools())
  ipcMain.on('app:setDirty', (_e, dirty: boolean) => {
    hasUnsaved = dirty
  })

  ipcMain.handle('dialog:openFolder', async (e) => {
    const w = fromEvent(e)
    const r = await dialog.showOpenDialog(w!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('dialog:openFile', async (e) => {
    const w = fromEvent(e)
    const r = await dialog.showOpenDialog(w!, { properties: ['openFile'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('dialog:saveFile', async (e, defaultPath: string) => {
    const w = fromEvent(e)
    const r = await dialog.showSaveDialog(w!, { defaultPath })
    return r.canceled ? null : r.filePath
  })
  ipcMain.handle(
    'dialog:confirm',
    async (e, message: string, detail?: string, buttons?: string[]) => {
      const w = fromEvent(e)
      const btns = buttons ?? ['OK', 'Отмена']
      const r = await dialog.showMessageBox(w!, {
        type: 'question',
        message,
        detail,
        buttons: btns,
        defaultId: 0,
        cancelId: btns.length - 1
      })
      return r.response
    }
  )
  ipcMain.handle('menu:context', (e, items: Electron.MenuItemConstructorOptions[]) => {
    const w = fromEvent(e)
    return new Promise<string | null>((resolve) => {
      let done = false
      const finish = (v: string | null): void => {
        if (done) return
        done = true
        resolve(v)
      }
      const menu = Menu.buildFromTemplate(
        items.map((it) =>
          it.type === 'separator'
            ? { type: 'separator' }
            : {
                label: it.label,
                accelerator: it.accelerator,
                enabled: it.enabled ?? true,
                registerAccelerator: false,
                click: () => finish(it.id ?? null)
              }
        )
      )
      // `callback` can fire before `click`, so give the click a tick to win.
      menu.popup({ window: w ?? undefined, callback: () => setTimeout(() => finish(null), 50) })
    })
  })
  ipcMain.on('shell:openExternal', (_e, url: string) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
  })
  ipcMain.on('shell:reveal', (_e, p: string) => shell.showItemInFolder(p))
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.eraai.ecode')
  buildMenu()
  registerWindowHandlers()
  registerFsHandlers(() => mainWindow)
  registerTerminalHandlers()
  registerLspHandlers(() => mainWindow)
  registerGitHandlers()
  registerSettingsHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  if (app.isPackaged) {
    import('electron-updater')
      .then(({ autoUpdater }) => autoUpdater.checkForUpdatesAndNotify())
      .catch(() => {})
  }
})

app.on('before-quit', () => {
  killAllTerminals()
  stopAllLanguageServers()
  flushSettings()
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})
