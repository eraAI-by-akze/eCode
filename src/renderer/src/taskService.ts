import type { PluginRunner, PluginTask, ProblemMatcherSpec } from '@shared/types'
import { monaco } from './monaco'
import { getState, setState, type Diagnostic } from './store'
import { getFileIndex, openFile, save, toast, pick } from './actions'
import { onModelCreated, pathForModel } from './editorService'
import { pluginRunners, pluginTasks, type Contributed } from './pluginService'
import { runInTerminal } from './terminalService'
import { ProblemParser } from './lib/problemMatchers'
import { matchGlob } from './lib/glob'
import { basename, dirname, extname, isUntitled, relative, resolvePath } from './lib/path'

/**
 * Build / check / test tasks from plugins. Background tasks stream into the
 * Output panel; their compiler messages become diagnostics (Problems panel,
 * squiggles, Error Lens) under the marker owner "task".
 */

const api = window.ecode
const isWin = api.platform === 'win32'
const MAX_OUTPUT = 400_000
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g

/** Diagnostics per task id, so re-running one task replaces only its own results. */
const byTask = new Map<string, Record<string, Diagnostic[]>>()
let listening = false
let current: { pid: number; parser: ProblemParser; pending: string; taskId: string; cwd: string } | null = null
/** Folder of the last background task; compiler paths in the Output panel are relative to it. */
let lastCwd = ''
/** Callers waiting for the current background task (preLaunchTask of a debug session). */
let waiters: ((code: number | null) => void)[] = []

// ─────────────────────────── variables ───────────────────────────

class TaskError extends Error {}

async function findFile(globs: string): Promise<string> {
  const root = getState().root
  if (!root) throw new TaskError('Откройте папку проекта')
  const files = (await getFileIndex()).map((f) => ({ abs: f, rel: relative(root, f) }))
  for (const glob of globs.split('|')) {
    const hits = files.filter((f) => matchGlob(glob.trim(), f.rel))
    if (hits.length) {
      // Prefer the shallowest match (the solution at the root beats nested projects).
      hits.sort((a, b) => a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel))
      return hits[0].abs
    }
  }
  throw new TaskError(`В проекте нет файла по шаблону ${globs}`)
}

export async function resolveVars(template: string, pluginDir: string): Promise<string> {
  const { root, active } = getState()
  const file = active && !isUntitled(active) && !active.startsWith('diff:') ? active : ''
  const simple: Record<string, string> = {
    workspaceFolder: root ?? '',
    file,
    fileDirname: file ? dirname(file) : '',
    fileBasename: file ? basename(file) : '',
    fileBasenameNoExtension: file ? basename(file).replace(/\.[^.]+$/, '') : '',
    pluginDir,
    python: isWin ? 'python' : 'python3'
  }
  let out = ''
  let last = 0
  for (const m of template.matchAll(/\$\{(\w+)(?::([^}]*))?\}/g)) {
    out += template.slice(last, m.index)
    last = m.index! + m[0].length
    const [, name, arg] = m
    if (name === 'find') out += await findFile(arg ?? '')
    else if (name === 'findDir') out += dirname(await findFile(arg ?? ''))
    else if (name in simple) {
      if ((name.startsWith('file') || name === 'file') && !simple[name]) throw new TaskError('Нет открытого файла')
      out += simple[name]
    } else out += m[0]
  }
  return out + template.slice(last)
}

// ─────────────────────────── availability ───────────────────────────

/** Tasks whose `when.files` match something in the open folder. */
export async function availableTasks(): Promise<Contributed<PluginTask>[]> {
  const root = getState().root
  if (!root) return []
  const rels = (await getFileIndex()).map((f) => relative(root, f))
  return pluginTasks().filter(({ item }) => !item.when?.files?.length || item.when.files.some((g) => rels.some((r) => matchGlob(g, r))))
}

// ─────────────────────────── diagnostics ───────────────────────────

function publish(): void {
  const merged: Record<string, Diagnostic[]> = {}
  for (const map of byTask.values()) {
    for (const [path, list] of Object.entries(map)) merged[path] = [...(merged[path] ?? []), ...list]
  }
  setState({ taskDiagnostics: merged })
  for (const model of monaco.editor.getModels()) applyMarkers(model, merged)
}

function applyMarkers(model: monaco.editor.ITextModel, merged = getState().taskDiagnostics): void {
  const path = pathForModel(model)
  const list = path ? merged[path] ?? [] : []
  const sev = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info, hint: monaco.MarkerSeverity.Hint }
  monaco.editor.setModelMarkers(
    model,
    'task',
    list.map((d) => ({
      startLineNumber: d.line,
      startColumn: d.column,
      endLineNumber: d.endLine,
      // Compilers report a point; underline to the end of the word/line.
      endColumn: d.endColumn > d.column ? d.endColumn : model.getLineMaxColumn(Math.min(d.line, model.getLineCount())),
      message: d.message,
      severity: sev[d.severity],
      source: d.source,
      code: d.code
    }))
  )
}

