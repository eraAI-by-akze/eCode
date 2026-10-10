import { BrowserWindow, ipcMain } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { basename, sep } from 'path'
import { pathToFileURL } from 'url'
import type { LspServerId } from '../shared/types'

/**
 * Minimal Language Server Protocol host. Servers ship as npm packages and run
 * on Electron's bundled Node (ELECTRON_RUN_AS_NODE), so users need nothing
 * installed. The renderer talks LSP methods through IPC; this side owns the
 * process, the JSON-RPC framing and the handful of server→client requests.
 */

interface ServerDef {
  name: string
  script: string
  args: string[]
  initializationOptions?: () => unknown
}

/** In a packaged app, node_modules that spawn as processes live in app.asar.unpacked. */
function resolveUnpacked(request: string): string {
  return require.resolve(request).replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
}

const SERVERS: Record<LspServerId, ServerDef> = {
  typescript: {
    name: 'TypeScript',
    script: 'typescript-language-server/lib/cli.mjs',
    args: ['--stdio'],
    initializationOptions: () => ({
      tsserver: { path: resolveUnpacked('typescript/lib/tsserver.js') },
      preferences: { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true }
    })
  },
  python: {
    name: 'Pyright',
    script: 'pyright/langserver.index.js',
    args: ['--stdio']
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

class Connection {
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private pending = new Map<number, Pending>()

  constructor(
    private proc: ChildProcessWithoutNullStreams,
    private onNotification: (method: string, params: unknown) => void,
    private onRequest: (method: string, params: unknown) => unknown
  ) {
    proc.stdout.on('data', (chunk: Buffer) => this.read(chunk))
  }

  private write(msg: object): void {
    const json = JSON.stringify({ jsonrpc: '2.0', ...msg })
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`)
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params })
  }

  rejectAll(reason: string): void {
    for (const p of this.pending.values()) p.reject(new Error(reason))
    this.pending.clear()
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const m = /Content-Length:\s*(\d+)/i.exec(header)
      if (!m) {
        // Corrupt header; drop it and resync.
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const len = Number(m[1])
      const start = headerEnd + 4
      if (this.buffer.length < start + len) return
      const body = this.buffer.subarray(start, start + len).toString('utf8')
      this.buffer = this.buffer.subarray(start + len)
      try {
        this.dispatch(JSON.parse(body))
      } catch {
        // Ignore malformed messages.
      }
    }
  }

  private dispatch(msg: {
    id?: number | string
    method?: string
    params?: unknown
    result?: unknown
    error?: { message: string }
  }): void {
    if (msg.method && msg.id !== undefined) {
      let result: unknown = null
      let error: { code: number; message: string } | undefined
      try {
        result = this.onRequest(msg.method, msg.params)
      } catch (err) {
        error = { code: -32601, message: (err as Error).message }
      }
      this.write(error ? { id: msg.id, error } : { id: msg.id, result: result ?? null })
    } else if (msg.method) {
      this.onNotification(msg.method, msg.params)
    } else if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    }
  }
}

interface Running {
  root: string
  proc: ChildProcessWithoutNullStreams
  conn: Connection
  ready: Promise<{ capabilities: Record<string, unknown> }>
}

const running = new Map<LspServerId, Running>()

function start(id: LspServerId, root: string, getWindow: () => BrowserWindow | null): Running {
  const existing = running.get(id)
  if (existing && existing.root === root) return existing
  if (existing) stop(id)

  const def = SERVERS[id]
  const proc = spawn(process.execPath, [resolveUnpacked(def.script), ...def.args], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  const send = (channel: string, ...args: unknown[]): void => {
    const w = getWindow()
    if (w && !w.isDestroyed()) w.webContents.send(channel, id, ...args)
  }
  const rootUri = pathToFileURL(root).href
  const conn = new Connection(
    proc,
    (method, params) => {
      if (method !== 'window/logMessage' && method !== 'telemetry/event') send('lsp:notification', method, params)
    },
    (method, params) => {
      switch (method) {
        case 'workspace/configuration':
          return ((params as { items?: unknown[] })?.items ?? []).map(() => null)
        case 'workspace/workspaceFolders':
          return [{ uri: rootUri, name: basename(root) }]
        case 'window/workDoneProgress/create':
        case 'client/registerCapability':
        case 'client/unregisterCapability':
        case 'window/showMessageRequest':
          return null
        case 'workspace/applyEdit':
          return { applied: false }
        default:
          throw new Error(`Unhandled method ${method}`)
      }
    }
  )
  proc.stderr.on('data', () => {})
  proc.on('exit', (code) => {
    conn.rejectAll('Language server exited')
    if (running.get(id)?.proc === proc) {
      running.delete(id)
      send('lsp:exit', code)
    }
  })
  proc.on('error', () => conn.rejectAll('Language server failed to start'))

  const ready = conn
    .request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'eCode' },
      rootUri,
      rootPath: root,
      workspaceFolders: [{ uri: rootUri, name: basename(root) }],
      initializationOptions: def.initializationOptions?.(),
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        textDocument: {
          synchronization: { didSave: true, willSave: false, dynamicRegistration: false },
          completion: {
            contextSupport: true,
            completionItem: {
              snippetSupport: true,
              documentationFormat: ['markdown', 'plaintext'],
              deprecatedSupport: true,
              tagSupport: { valueSet: [1] },
              labelDetailsSupport: true,
              insertReplaceSupport: true,
              resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] }
            },
            completionItemKind: { valueSet: Array.from({ length: 25 }, (_, i) => i + 1) }
          },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          signatureHelp: {
            contextSupport: true,
            signatureInformation: {
              documentationFormat: ['markdown', 'plaintext'],
              parameterInformation: { labelOffsetSupport: true },
              activeParameterSupport: true
            }
          },
          definition: { linkSupport: true },
          typeDefinition: { linkSupport: true },
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
            symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) }
          },
          formatting: {},
          rangeFormatting: {},
          rename: { prepareSupport: false },
          publishDiagnostics: { relatedInformation: false, tagSupport: { valueSet: [1, 2] }, versionSupport: false }
        },
        workspace: { configuration: true, workspaceFolders: true, applyEdit: false },
        window: { workDoneProgress: true, showMessage: {} }
      }
    })
    .then((result) => {
      conn.notify('initialized', {})
      conn.notify('workspace/didChangeConfiguration', { settings: {} })
      return { capabilities: ((result as { capabilities?: Record<string, unknown> })?.capabilities ?? {}) }
    })

  const r: Running = { root, proc, conn, ready }
  running.set(id, r)
  return r
}

function stop(id: LspServerId): void {
  const r = running.get(id)
  if (!r) return
  running.delete(id)
  r.conn.rejectAll('Language server stopped')
  // Ask politely, then make sure it's gone.
  r.conn
    .request('shutdown', null)
    .catch(() => {})
    .finally(() => r.conn.notify('exit', null))
  setTimeout(() => {
    if (r.proc.exitCode === null) r.proc.kill()
  }, 1500)
}

export function stopAllLanguageServers(): void {
  for (const id of [...running.keys()]) {
    const r = running.get(id)
    running.delete(id)
    r?.proc.kill()
  }
}

export function registerLspHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('lsp:start', (_e, id: LspServerId, root: string) => {
    if (!SERVERS[id]) throw new Error(`Unknown language server ${id}`)
    return start(id, root, getWindow).ready
  })
  ipcMain.handle('lsp:request', (_e, id: LspServerId, method: string, params: unknown) => {
    const r = running.get(id)
    if (!r) throw new Error('Language server is not running')
    return r.ready.then(() => r.conn.request(method, params))
  })
  ipcMain.on('lsp:notify', (_e, id: LspServerId, method: string, params: unknown) => {
    const r = running.get(id)
    if (r) r.ready.then(() => r.conn.notify(method, params)).catch(() => {})
  })
  ipcMain.handle('lsp:stopAll', () => {
    for (const id of [...running.keys()]) stop(id)
  })
}
