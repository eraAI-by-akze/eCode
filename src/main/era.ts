import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { createInterface } from 'readline'
import type { EraHello, PythonInfo } from '../shared/types'

/**
 * Hosts resources/era/bridge.py — the eraCore agent — in the user's Python.
 * Messages are JSON lines both ways; this side only relays them.
 */

const isWin = process.platform === 'win32'

let proc: ChildProcessWithoutNullStreams | null = null
let stderrTail = ''

function bridgePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'era', 'bridge.py')
    : join(app.getAppPath(), 'resources', 'era', 'bridge.py')
}

function pythonCandidates(preferred: string): string[] {
  const list = preferred.trim() ? [preferred.trim()] : []
  return [...list, ...(isWin ? ['py', 'python', 'python3'] : ['python3', 'python'])]
}

function probe(python: string): Promise<PythonInfo | null> {
  return new Promise((resolve) => {
    const args = python === 'py' ? ['-3', '-c'] : ['-c']
    execFile(
      python,
      [...args, 'import sys, importlib.util as u; print(sys.version.split()[0]); print(1 if u.find_spec("eraCore") else 0)'],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null)
        const [version, has] = stdout.trim().split(/\r?\n/)
        resolve({ path: python, version, eracore: has === '1' })
      }
    )
  })
}

async function detect(preferred: string): Promise<PythonInfo | null> {
  for (const c of pythonCandidates(preferred)) {
    const info = await probe(c)
    if (info) return info
  }
  return null
}

function stop(): void {
  if (!proc) return
  const p = proc
  proc = null
  try {
    p.stdin.end()
  } catch {
    // already closed
  }
  setTimeout(() => {
    if (p.exitCode === null) p.kill()
  }, 500)
}

function start(python: PythonInfo, getWindow: () => BrowserWindow | null): Promise<EraHello> {
  stop()
  stderrTail = ''
  const args = python.path === 'py' ? ['-3', bridgePath()] : [bridgePath()]
  const child = spawn(python.path, args, {
    cwd: homedir(),
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    windowsHide: true
  })
  proc = child
  const send = (channel: string, payload: unknown): void => {
    const w = getWindow()
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
  }

  return new Promise((resolve, reject) => {
    let greeted = false
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      let msg: { type?: string }
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (!greeted && msg.type === 'hello') {
        greeted = true
        resolve(msg as EraHello)
        return
      }
      if (proc === child) send('era:event', msg)
    })
    child.stderr.on('data', (b: Buffer) => {
      stderrTail = (stderrTail + b.toString('utf8')).slice(-4000)
    })
    child.on('error', (err) => {
      if (!greeted) reject(err)
    })
    child.on('exit', (code) => {
      if (!greeted) {
        reject(new Error(stderrTail.trim().split('\n').slice(-5).join('\n') || `Python завершился с кодом ${code}`))
      } else if (proc === child) {
        proc = null
        send('era:event', { type: 'exit', code, log: stderrTail.trim().split('\n').slice(-8).join('\n') })
      }
    })
    setTimeout(() => {
      if (!greeted) {
        child.kill()
        reject(new Error('Мост eraCore не ответил за 20 секунд'))
      }
    }, 20000)
  })
}

/** Ollama's native /api/tags, falling back to the OpenAI-style /models. */
async function listModels(url: string): Promise<string[]> {
  const base = url.replace(/\/+$/, '')
  const root = base.replace(/\/v1$/, '')
  try {
    const r = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(4000) })
    if (r.ok) {
      const j = (await r.json()) as { models?: { name: string }[] }
      if (j.models?.length) return j.models.map((m) => m.name)
    }
  } catch {
    // not Ollama, or not running
  }
  const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(4000) })
  if (!r.ok) throw new Error(`Сервер ответил ${r.status}`)
  const j = (await r.json()) as { data?: { id: string }[] }
  return (j.data ?? []).map((m) => m.id)
}

export function stopEra(): void {
  stop()
}

export function registerEraHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('era:detect', (_e, preferred: string) => detect(preferred ?? ''))
  ipcMain.handle('era:start', async (_e, preferred: string) => {
    const python = await detect(preferred ?? '')
    if (!python) throw new Error('Python 3 не найден. Укажите путь к интерпретатору в настройках eraAI.')
    const hello = await start(python, getWindow)
    return { ...hello, pythonPath: python.path }
  })
  ipcMain.on('era:send', (_e, msg: unknown) => {
    if (proc) proc.stdin.write(JSON.stringify(msg) + '\n')
  })
  ipcMain.handle('era:stop', () => stop())
  ipcMain.handle('era:listModels', (_e, url: string) => listModels(url))
  ipcMain.handle('era:pickModelFile', async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    const r = await dialog.showOpenDialog(w!, {
      title: 'Файл модели GGUF',
      properties: ['openFile'],
      filters: [
        { name: 'GGUF', extensions: ['gguf'] },
        { name: 'Все файлы', extensions: ['*'] }
      ]
    })
    return r.canceled ? null : r.filePaths[0]
  })
}
