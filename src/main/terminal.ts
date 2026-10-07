import { ipcMain, type WebContents } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { homedir } from 'os'
import { existsSync } from 'fs'

/**
 * A lightweight pipe-based shell (no native PTY dependency). Each command the
 * renderer sends is followed by a marker that echoes the working directory, so
 * the UI knows when a command finished and where the shell is now.
 */

const isWin = process.platform === 'win32'
const sessions = new Map<number, ChildProcessWithoutNullStreams>()
let nextId = 1

function shellCommand(): { file: string; args: string[] } {
  if (isWin) return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'] }
  return { file: process.env.SHELL || '/bin/bash', args: [] }
}

export function markerCommand(): string {
  return isWin
    ? "Write-Host ([char]30 + 'CWD:' + (Get-Location).Path + [char]31)"
    : "printf '\\036CWD:%s\\037\\n' \"$PWD\""
}

function create(sender: WebContents, cwd: string | null): { id: number; cwd: string; shell: string } {
  const dir = cwd && existsSync(cwd) ? cwd : homedir()
  const { file, args } = shellCommand()
  const child = spawn(file, args, {
    cwd: dir,
    env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0', PAGER: 'cat', GIT_PAGER: 'cat' },
    detached: !isWin
  })
  const id = nextId++
  sessions.set(id, child)
  const forward = (chunk: Buffer): void => {
    if (!sender.isDestroyed()) sender.send('term:data', id, chunk.toString('utf8'))
  }
  child.stdout.on('data', forward)
  child.stderr.on('data', forward)
  child.on('error', (err) => {
    if (!sender.isDestroyed()) sender.send('term:data', id, `\n${err.message}\n`)
  })
  child.on('exit', (code) => {
    sessions.delete(id)
    if (!sender.isDestroyed()) sender.send('term:exit', id, code)
  })
  return { id, cwd: dir, shell: file }
}

function kill(id: number): void {
  const child = sessions.get(id)
  if (!child) return
  sessions.delete(id)
  try {
    if (!isWin && child.pid) process.kill(-child.pid, 'SIGKILL')
    else child.kill()
  } catch {
    child.kill()
  }
}

export function killAllTerminals(): void {
  for (const id of [...sessions.keys()]) kill(id)
}

export function registerTerminalHandlers(): void {
  ipcMain.handle('term:create', (e, cwd: string | null) => create(e.sender, cwd))
  ipcMain.on('term:write', (_e, id: number, command: string) => {
    const child = sessions.get(id)
    if (!child) return
    child.stdin.write(`${command}\n${markerCommand()}\n`)
  })
  ipcMain.on('term:kill', (_e, id: number) => kill(id))
}
