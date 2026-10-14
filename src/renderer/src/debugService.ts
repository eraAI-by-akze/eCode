import type { PluginDebugger, PluginTask } from '@shared/types'
import { getState, setState, type Breakpoint, type ConsoleLine, type DebugFrame, type DebugSessionState } from './store'
import { getFileIndex, openFile, save, toast, pick } from './actions'
import { pluginDebuggers, type Contributed } from './pluginService'
import { availableTasks, captureCommand, resolveVars, runTaskAndWait } from './taskService'
import { runInDedicatedTerminal } from './terminalService'
import { parseJsonc } from './lib/jsonc'
import { matchGlob } from './lib/glob'
import { basename, dirname, isUntitled, relative } from './lib/path'

/**
 * Debugging over the Debug Adapter Protocol. The backend only spawns the
 * adapter and relays messages; sessions, breakpoints and launch configurations
 * live here. Adapters come from plugins (debugpy, netcoredbg, CodeLLDB,
 * lldb-dap, gdb) and .vscode/launch.json is honoured.
 */

const api = window.ecode
const isWin = api.platform === 'win32'
const sep = api.pathSep

// ─────────────────────────── launch configurations ───────────────────────────

export interface LaunchConfig {
  /** Stable key for the picker and "last used" memory. */
  id: string
  name: string
  type: string
  request: 'launch' | 'attach'
  source: 'launch.json' | 'plugin'
  /** Adapters that can run it, best first. */
  candidates: Contributed<PluginDebugger>[]
  args: Record<string, unknown>
  preLaunchTask?: string
}

/** Every debugger that answers to a launch.json `type`. */
function debuggersFor(type: string): Contributed<PluginDebugger>[] {
  return pluginDebuggers().filter(({ item }) => item.type === type || item.types?.includes(type))
}

async function readLaunchJson(): Promise<LaunchConfig[]> {
  const root = getState().root
  if (!root) return []
  const out: LaunchConfig[] = []
  for (const dir of ['.ecode', '.vscode']) {
    const r = await api.readFile(`${root}${sep}${dir}${sep}launch.json`).catch(() => null)
    if (!r?.content) continue
    let json: { configurations?: Record<string, unknown>[] }
    try {
      json = parseJsonc(r.content)
    } catch {
      toast(`${dir}/launch.json: ошибка разбора JSON`, 'error')
      continue
    }
    for (const c of json.configurations ?? []) {
      const type = String(c.type ?? '')
      const request = c.request === 'attach' ? 'attach' : 'launch'
      const name = String(c.name ?? type)
      // Platform overrides, as in VS Code.
      const plat = isWin ? c.windows : api.platform === 'darwin' ? c.osx : c.linux
      const args = { ...c, ...(plat && typeof plat === 'object' ? plat : {}) } as Record<string, unknown>
      for (const k of ['windows', 'osx', 'linux', 'preLaunchTask', 'postDebugTask', 'presentation']) delete args[k]
      out.push({
        id: `launch:${dir}:${name}`,
        name,
        type,
        request,
        source: 'launch.json',
        candidates: debuggersFor(type),
        args,
        preLaunchTask: typeof c.preLaunchTask === 'string' ? c.preLaunchTask : undefined
      })
    }
  }
  return out
}

async function pluginConfigs(): Promise<LaunchConfig[]> {
  const { root, language } = getState()
  const rels = root ? (await getFileIndex()).map((f) => relative(root, f)) : []
  return pluginDebuggers()
    .filter(({ item }) => item.languages.includes(language) || item.when?.files?.some((g) => rels.some((r) => matchGlob(g, r))))
    .map((d) => ({
      id: `plugin:${d.item.type}`,
      name: d.item.label,
      type: d.item.type,
      request: 'launch' as const,
      source: 'plugin' as const,
      candidates: [d],
      args: { ...d.item.launch },
      preLaunchTask: d.item.preLaunchTask
    }))
}

export async function launchConfigs(): Promise<LaunchConfig[]> {
  return [...(await readLaunchJson()), ...(await pluginConfigs())]
}

// ─────────────────────────── adapters ───────────────────────────

const adapterCache = new Map<string, string | null>()

