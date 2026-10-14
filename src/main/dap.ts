import { ipcMain, type WebContents } from 'electron'
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process'
import type { DapAdapterSpec } from '../shared/types'
import { which } from './tasks'

/**
 * Debug Adapter Protocol host: starts an adapter (debugpy, netcoredbg, lldb-dap,
 * CodeLLDB, gdb) on stdio and relays framed JSON both ways. The renderer owns
 * the protocol (requests, sequence numbers, session state).
 */

interface Adapter {
  proc: ChildProcessWithoutNullStreams
  buffer: Buffer
}

const adapters = new Map<number, Adapter>()
let nextId = 1

function send(sender: WebContents, channel: string, ...args: unknown[]): void {
  if (!sender.isDestroyed()) sender.send(channel, ...args)
}

async function start(sender: WebContents, spec: DapAdapterSpec): Promise<number> {
  const id = nextId++
  // Resolve through PATH(EXT) so `.cmd` shims and Homebrew tools work.
  const program = (await which(spec.command)) ?? spec.command
  const proc = spawn(program, spec.args ?? [], {
    cwd: spec.cwd || undefined,
    env: { ...process.env, ...(spec.env ?? {}) },
    windowsHide: true
  })
  const a: Adapter = { proc, buffer: Buffer.alloc(0) }
  adapters.set(id, a)
  proc.stdout.on('data', (chunk: Buffer) => {
    a.buffer = Buffer.concat([a.buffer, chunk])
    for (;;) {
      const headerEnd = a.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const m = /Content-Length:\s*(\d+)/i.exec(a.buffer.subarray(0, headerEnd).toString('ascii'))
      if (!m) {
        a.buffer = a.buffer.subarray(headerEnd + 4)
        continue
      }
      const start = headerEnd + 4
      const len = Number(m[1])
      if (a.buffer.length < start + len) return
      const body = a.buffer.subarray(start, start + len).toString('utf8')
      a.buffer = a.buffer.subarray(start + len)
      try {
        send(sender, 'dap:message', id, JSON.parse(body))
      } catch {
        // Malformed message: skip it.
      }
    }
  })
  proc.stderr.on('data', (chunk: Buffer) => send(sender, 'dap:stderr', id, chunk.toString('utf8')))
  proc.stdin.on('error', () => {})
  proc.on('error', (err: NodeJS.ErrnoException) =>
    send(sender, 'dap:stderr', id, err.code === 'ENOENT' ? `${spec.command}: не найден\n` : `${err.message}\n`)
  )
  proc.on('close', (code) => {
    adapters.delete(id)
    send(sender, 'dap:exit', id, code)
  })
  return id
}

function write(id: number, msg: unknown): void {
  const a = adapters.get(id)
  if (!a) return
  const json = JSON.stringify(msg)
  a.proc.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`)
}

function stop(id: number): void {
  const a = adapters.get(id)
  if (!a?.proc.pid) return
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(a.proc.pid), '/T', '/F'], () => {})
  else a.proc.kill()
}

export function stopAllAdapters(): void {
  for (const id of [...adapters.keys()]) stop(id)
}

export function registerDapHandlers(): void {
  ipcMain.handle('dap:start', (e, spec: DapAdapterSpec) => start(e.sender, spec))
  ipcMain.on('dap:send', (_e, id: number, msg: unknown) => write(id, msg))
  ipcMain.on('dap:stop', (_e, id: number) => stop(id))
}
