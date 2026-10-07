import { app, ipcMain } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'

let settings: Settings | null = null
let saveTimer: NodeJS.Timeout | null = null

const file = (): string => join(app.getPath('userData'), 'settings.json')

function load(): Settings {
  if (settings) return settings
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(file(), 'utf8')) }
  } catch {
    settings = { ...DEFAULT_SETTINGS }
  }
  return settings!
}

export function flushSettings(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  if (!settings) return
  try {
    mkdirSync(dirname(file()), { recursive: true })
    writeFileSync(file(), JSON.stringify(settings, null, 2))
  } catch {
    // Settings are a convenience; never crash the app over them.
  }
}

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:load', () => load())
  ipcMain.on('settings:save', (_e, patch: Partial<Settings>) => {
    settings = { ...load(), ...patch }
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(flushSettings, 400)
  })
}