async function findExecutable(command: string, dir: string): Promise<string | null> {
  const key = `${dir}|${command}`
  if (adapterCache.has(key)) return adapterCache.get(key)!
  let found: string | null = null
  const home = /^~[/\\]/.test(command) ? await api.homeDir() : ''
  const expanded = command.replace(/^~(?=[/\\])/, home).replace('${pluginDir}', dir)
  if (/[/\\]/.test(expanded)) found = (await api.stat(expanded).catch(() => null)) ? expanded : null
  else found = await api.which(expanded).catch(() => null)
  adapterCache.set(key, found)
  return found
}

/** The first candidate whose adapter executable exists. */
async function pickAdapter(config: LaunchConfig): Promise<{ dbg: Contributed<PluginDebugger>; command: string } | null> {
  for (const c of config.candidates) {
    const commands = Array.isArray(c.item.adapter.command) ? c.item.adapter.command : [c.item.adapter.command]
    for (const raw of commands) {
      // `${python}` and friends: resolved like task variables.
      const cmd = raw.includes('${') ? await resolveVars(raw, c.dir).catch(() => raw) : raw
      const path = await findExecutable(cmd, c.dir)
      if (path) return { dbg: c, command: path }
    }
  }
  return null
}

/** Is any adapter for this configuration installed? (Cached; for the picker.) */
export async function isAvailable(config: LaunchConfig): Promise<boolean> {
  return !!(await pickAdapter(config))
}

// ─────────────────────────── project variables ───────────────────────────

/** The nearest project file (walking up from the open file), else the shallowest in the workspace. */
async function nearestProject(pattern: RegExp): Promise<string | null> {
  const { root, active } = getState()
  if (!root) return null
  const files = (await getFileIndex()).filter((f) => pattern.test(basename(f)))
  if (!files.length) return null
  if (active && !isUntitled(active)) {
    let dir = dirname(active)
    while (dir.length >= root.length) {
      const hit = files.find((f) => dirname(f) === dir)
      if (hit) return hit
      const up = dirname(dir)
      if (up === dir) break
      dir = up
    }
  }
  return [...files].sort((a, b) => a.split(/[/\\]/).length - b.split(/[/\\]/).length)[0]
}

async function readText(path: string): Promise<string> {
  return (await api.readFile(path).catch(() => null))?.content ?? ''
}

/** target/debug/<package> for the nearest crate (workspace target dir respected). */
async function cargoVars(): Promise<Record<string, string>> {
  const toml = await nearestProject(/^Cargo\.toml$/)
  if (!toml) throw new Error('В проекте нет Cargo.toml')
  const crateDir = dirname(toml)
  const text = await readText(toml)
  const pkg = /\[package\][^[]*?\bname\s*=\s*"([^"]+)"/s.exec(text)?.[1]
  const bin = /\[\[bin\]\][^[]*?\bname\s*=\s*"([^"]+)"/s.exec(text)?.[1]
  const name = bin ?? pkg
  if (!name) throw new Error(`${relative(getState().root ?? '', toml)}: не найдено имя пакета`)
  // A [workspace] Cargo.toml higher up owns the target folder.
  let targetBase = crateDir
  const root = getState().root ?? crateDir
  for (let dir = dirname(crateDir); dir.length >= root.length && dir !== dirname(dir); dir = dirname(dir)) {
    if (/^\s*\[workspace\]/m.test(await readText(`${dir}${sep}Cargo.toml`))) targetBase = dir
  }
  return { cargoDir: crateDir, cargoTarget: `${targetBase}${sep}target${sep}debug${sep}${name}${isWin ? '.exe' : ''}` }
}

let sysroot: string | null = null
async function rustSysroot(cwd: string): Promise<string> {
  if (sysroot) return sysroot
  const r = await captureCommand('rustc --print sysroot', cwd).catch(() => null)
  sysroot = r?.code === 0 ? r.out.trim().split('\n').pop()!.trim() : ''
  return sysroot
}

/** bin/Debug/<tfm>/<assembly>.dll for the nearest .csproj/.fsproj. */
async function dotnetVars(): Promise<Record<string, string>> {
  const proj = await nearestProject(/\.(cs|fs|vb)proj$/)
  if (!proj) throw new Error('В проекте нет .csproj')
  const dir = dirname(proj)
  const text = await readText(proj)
  const name = /<AssemblyName>\s*([^<]+?)\s*<\/AssemblyName>/.exec(text)?.[1] ?? basename(proj).replace(/\.\w+proj$/, '')
  const tfms = (/<TargetFrameworks?>\s*([^<]+?)\s*<\/TargetFrameworks?>/.exec(text)?.[1] ?? '').split(';').filter(Boolean)
  let tfm = tfms[0]
  if (!tfm) {
    // Set in Directory.Build.props: take whatever the build produced.
    const built = await api.readDir(`${dir}${sep}bin${sep}Debug`).catch(() => [])
    tfm = built.find((e) => e.isDir)?.name ?? 'net8.0'
  }
  return { dotnetProjectDir: dir, dotnetTarget: `${dir}${sep}bin${sep}Debug${sep}${tfm}${sep}${name}.dll` }
}