export function clearTaskProblems(): void {
  byTask.clear()
  publish()
}

// ─────────────────────────── running ───────────────────────────

function appendOutput(text: string): void {
  setState((s) => ({ taskOutput: (s.taskOutput + text).slice(-MAX_OUTPUT) }))
}

function feed(chunk: string): void {
  if (!current) return
  const text = chunk.replace(ANSI, '').replace(/\r\n/g, '\n')
  appendOutput(text)
  const lines = (current.pending + text).split('\n')
  current.pending = lines.pop() ?? ''
  for (const line of lines) current.parser.push(line.replace(/\r$/, ''))
}

function finish(code: number | null): void {
  const run = getState().task
  if (!current || !run) return
  if (current.pending) current.parser.push(current.pending)
  const map: Record<string, Diagnostic[]> = {}
  for (const p of current.parser.problems) {
    const path = resolvePath(current.cwd, p.file)
    ;(map[path] ??= []).push({ ...p, endLine: p.line, endColumn: p.column })
  }
  byTask.set(current.taskId, map)
  publish()
  const all = current.parser.problems
  const errors = all.filter((p) => p.severity === 'error').length
  const warnings = all.filter((p) => p.severity === 'warning').length
  const ms = Date.now() - run.startedAt
  appendOutput(`\n${code === 0 ? '✓' : '✗'} ${run.label} — код ${code ?? '—'}, ${(ms / 1000).toFixed(1)} с\n`)
  setState({ task: null, lastTask: { taskId: run.taskId, label: run.label, code, errors, warnings, ms } })
  current = null
  const done = waiters
  waiters = []
  for (const w of done) w(code)
  if (code === 0) toast(`${run.label}: готово${warnings ? `, предупреждений: ${warnings}` : ''}`, 'success')
  else if (!errors && warnings) {
    // Linters exit non-zero for warnings alone.
    toast(`${run.label}: предупреждений ${warnings}`)
    setState({ panelOpen: true, panelTab: 'problems' })
  } else {
    toast(`${run.label}: ошибок ${errors}${warnings ? `, предупреждений ${warnings}` : ''}`, 'error')
    if (errors) setState({ panelOpen: true, panelTab: 'problems' })
  }
}

function listen(): void {
  if (listening) return
  listening = true
  api.onTaskOutput((pid, data) => {
    if (current?.pid === pid) feed(data)
  })
  api.onTaskExit((pid, code) => {
    if (current?.pid === pid) finish(code)
  })
  onModelCreated((model) => applyMarkers(model))
}

function matchers(task: PluginTask): (string | ProblemMatcherSpec)[] {
  const m = task.problemMatcher
  return m === undefined ? [] : Array.isArray(m) ? m : [m]
}

export async function runTask(entry: Contributed<PluginTask>): Promise<void> {
  listen()
  const { item: task, dir } = entry
  const root = getState().root
  if (!root) {
    toast('Откройте папку проекта', 'error')
    return
  }
  let command: string
  let cwd: string
  try {
    command = await resolveVars(task.command, dir)
    cwd = task.cwd ? await resolveVars(task.cwd, dir) : root
  } catch (err) {
    toast(err instanceof TaskError ? err.message : String(err), 'error')
    return
  }
  // Build what's on screen, not what's on disk.
  for (const t of getState().tabs) if (t.dirty) await save(t.path)

  if (task.group === 'build') rememberBuild(root, task.id)

  if (task.terminal) {
    await runInTerminal(isWin ? `cd "${cwd}"; ${command}` : `cd "${cwd}" && ${command}`)
    return
  }
  if (current) stopTask()
  setState({
    taskOutput: `> ${command}\n  (в ${cwd})\n\n`,
    panelOpen: true,
    panelTab: 'output'
  })
  lastCwd = cwd
  const pid = await api.taskRun(command, cwd)
  current = { pid, parser: new ProblemParser(matchers(task), task.label), pending: '', taskId: task.id, cwd }
  setState({ task: { pid, taskId: task.id, label: task.label, command, cwd, startedAt: Date.now() } })
}

