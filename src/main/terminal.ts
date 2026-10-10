import { ipcMain, type WebContents } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { homedir } from 'os'
import { existsSync } from 'fs'
import type * as NodePty from 'node-pty'
import type { TermInfo } from '../shared/types'

/**
 * Real terminals via node-pty. If the native module cannot be loaded (missing
 * build tools, unsupported platform), fall back to a plain pipe shell so the
 * panel still works for simple commands.
 */

const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'

interface Session {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

const sessions = new Map<number, Session>()
let nextId = 1

let ptyModule: typeof NodePty | null | undefined
function loadPty(): typeof NodePty | null {
  if (ptyModule === undefined) {
    if (process.env.ECODE_NO_PTY) return (ptyModule = null)
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ptyModule = require('node-pty') as typeof NodePty
    } catch {
      ptyModule = null
    }
  }
  return ptyModule
}

function shellCommand(): { file: string; args: string[] } {
  if (isWin) return { file: process.env.ECODE_SHELL || 'powershell.exe', args: ['-NoLogo'] }
  return { file: process.env.ECODE_SHELL || process.env.SHELL || '/bin/bash', args: isMac ? ['-l'] : [] }
}

function shellEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'eCode'
  }
  // Don't leak Electron's own flags into user programs.
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  return env
}

/** Coalesce output chunks so a flood (e.g. `yes`) doesn't swamp IPC. */
function batcher(send: (data: string) => void): (chunk: string) => void {
  let buf = ''
  let scheduled = false
  return (chunk) => {
    buf += chunk
    if (scheduled) return
    scheduled = true
    setTimeout(() => {
      scheduled = false
      const out = buf
      buf = ''
      send(out)
    }, 4)
  }
}

function create(sender: WebContents, cwd: string | null, cols: number, rows: number): TermInfo {
  const dir = cwd && existsSync(cwd) ? cwd : homedir()
  const { file, args } = shellCommand()
  const id = nextId++
  const alive = (): boolean => !sender.isDestroyed()
  const emit = batcher((data) => alive() && sender.send('term:data', id, data))
  const exit = (code: number | null): void => {
    sessions.delete(id)
    if (alive()) sender.send('term:exit', id, code)
  }

  const pty = loadPty()
  if (pty) {
    try {
      const p = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: Math.max(2, cols),
        rows: Math.max(1, rows),
        cwd: dir,
        env: shellEnv() as Record<string, string>
      })
      p.onData(emit)
      p.onExit(({ exitCode }) => exit(exitCode))
      sessions.set(id, {
        write: (d) => p.write(d),
        resize: (c, r) => {
          try {
            p.resize(Math.max(2, c), Math.max(1, r))
          } catch {
            // The process may already be gone.
          }
        },
        kill: () => p.kill()
      })
      return { id, cwd: dir, shell: file, pty: true }
    } catch {
      // Fall through to the pipe shell.
    }
  }

  const child: ChildProcessWithoutNullStreams = spawn(
    file,
    isWin ? ['-NoLogo', '-NoProfile', '-Command', '-'] : [],
    { cwd: dir, env: { ...shellEnv(), TERM: 'dumb' }, detached: !isWin }
  )
  child.stdout.on('data', (b: Buffer) => emit(b.toString('utf8')))
  child.stderr.on('data', (b: Buffer) => emit(b.toString('utf8')))
  child.on('error', (err) => emit(`\r\n${err.message}\r\n`))
  child.on('exit', (code) => exit(code))
  sessions.set(id, {
    write: (d) => child.stdin.write(d),
    resize: () => {},
    kill: () => {
      try {
        if (!isWin && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill()
      } catch {
        child.kill()
      }
    }
  })
  return { id, cwd: dir, shell: file, pty: false }
}

function kill(id: number): void {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  try {
    s.kill()
  } catch {
    // Already exited.
  }
}

export function killAllTerminals(): void {
  for (const id of [...sessions.keys()]) kill(id)
}

export function registerTerminalHandlers(): void {
  ipcMain.handle('term:create', (e, cwd: string | null, cols: number, rows: number) =>
    create(e.sender, cwd, cols, rows)
  )
  ipcMain.on('term:write', (_e, id: number, data: string) => sessions.get(id)?.write(data))
  ipcMain.on('term:resize', (_e, id: number, cols: number, rows: number) => sessions.get(id)?.resize(cols, rows))
  ipcMain.on('term:kill', (_e, id: number) => kill(id))
}