/** Resolve ${…} in every string of a launch configuration. */
async function resolveDeep(value: unknown, pluginDir: string, extra: Record<string, string>): Promise<unknown> {
  if (typeof value === 'string') {
    let s = value.replace(/\$\{(\w+)\}/g, (m, k: string) => extra[k] ?? m)
    s = s.replace(/\$\{env:(\w+)\}/g, () => '')
    return resolveVars(s, pluginDir)
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => resolveDeep(v, pluginDir, extra)))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = await resolveDeep(v, pluginDir, extra)
    return out
  }
  return value
}

async function projectVars(config: LaunchConfig): Promise<Record<string, string>> {
  const text = JSON.stringify(config.args)
  const vars: Record<string, string> = {}
  if (/\$\{cargo(Target|Dir)\}|\$\{rustSysroot\}/.test(text)) Object.assign(vars, await cargoVars())
  if (/\$\{rustSysroot\}/.test(text)) vars.rustSysroot = await rustSysroot(vars.cargoDir ?? getState().root ?? '')
  if (/\$\{dotnet(Target|ProjectDir)\}/.test(text)) Object.assign(vars, await dotnetVars())
  return vars
}

// ─────────────────────────── session ───────────────────────────

type DapMessage = Record<string, unknown> & { seq: number; type: string }
type Body = Record<string, unknown>

interface Pending {
  resolve: (body: Body) => void
  reject: (err: Error) => void
}

class Session {
  seq = 1
  pending = new Map<number, Pending>()
  caps: Body = {}
  configured = false
  /** Adapter breakpoint id → ours, for `breakpoint` events. */
  bpIds = new Map<number, string>()
  initialized: Promise<void>
  markInitialized!: () => void
  ended = false

  constructor(
    public adapter: number,
    public config: LaunchConfig,
    public adapterType: string
  ) {
    this.initialized = new Promise((r) => (this.markInitialized = r))
  }

  request<T extends Body = Body>(command: string, args?: unknown, timeoutMs = 0): Promise<T> {
    const seq = this.seq++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(seq, { resolve: resolve as (b: Body) => void, reject })
      api.dapSend(this.adapter, { seq, type: 'request', command, arguments: args ?? {} })
      if (timeoutMs) {
        setTimeout(() => {
          if (this.pending.delete(seq)) reject(new Error(`${command}: нет ответа`))
        }, timeoutMs)
      }
    })
  }

  respond(req: DapMessage, success: boolean, body: Body = {}, message?: string): void {
    api.dapSend(this.adapter, {
      seq: this.seq++,
      type: 'response',
      request_seq: req.seq,
      command: req.command,
      success,
      body,
      ...(message ? { message } : {})
    })
  }

  failAll(reason: string): void {
    for (const p of this.pending.values()) p.reject(new Error(reason))
    this.pending.clear()
  }
}

let session: Session | null = null
let listening = false
let consoleId = 1

function patchDebug(patch: Partial<DebugSessionState>): void {
  setState((s) => (s.debug ? { debug: { ...s.debug, ...patch } } : {}))
}

export function log(kind: ConsoleLine['kind'], text: string, ref?: number): void {
  setState((s) => {
    const lines = s.debugConsole
    const last = lines[lines.length - 1]
    // Program output arrives in chunks: keep appending to an unfinished line.
    if (last && last.kind === kind && (kind === 'stdout' || kind === 'stderr') && !last.text.endsWith('\n')) {
      return { debugConsole: [...lines.slice(0, -1), { ...last, text: last.text + text }] }
    }
    return { debugConsole: [...lines, { id: consoleId++, kind, text, ref }].slice(-2000) }
  })
}

function errorText(msg: DapMessage): string {
  const body = msg.body as { error?: { format?: string; variables?: Record<string, string> } } | undefined
  const fmt = body?.error?.format
  if (fmt) return fmt.replace(/\{(\w+)\}/g, (_m, k: string) => body?.error?.variables?.[k] ?? `{${k}}`)
  return String(msg.message ?? 'ошибка')
}

