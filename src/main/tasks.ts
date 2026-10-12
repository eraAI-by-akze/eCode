import { app, ipcMain, type WebContents } from 'electron'
import { spawn, execFile, type ChildProcess } from 'child_process'
import { promises as fsp, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import type { PluginEntry } from '../shared/types'

/** Background tasks (build/check/test) whose output the renderer parses for problems. */

const isWin = process.platform === 'win32'
const tasks = new Map<number, ChildProcess>()
let nextId = 1

function run(sender: WebContents, command: string, cwd: string): number {
  const id = nextId++
  const child = spawn(isWin ? `chcp 65001>nul & ${command}` : command, {
    cwd,
    shell: true,
    detached: !isWin,
    windowsHide: true,
    env: {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      CARGO_TERM_COLOR: 'never',
      DOTNET_CLI_UI_LANGUAGE: 'en',
      DOTNET_NOLOGO: '1',
      PYTHONUNBUFFERED: '1'
    }
  })
  tasks.set(id, child)
  const send = (b: Buffer): void => {
    if (!sender.isDestroyed()) sender.send('task:output', id, b.toString('utf8'))
  }
  child.stdout?.on('data', send)
  child.stderr?.on('data', send)
  let finished = false
  const finish = (code: number | null): void => {
    if (finished) return
    finished = true
    tasks.delete(id)
    if (!sender.isDestroyed()) sender.send('task:exit', id, code)
  }
  child.on('error', (err) => {
    send(Buffer.from(`${err.message}\n`))
    finish(null)
  })
  child.on('close', (code) => finish(code))
  // Build servers (MSBuild node reuse, Roslyn, Gradle…) inherit the pipes and outlive
  // the build, so 'close' may never come: finish on exit once the output has drained.
  child.on('exit', (code) => setTimeout(() => finish(code), 400))
  return id
}

function kill(id: number): void {
  const child = tasks.get(id)
  if (!child?.pid) return
  if (isWin) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {})
  else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill()
    }
  }
}

export function killAllTasks(): void {
  for (const id of [...tasks.keys()]) kill(id)
}

/** Resolve a CLI tool on PATH (with PATHEXT on Windows). */
async function which(command: string): Promise<string | null> {
  if (!command) return null
  const exts = isWin ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const ext of exts) {
      const p = join(dir, command + ext.toLowerCase())
      const P = join(dir, command + ext)
      for (const candidate of new Set([p, P])) {
        try {
          const st = await fsp.stat(candidate)
          if (st.isFile()) return candidate
        } catch {
          // keep looking
        }
      }
    }
  }
  return null
}

function builtinPluginsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'plugins') : join(app.getAppPath(), 'resources', 'plugins')
}

export function userPluginsDir(): string {
  const dir = join(homedir(), '.ecode', 'plugins')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

async function listPlugins(): Promise<PluginEntry[]> {
  const out: PluginEntry[] = []
  for (const [base, builtin] of [
    [builtinPluginsDir(), true],
    [userPluginsDir(), false]
  ] as const) {
    let names: string[] = []
    try {
      names = await fsp.readdir(base)
    } catch {
      continue
    }
    for (const name of names.sort()) {
      const dir = join(base, name)
      const file = join(dir, 'plugin.json')
      if (!existsSync(file)) continue
      try {
        out.push({ dir, builtin, manifest: JSON.parse(await fsp.readFile(file, 'utf8')) })
      } catch (err) {
        out.push({ dir, builtin, error: (err as Error).message })
      }
    }
  }
  return out
}

export function registerTaskHandlers(): void {
  ipcMain.handle('task:run', (e, command: string, cwd: string) => run(e.sender, command, cwd))
  ipcMain.on('task:kill', (_e, id: number) => kill(id))
  ipcMain.handle('tools:which', (_e, command: string) => which(command))
  ipcMain.handle('plugins:list', () => listPlugins())
  ipcMain.handle('plugins:dir', () => userPluginsDir())
  // Electron: the renderer enumerates fonts with queryLocalFonts().
  ipcMain.handle('fonts:list', () => [])
}