/** Run a background task and resolve with its exit code (null if it couldn't start). */
export async function runTaskAndWait(entry: Contributed<PluginTask>): Promise<number | null> {
  let settled: { code: number | null } | null = null
  let resolveWait: (code: number | null) => void = () => {}
  const waiter = (code: number | null): void => {
    settled = { code }
    resolveWait(code)
  }
  waiters.push(waiter)
  await runTask(entry)
  if (settled) return (settled as { code: number | null }).code
  // Terminal tasks and tasks that failed to start never report back.
  if (!getState().task) {
    waiters = waiters.filter((w) => w !== waiter)
    return entry.item.terminal ? 0 : null
  }
  return new Promise((resolve) => (resolveWait = resolve))
}

export function stopTask(): void {
  const t = getState().task
  if (!t) return
  api.taskKill(t.pid)
  appendOutput('\n■ остановлено\n')
}

/** Pick (or directly run, if there's one) a task from a group. */
export async function runGroup(group: PluginTask['group'] | 'any'): Promise<void> {
  const tasks = (await availableTasks()).filter((t) => group === 'any' || t.item.group === group)
  if (!tasks.length) {
    toast(group === 'any' ? 'Для этого проекта нет задач. Включите плагин или добавьте свой.' : 'Нет подходящих задач для этого проекта')
    return
  }
  if (tasks.length === 1) return runTask(tasks[0])
  const last = getState().lastTask?.taskId
  pick(
    'Выберите задачу',
    tasks.map((t) => ({
      id: t.item.id,
      label: t.item.label,
      detail: t.plugin.name,
      hint: GROUP_LABEL[t.item.group ?? 'build'],
      active: t.item.id === last
    })),
    (id) => {
      const t = tasks.find((x) => x.item.id === id)
      if (t) void runTask(t)
    }
  )
}

// ─────────────────────────── quick build (F5) ───────────────────────────

const BUILD_KEY = 'ecode.lastBuild:'

function rememberBuild(root: string, id: string): void {
  try {
    localStorage.setItem(BUILD_KEY + root, id)
  } catch {
    // Storage unavailable: F5 just asks again next time.
  }
}

function rememberedBuild(root: string): string | null {
  try {
    return localStorage.getItem(BUILD_KEY + root)
  } catch {
    return null
  }
}

/** F5 / the title-bar button: rerun this project's last build task, or pick one the first time. */
export async function quickBuild(): Promise<void> {
  const root = getState().root
  if (!root) {
    toast('Откройте папку проекта', 'error')
    return
  }
  const builds = (await availableTasks()).filter((t) => t.item.group === 'build')
  const id = rememberedBuild(root)
  const hit = builds.find((t) => t.item.id === id)
  if (hit) return runTask(hit)
  return runGroup('build')
}

export const GROUP_LABEL: Record<NonNullable<PluginTask['group']>, string> = {
  build: 'сборка',
  check: 'проверка',
  test: 'тесты',
  run: 'запуск',
  format: 'формат',
  clean: 'очистка'
}

/** Plugin runner for a file (Ctrl+F5), resolved to a command and folder. */
export async function runnerFor(path: string): Promise<{ command: string; cwd: string } | null> {
  const ext = '.' + extname(path)
  const hit = pluginRunners().find(({ item }: Contributed<PluginRunner>) => item.extensions.includes(ext))
  if (!hit) return null
  return {
    command: await resolveVars(hit.item.command, hit.dir),
    cwd: hit.item.cwd ? await resolveVars(hit.item.cwd, hit.dir) : dirname(path)
  }
}

/** Open the file:line a compiler line points at (Output panel links). */
export function openProblemLine(line: string): boolean {
  const p = new ProblemParser(['msbuild', 'rustc', 'gcc', 'python'], 'link').push(line)
  if (!p) return false
  void openFile(resolvePath(lastCwd || getState().root || '', p.file), { line: p.line, column: p.column })
  return true
}

/** Run a command quietly and collect its output (no Output panel, no problems). */
export async function captureCommand(command: string, cwd: string, timeoutMs = 15000): Promise<{ code: number | null; out: string }> {
  let out = ''
  let pid = -1
  let early: { code: number | null } | null = null
  const chunks: [number, string][] = []
  let finish: (code: number | null) => void = (code) => (early = { code })
  const offOut = api.onTaskOutput((id, data) => (pid === id ? (out += data) : chunks.push([id, data])))
  const offExit = api.onTaskExit((id, code) => {
    if (id === pid) finish(code)
  })
  try {
    pid = await api.taskRun(command, cwd)
    for (const [id, data] of chunks) if (id === pid) out += data
    const code = await new Promise<number | null>((resolve) => {
      if (early) return resolve(early.code)
      finish = resolve
      setTimeout(() => {
        api.taskKill(pid)
        resolve(null)
      }, timeoutMs)
    })
    return { code, out: out.replace(ANSI, '') }
  } finally {
    offOut()
    offExit()
  }
}