function listen(): void {
  if (listening) return
  listening = true
  api.onDapMessage((id, raw) => {
    if (session?.adapter === id) void handle(session, raw as DapMessage)
  })
  api.onDapStderr((id, data) => {
    if (session?.adapter === id) log('stderr', data)
  })
  api.onDapExit((id, code) => {
    if (session?.adapter !== id) return
    session.failAll('Отладчик завершился')
    if (!session.ended) log('info', `Отладчик завершился${code ? ` с кодом ${code}` : ''}\n`)
    end()
  })
}

async function handle(s: Session, msg: DapMessage): Promise<void> {
  if (msg.type === 'response') {
    const p = s.pending.get(msg.request_seq as number)
    if (!p) return
    s.pending.delete(msg.request_seq as number)
    if (msg.success) p.resolve((msg.body as Body) ?? {})
    else p.reject(new Error(errorText(msg)))
    return
  }
  if (msg.type === 'request') return reverseRequest(s, msg)
  if (msg.type !== 'event') return
  const body = (msg.body ?? {}) as Body
  switch (msg.event) {
    case 'initialized':
      s.markInitialized()
      break
    case 'capabilities':
      Object.assign(s.caps, body.capabilities ?? {})
      break
    case 'stopped':
      await onStopped(s, body)
      break
    case 'continued':
      if (body.allThreadsContinued !== false || body.threadId === getState().debug?.threadId) onRunning()
      break
    case 'output': {
      const cat = String(body.category ?? 'console')
      if (cat === 'telemetry') break
      const text = String(body.output ?? '')
      log(cat === 'stdout' ? 'stdout' : cat === 'stderr' ? 'stderr' : cat === 'important' ? 'error' : 'console', text)
      break
    }
    case 'breakpoint': {
      const bp = body.breakpoint as { id?: number; verified?: boolean; line?: number; message?: string } | undefined
      const ours = bp?.id !== undefined ? s.bpIds.get(bp.id) : undefined
      if (ours) {
        setState((st) => ({
          breakpoints: st.breakpoints.map((b) =>
            b.id === ours ? { ...b, verified: bp!.verified, message: bp!.message, line: bp!.line ?? b.line } : b
          )
        }))
      }
      break
    }
    case 'exited':
      log('info', `Процесс завершён с кодом ${body.exitCode ?? '?'}\n`)
      break
    case 'terminated':
      void stopDebugging()
      break
  }
}

async function reverseRequest(s: Session, req: DapMessage): Promise<void> {
  const args = (req.arguments ?? {}) as Body
  if (req.command === 'runInTerminal') {
    try {
      await runInDedicatedTerminal('debug', String(args.title || 'Отладка'), terminalCommand(args))
      s.respond(req, true, {})
    } catch (err) {
      s.respond(req, false, {}, String(err))
    }
    return
  }
  s.respond(req, false, {}, `${String(req.command)} не поддерживается`)
}

/** A shell line for the integrated terminal from a runInTerminal request. */
function terminalCommand(args: Body): string {
  const argv = ((args.args as string[]) ?? []).map(String)
  const env = (args.env ?? {}) as Record<string, string | null>
  const cwd = String(args.cwd ?? '')
  if (isWin) {
    const q = (v: string): string => `'${v.replace(/'/g, "''")}'`
    const envs = Object.entries(env).map(([k, v]) => (v === null ? `Remove-Item Env:${k} -ErrorAction Ignore; ` : `$env:${k}=${q(v)}; `))
    return `${cwd ? `cd ${q(cwd)}; ` : ''}${envs.join('')}& ${argv.map(q).join(' ')}`
  }
  const q = (v: string): string => (/^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`)
  const envs = Object.entries(env).map(([k, v]) => (v === null ? `-u ${k}` : `${k}=${q(v)}`))
  return `${cwd ? `cd ${q(cwd)} && ` : ''}${envs.length ? `env ${envs.join(' ')} ` : ''}${argv.map(q).join(' ')}`
}

function onRunning(): void {
  patchDebug({ status: 'running', frames: [], frameId: undefined, stopReason: undefined, exception: undefined })
}

async function onStopped(s: Session, body: Body): Promise<void> {
  try {
    const threads = ((await s.request<{ threads: { id: number; name: string }[] }>('threads')).threads ?? []).map((t) => ({
      id: t.id,
      name: t.name
    }))
    const threadId = (body.threadId as number | undefined) ?? getState().debug?.threadId ?? threads[0]?.id
    if (threadId === undefined) return
    const st = await s.request<{ stackFrames: { id: number; name: string; line: number; column: number; source?: { path?: string } }[] }>(
      'stackTrace',
      { threadId, startFrame: 0, levels: 64 }
    )
    const frames: DebugFrame[] = (st.stackFrames ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      path: f.source?.path,
      line: f.line,
      column: f.column || 1
    }))
    const reason = String(body.reason ?? 'pause')
    let exception: string | undefined
    if (reason === 'exception') {
      exception = String(body.text ?? body.description ?? 'Исключение')
      if (s.caps.supportsExceptionInfoRequest) {
        const info = await s.request<{ exceptionId?: string; description?: string }>('exceptionInfo', { threadId }).catch(() => null)
        if (info) exception = [info.exceptionId, info.description].filter(Boolean).join(': ')
      }
    }
    const top = frames.find((f) => f.path)
    setState((st2) => ({
      debug: st2.debug && {
        ...st2.debug,
        status: 'paused',
        threads,
        threadId,
        frames,
        frameId: top?.id,
        stopReason: reason,
        exception,
        stopSeq: st2.debug.stopSeq + 1
      }
    }))
    if (top?.path) await openFile(top.path, { line: top.line, column: top.column })
  } catch (err) {
    log('error', `Не удалось получить стек: ${(err as Error).message}\n`)
  }
}

// ─────────────────────────── breakpoints ───────────────────────────

let bpId = 1

function storeKey(kind: string): string | null {
  const root = getState().root
  return root ? `ecode.${kind}:${root}` : null
}

export function loadBreakpoints(): void {
  const key = storeKey('breakpoints')
  let breakpoints: Breakpoint[] = []
  let watches: string[] = []
  try {
    if (key) breakpoints = JSON.parse(localStorage.getItem(key) ?? '[]')
    const wk = storeKey('watches')
    if (wk) watches = JSON.parse(localStorage.getItem(wk) ?? '[]')
  } catch {
    breakpoints = []
  }
  setState({
    breakpoints: breakpoints.map((b) => ({ ...b, id: `bp${bpId++}`, verified: undefined, message: undefined })),
    watches
  })
}

function persist(): void {
  const { breakpoints, watches } = getState()
  try {
    const key = storeKey('breakpoints')
    if (key) localStorage.setItem(key, JSON.stringify(breakpoints.map(({ path, line, enabled, condition, logMessage }) => ({ path, line, enabled, condition, logMessage }))))
    const wk = storeKey('watches')
    if (wk) localStorage.setItem(wk, JSON.stringify(watches))
  } catch {
    // Storage unavailable: breakpoints just don't survive a restart.
  }
}

function updateBreakpoints(next: Breakpoint[], paths: string[]): void {
  setState({ breakpoints: next })
  persist()
  for (const p of new Set(paths)) void sendBreakpoints(p)
}

export function toggleBreakpoint(path: string, line: number): void {
  const list = getState().breakpoints
  const hit = list.find((b) => b.path === path && b.line === line)
  updateBreakpoints(hit ? list.filter((b) => b !== hit) : [...list, { id: `bp${bpId++}`, path, line, enabled: true }], [path])
}

export function setBreakpointOptions(path: string, line: number, opts: { condition?: string; logMessage?: string }): void {
  const list = getState().breakpoints
  const hit = list.find((b) => b.path === path && b.line === line)
  const clean = { condition: opts.condition || undefined, logMessage: opts.logMessage || undefined }
  updateBreakpoints(
    hit ? list.map((b) => (b === hit ? { ...b, ...clean, enabled: true } : b)) : [...list, { id: `bp${bpId++}`, path, line, enabled: true, ...clean }],
    [path]
  )
}

export function setBreakpointEnabled(id: string, enabled: boolean): void {
  const list = getState().breakpoints
  const bp = list.find((b) => b.id === id)
  if (bp) updateBreakpoints(list.map((b) => (b.id === id ? { ...b, enabled } : b)), [bp.path])
}

export function removeBreakpoint(id: string): void {
  const list = getState().breakpoints
  const bp = list.find((b) => b.id === id)
  if (bp) updateBreakpoints(list.filter((b) => b.id !== id), [bp.path])
}

export function removeAllBreakpoints(): void {
  const paths = getState().breakpoints.map((b) => b.path)
  updateBreakpoints([], paths)
}

/** Breakpoint lines moved by edits (from the editor's sticky decorations). */
export function moveBreakpoints(path: string, lines: Map<string, number>): void {
  let changed = false
  const next = getState().breakpoints.map((b) => {
    const line = lines.get(b.id)
    if (b.path !== path || line === undefined || line === b.line) return b
    changed = true
    return { ...b, line }
  })
  if (changed) {
    setState({ breakpoints: next })
    persist()
  }
}

async function sendBreakpoints(path: string): Promise<void> {
  const s = session
  if (!s || !s.configured) return
  const bps = getState().breakpoints.filter((b) => b.path === path && b.enabled)
  try {
    const res = await s.request<{ breakpoints?: { id?: number; verified: boolean; line?: number; message?: string }[] }>('setBreakpoints', {
      source: { path, name: basename(path) },
      breakpoints: bps.map((b) => ({
        line: b.line,
        ...(b.condition && s.caps.supportsConditionalBreakpoints !== false ? { condition: b.condition } : {}),
        ...(b.logMessage && s.caps.supportsLogPoints ? { logMessage: b.logMessage } : {})
      })),
      lines: bps.map((b) => b.line),
      sourceModified: false
    })
    const results = res.breakpoints ?? []
    setState((st) => ({
      breakpoints: st.breakpoints.map((b) => {
        const i = bps.findIndex((x) => x.id === b.id)
        const r = i >= 0 ? results[i] : undefined
        if (!r) return b
        if (r.id !== undefined) s.bpIds.set(r.id, b.id)
        return { ...b, verified: r.verified, message: r.message, line: r.line ?? b.line }
      })
    }))
  } catch (err) {
    log('error', `${basename(path)}: ${(err as Error).message}\n`)
  }
}

// ─────────────────────────── start / stop ───────────────────────────

function rememberKey(): string | null {
  return storeKey('debugConfig')
}

function remembered(): string | null {
  try {
    const k = rememberKey()
    return k ? localStorage.getItem(k) : null
  } catch {
    return null
  }
}

function remember(id: string): void {
  setState({ debugConfig: id })
  try {
    const k = rememberKey()
    if (k) localStorage.setItem(k, id)
  } catch {
    // ignore
  }
}

async function findTask(name: string): Promise<Contributed<PluginTask> | undefined> {
  const tasks = await availableTasks()
  const exact = tasks.find((t) => t.item.id === name || t.item.label === name)
  if (exact) return exact
  // VS Code projects usually call their build task "build".
  if (/build/i.test(name)) return tasks.find((t) => t.item.group === 'build')
  return undefined
}

/** Pick a configuration (or reuse the remembered one) and start. */
export async function startDebugging(configId?: string): Promise<void> {
  if (session) {
    if (getState().debug?.status === 'paused') return continueExecution()
    toast('Отладка уже идёт')
    return
  }
  if (!getState().root) {
    toast('Откройте папку проекта', 'error')
    return
  }
  const configs = await launchConfigs()
  if (!configs.length) {
    toast('Нет конфигурации отладки: откройте файл Python, C# или Rust, или добавьте .vscode/launch.json', 'error')
    return
  }
  // "?" forces the picker (palette command "choose configuration").
  const forcePick = configId === '?'
  const want = forcePick ? null : configId ?? getState().debugConfig ?? remembered()
  let config = configs.find((c) => c.id === want)
  if (!config) {
    const available: LaunchConfig[] = []
    for (const c of configs) if (await isAvailable(c)) available.push(c)
    if (!forcePick && available.length === 1) config = available[0]
    else {
      // Installed debuggers first.
      const ordered = [...available, ...configs.filter((c) => !available.includes(c))]
      pick(
        'Конфигурация отладки',
        ordered.map((c) => ({
          id: c.id,
          label: c.name,
          detail: c.source === 'launch.json' ? 'launch.json' : c.candidates[0]?.plugin.name,
          hint: available.includes(c) ? c.type : 'не установлен'
        })),
        (id) => void startDebugging(id)
      )
      return
    }
  }
  remember(config.id)
  await launch(config)
}

async function launch(config: LaunchConfig): Promise<void> {
  listen()
  const adapter = await pickAdapter(config)
  if (!adapter) {
    const hint = config.candidates.map((c) => c.item.install).find(Boolean)
    const resolved = hint ? await resolveVars(hint, config.candidates[0].dir).catch(() => hint) : ''
    toast(
      config.candidates.length
        ? `Отладчик для «${config.name}» не найден.${resolved ? ` Установите: ${resolved}` : ''}`
        : `Нет отладчика для типа «${config.type}». Включите плагин или установите расширение.`,
      'error'
    )
    return
  }
  const { dbg } = adapter
  for (const t of getState().tabs) if (t.dirty) await save(t.path)

  setState({
    debug: { status: 'starting', name: config.name, type: dbg.item.type, threads: [], frames: [], stopSeq: 0 },
    debugConsole: [],
    breakpoints: getState().breakpoints.map((b) => ({ ...b, verified: undefined, message: undefined })),
    sidebar: 'debug'
  })
  log('info', `▶ ${config.name}\n`)

  const preLaunch = config.preLaunchTask ?? (config.source === 'plugin' ? dbg.item.preLaunchTask : undefined)
  if (preLaunch) {
    const task = await findTask(preLaunch)
    if (!task) log('info', `Задача «${preLaunch}» не найдена, запускаю без неё\n`)
    else {
      const code = await runTaskAndWait(task)
      if (code !== 0) {
        toast(`${task.item.label}: сборка не удалась, отладка отменена`, 'error')
        setState({ debug: null })
        return
      }
    }
  }

  let args: Record<string, unknown>
  try {
    const extra = await projectVars(config)
    args = (await resolveDeep({ ...config.args }, dbg.dir, extra)) as Record<string, unknown>
  } catch (err) {
    toast((err as Error).message, 'error')
    setState({ debug: null })
    return
  }
  args.name ??= config.name
  args.type ??= config.type
  args.request = config.request

  const adapterArgs = (await resolveDeep(dbg.item.adapter.args ?? [], dbg.dir, {})) as string[]
  let id: number
  try {
    id = await api.dapStart({ command: adapter.command, args: adapterArgs, cwd: getState().root ?? undefined, env: dbg.item.adapter.env })
  } catch (err) {
    toast(`Не удалось запустить отладчик: ${(err as Error).message}`, 'error')
    setState({ debug: null })
    return
  }
  const s = new Session(id, config, dbg.item.type)
  session = s
  const usesTerminal = args.console === 'integratedTerminal' || args.console === 'externalTerminal'
  if (!usesTerminal) setState({ panelOpen: true, panelTab: 'debug' })

  try {
    s.caps = await s.request(
      'initialize',
      {
        clientID: 'ecode',
        clientName: 'eCode',
        adapterID: dbg.item.type,
        locale: 'ru',
        pathFormat: 'path',
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
        supportsVariablePaging: false,
        supportsRunInTerminalRequest: true,
        supportsInvalidatedEvent: false,
        supportsProgressReporting: false,
        supportsMemoryReferences: false,
        supportsArgsCanBeInterpretedByShell: false,
        supportsStartDebuggingRequest: false
      },
      20000
    )
    // Adapters answer `launch` only after configurationDone, so don't wait for it here.
    const launched = s.request(config.request, args)
    launched.catch(() => {})
    const timeout = new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('отладчик не ответил за 30 с')), 30000))
    await Promise.race([s.initialized, launched.then(() => s.initialized), timeout])
    s.configured = true
    const paths = new Set(getState().breakpoints.filter((b) => b.enabled).map((b) => b.path))
    await Promise.all([...paths].map((p) => sendBreakpoints(p)))
    const filters = (s.caps.exceptionBreakpointFilters as { filter: string; default?: boolean }[] | undefined) ?? []
    if (filters.length) {
      await s.request('setExceptionBreakpoints', { filters: filters.filter((f) => f.default).map((f) => f.filter) }).catch(() => {})
    }
    if (s.caps.supportsConfigurationDoneRequest) await s.request('configurationDone')
    await launched
    if (getState().debug?.status === 'starting') patchDebug({ status: 'running' })
  } catch (err) {
    if (session !== s) return
    const msg = (err as Error).message
    log('error', `${msg}\n`)
    toast(`Отладка: ${msg}`, 'error')
    await stopDebugging()
  }
}

function end(): void {
  if (session) {
    session.ended = true
    session.failAll('Отладка остановлена')
  }
  session = null
  setState((s) => ({
    debug: null,
    breakpoints: s.breakpoints.map((b) => ({ ...b, verified: undefined, message: undefined }))
  }))
}

export async function stopDebugging(): Promise<void> {
  const s = session
  if (!s || s.ended) return
  s.ended = true
  patchDebug({ status: 'stopping' })
  try {
    await s.request('disconnect', { restart: false, terminateDebuggee: true }, 2500)
  } catch {
    // The adapter may already be gone.
  }
  setTimeout(() => api.dapStop(s.adapter), 600)
  if (session === s) {
    log('info', '■ Отладка остановлена\n')
    end()
  }
}

export async function restartDebugging(): Promise<void> {
  const s = session
  if (!s) return startDebugging()
  const config = s.config
  await stopDebugging()
  await new Promise((r) => setTimeout(r, 300))
  await launch(config)
}

// ─────────────────────────── stepping ───────────────────────────

function threadArgs(): { threadId: number } | null {
  const t = getState().debug?.threadId
  return t === undefined ? null : { threadId: t }
}

async function step(command: 'continue' | 'next' | 'stepIn' | 'stepOut'): Promise<void> {
  const s = session
  const args = threadArgs()
  if (!s || !args || getState().debug?.status !== 'paused') return
  onRunning()
  try {
    await s.request(command, args)
  } catch (err) {
    log('error', `${command}: ${(err as Error).message}\n`)
  }
}

export const continueExecution = (): Promise<void> => step('continue')
export const stepOver = (): Promise<void> => step('next')
export const stepInto = (): Promise<void> => step('stepIn')
export const stepOut = (): Promise<void> => step('stepOut')

export async function pauseExecution(): Promise<void> {
  const s = session
  if (!s || getState().debug?.status !== 'running') return
  const threadId = getState().debug?.threadId ?? (await s.request<{ threads: { id: number }[] }>('threads').catch(() => null))?.threads?.[0]?.id
  if (threadId !== undefined) await s.request('pause', { threadId }).catch((err) => log('error', `${(err as Error).message}\n`))
}

export function selectFrame(frame: DebugFrame): void {
  patchDebug({ frameId: frame.id })
  if (frame.path) void openFile(frame.path, { line: frame.line, column: frame.column })
}

// ─────────────────────────── inspection ───────────────────────────

export interface DebugVariable {
  name: string
  value: string
  type?: string
  ref: number
}

export async function scopes(frameId: number): Promise<{ name: string; ref: number; expensive: boolean }[]> {
  const s = session
  if (!s) return []
  const r = await s.request<{ scopes: { name: string; variablesReference: number; expensive?: boolean }[] }>('scopes', { frameId })
  return (r.scopes ?? []).map((x) => ({ name: x.name, ref: x.variablesReference, expensive: !!x.expensive }))
}

export async function variables(ref: number): Promise<DebugVariable[]> {
  const s = session
  if (!s || !ref) return []
  const r = await s.request<{ variables: { name: string; value: string; type?: string; variablesReference: number }[] }>('variables', {
    variablesReference: ref
  })
  return (r.variables ?? []).map((v) => ({ name: v.name, value: v.value, type: v.type, ref: v.variablesReference }))
}

export async function evaluate(expression: string, context: 'watch' | 'repl' | 'hover'): Promise<DebugVariable> {
  const s = session
  if (!s) throw new Error('Нет сеанса отладки')
  const frameId = getState().debug?.frameId
  const r = await s.request<{ result: string; type?: string; variablesReference: number }>('evaluate', { expression, frameId, context }, 10000)
  return { name: expression, value: r.result, type: r.type, ref: r.variablesReference }
}

export async function replEvaluate(expression: string): Promise<void> {
  log('input', expression)
  try {
    // GDB's DAP treats "repl" input as GDB commands; expressions go through "watch".
    const r = await evaluate(expression, session?.adapterType === 'gdb' ? 'watch' : 'repl')
    log('result', r.value, r.ref || undefined)
  } catch (err) {
    log('error', (err as Error).message)
  }
}

export function isDebugging(): boolean {
  return !!session
}

export function addWatch(expr: string): void {
  const e = expr.trim()
  if (!e) return
  setState((s) => ({ watches: [...s.watches, e] }))
  persist()
}

export function removeWatch(i: number): void {
  setState((s) => ({ watches: s.watches.filter((_, j) => j !== i) }))
  persist()
}

export function clearConsole(): void {
  setState({ debugConsole: [] })
}
