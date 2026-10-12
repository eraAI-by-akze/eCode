import { DEFAULT_ERA, type Settings } from '@shared/types'
import * as ed from './editorService'
import * as lsp from './lspClient'
import { monaco } from './monaco'
import { refreshGit } from './scm'
import { askAboutSelection } from './eraService'
import { getState, setState, useStore, type PickItem, type SidebarView } from './store'
import { THEMES, THEME_LIST, applyThemeVars } from './themes'
import { basename, dirname, isInside, isUntitled } from './lib/path'

const api = window.ecode
let untitledCounter = 1
let toastId = 1

// ───────────────────────────── toasts ─────────────────────────────

export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  const id = toastId++
  setState((s) => ({ toasts: [...s.toasts, { id, message, kind }] }))
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 3200)
}

function fail(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err)
  // Strip Electron's "Error invoking remote method 'x': Error: " prefix.
  toast(msg.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ''), 'error')
}

// ──────────────────────────── settings ────────────────────────────

export function updateSettings(patch: Partial<Settings>): void {
  setState((s) => ({ settings: { ...s.settings, ...patch } }))
  api.saveSettings(patch)
  if (patch.theme) applyThemeVars(THEMES[patch.theme])
  if (
    'theme' in patch ||
    'fontSize' in patch ||
    'tabSize' in patch ||
    'wordWrap' in patch ||
    'minimap' in patch ||
    'fontLigatures' in patch
  ) {
    ed.applyEditorOptions()
  }
}

const isVirtual = (p: string): boolean => isUntitled(p) || p.startsWith('diff:')

function persistSession(): void {
  const { tabs, active } = getState()
  const real = tabs.map((t) => t.path).filter((p) => !isVirtual(p))
  updateSettings({ openFiles: real, activeFile: active && !isVirtual(active) ? active : null })
}

function syncDirtyFlag(): void {
  api.setDirty(getState().tabs.some((t) => t.dirty))
}

export async function init(): Promise<void> {
  const loaded = await api.loadSettings()
  const settings = { ...loaded, era: { ...DEFAULT_ERA, ...loaded.era } }
  setState({ settings })
  applyThemeVars(THEMES[settings.theme] ?? THEMES['era-glass'])
  ed.applyEditorOptions()

  ed.addEditorAction('eraai.explain', 'eraAI: объяснить', () => askAboutSelection('explain'), 1)
  ed.addEditorAction('eraai.fix', 'eraAI: исправить', () => askAboutSelection('fix'), 2)
  ed.addEditorAction('eraai.docs', 'eraAI: документировать', () => askAboutSelection('docs'), 3)

  api.onMaximizedChange((maximized) => setState({ maximized }))
  api.onFsChange(onFsChange)
  window.addEventListener('focus', () => refreshGit(100))

  lsp.initLsp({
    loadModel: (path) => openFile(path, { background: true, silent: true }),
    notify: toast,
    models: ed.allModels
  })
  // Go to definition in another file lands here.
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.scheme !== 'file') return false
      let line: number | undefined
      let column: number | undefined
      if (selectionOrPosition && 'startLineNumber' in selectionOrPosition) {
        line = selectionOrPosition.startLineNumber
        column = selectionOrPosition.startColumn
      } else if (selectionOrPosition) {
        line = selectionOrPosition.lineNumber
        column = selectionOrPosition.column
      }
      void openFile(lsp.pathForUri(resource), { line, column })
      return true
    }
  })

  // Keep the main process' "unsaved changes" guard in sync.
  let prevDirty = false
  useStore.subscribe(() => {
    const dirty = getState().tabs.some((t) => t.dirty)
    if (dirty !== prevDirty) {
      prevDirty = dirty
      syncDirtyFlag()
    }
  })

  if (settings.lastFolder && (await api.stat(settings.lastFolder))?.isDir) {
    await openFolder(settings.lastFolder, { restore: true })
  }
  setState({ ready: true })
}

// ──────────────────────────── folders ─────────────────────────────

export async function openFolder(path?: string, opts: { restore?: boolean } = {}): Promise<void> {
  const target = path ?? (await api.openFolderDialog())
  if (!target) return
  const { settings } = getState()
  if (!opts.restore && getState().tabs.some((t) => t.dirty)) {
    const r = await api.confirm('Есть несохранённые файлы', 'Сохранить их перед сменой папки?', [
      'Сохранить все',
      'Не сохранять',
      'Отмена'
    ])
    if (r === 2) return
    if (r === 0) await saveAll()
  }
  if (!opts.restore) closeAllTabs(true)
  await lsp.stopAll()

  setState({
    root: target,
    tree: {},
    expanded: { [target]: true },
    selected: null,
    fileIndex: null,
    git: null,
    sidebar: getState().sidebar ?? 'explorer'
  })
  const recent = [target, ...settings.recent.filter((r) => r !== target)].slice(0, 10)
  updateSettings({ lastFolder: target, recent })
  api.watch(target)
  document.title = `${basename(target)} — eCode`
  await loadDir(target)
  refreshGit()

  if (opts.restore) {
    const files = settings.openFiles.filter((f) => isInside(target, f))
    for (const f of files) await openFile(f, { background: true, silent: true })
    const active = settings.activeFile && getState().tabs.find((t) => t.path === settings.activeFile)
    if (active) setActive(active.path)
    else if (getState().tabs.length) setActive(getState().tabs[0].path)
  } else {
    persistSession()
  }
}

export async function closeFolder(): Promise<void> {
  if (getState().tabs.some((t) => t.dirty)) {
    const r = await api.confirm('Есть несохранённые файлы', 'Закрыть папку без сохранения?', ['Закрыть', 'Отмена'])
    if (r !== 0) return
  }
  closeAllTabs(true)
  api.watch(null)
  await lsp.stopAll()
  setState({ root: null, tree: {}, expanded: {}, selected: null, fileIndex: null, git: null })
  updateSettings({ lastFolder: null, openFiles: [], activeFile: null })
  document.title = 'eCode'
}

export async function loadDir(dir: string): Promise<void> {
  try {
    const entries = await api.readDir(dir)
    setState((s) => ({ tree: { ...s.tree, [dir]: entries } }))
  } catch (err) {
    setState((s) => {
      const tree = { ...s.tree }
      delete tree[dir]
      return { tree }
    })
    if (dir === getState().root) fail(err)
  }
}

export async function toggleDir(dir: string, open?: boolean): Promise<void> {
  const isOpen = !!getState().expanded[dir]
  const next = open ?? !isOpen
  setState((s) => ({ expanded: { ...s.expanded, [dir]: next } }))
  if (next && !getState().tree[dir]) await loadDir(dir)
}

export function collapseAll(): void {
  const root = getState().root
  setState({ expanded: root ? { [root]: true } : {} })
}

export async function refreshTree(): Promise<void> {
  const { expanded, tree } = getState()
  setState({ fileIndex: null })
  await Promise.all(Object.keys(tree).filter((d) => expanded[d]).map(loadDir))
}

async function onFsChange(paths: string[]): Promise<void> {
  const { tree, tabs } = getState()
  setState({ fileIndex: null })
  refreshGit(300)
  const dirs = new Set<string>()
  for (const p of paths) {
    if (tree[p]) dirs.add(p)
    const parent = dirname(p)
    if (tree[parent]) dirs.add(parent)
  }
  await Promise.all([...dirs].map(loadDir))
  for (const p of paths) {
    if (!tabs.some((t) => t.path === p) || ed.isDirty(p)) continue
    const r = await api.readFile(p)
    if (r.content !== undefined) ed.reloadFromDisk(p, r.content)
  }
}

export async function revealInTree(path: string): Promise<void> {
  const root = getState().root
  if (!root || !isInside(root, path)) return
  const chain: string[] = []
  for (let d = dirname(path); d.length >= root.length && d !== chain[chain.length - 1]; d = dirname(d)) {
    chain.unshift(d)
    if (d === root) break
  }
  for (const d of chain) await toggleDir(d, true)
  setState({ selected: path, sidebar: 'explorer', lastSidebar: 'explorer' })
}

export async function getFileIndex(): Promise<string[]> {
  const { fileIndex, root } = getState()
  if (fileIndex) return fileIndex
  if (!root) return []
  const files = await api.listFiles(root)
  if (getState().root === root) setState({ fileIndex: files })
  return files
}

// ───────────────────────────── files ──────────────────────────────

export async function openFile(
  path: string,
  opts: {
    line?: number
    column?: number
    length?: number
    background?: boolean
    silent?: boolean
    preserveFocus?: boolean
  } = {}
): Promise<void> {
  if (!ed.hasModel(path)) {
    const r = await api.readFile(path)
    if (r.content === undefined) {
      if (!opts.silent) {
        toast(
          r.binary
            ? `${basename(path)} — бинарный файл, открыть нельзя`
            : r.tooLarge
              ? `${basename(path)} слишком большой`
              : `Не удалось открыть: ${r.error}`,
          'error'
        )
      }
      return
    }
    ed.createModel(path, r.content)
  }
  setState((s) =>
    s.tabs.some((t) => t.path === path) ? {} : { tabs: [...s.tabs, { path, name: basename(path), dirty: false }] }
  )
  if (!opts.background) {
    setActive(path, !opts.preserveFocus)
    setState({ selected: path })
    if (opts.line) ed.revealRange(opts.line, opts.column ?? 1, opts.length ?? 0)
  }
  persistSession()
}

export async function openFileDialog(): Promise<void> {
  const p = await api.openFileDialog()
  if (p) await openFile(p)
}

export function newUntitled(): void {
  const path = `untitled:Untitled-${untitledCounter++}`
  ed.createModel(path, '', 'plaintext')
  setState((s) => ({ tabs: [...s.tabs, { path, name: path.slice('untitled:'.length), dirty: false }] }))
  setActive(path)
}

export function setActive(path: string | null, focus = true): void {
  setState({ active: path })
  ed.show(path, focus)
  persistSession()
}

export function cycleTab(delta: number): void {
  const { tabs, active } = getState()
  if (!tabs.length) return
  const i = tabs.findIndex((t) => t.path === active)
  setActive(tabs[(i + delta + tabs.length) % tabs.length].path)
}

export function moveTab(from: number, to: number): void {
  setState((s) => {
    const tabs = [...s.tabs]
    const [t] = tabs.splice(from, 1)
    tabs.splice(to, 0, t)
    return { tabs }
  })
  persistSession()
}

export async function closeTab(path: string, force = false): Promise<boolean> {
  const tab = getState().tabs.find((t) => t.path === path)
  if (!tab) return true
  if (tab.dirty && !force) {
    const r = await api.confirm(`Сохранить изменения в «${tab.name}»?`, 'Если не сохранить, изменения пропадут.', [
      'Сохранить',
      'Не сохранять',
      'Отмена'
    ])
    if (r === 2) return false
    if (r === 0 && !(await save(path))) return false
  }
  const { tabs, active } = getState()
  const idx = tabs.findIndex((t) => t.path === path)
  const rest = tabs.filter((t) => t.path !== path)
  ed.disposeModel(path)
  setState({ tabs: rest })
  if (active === path) setActive(rest[Math.min(idx, rest.length - 1)]?.path ?? null)
  else persistSession()
  return true
}

function closeAllTabs(force: boolean): void {
  for (const t of getState().tabs) ed.disposeModel(t.path)
  setState({ tabs: [], active: null })
  ed.show(null)
  if (force) api.setDirty(false)
}

export async function closeOthers(keep: string): Promise<void> {
  for (const t of getState().tabs) if (t.path !== keep && !(await closeTab(t.path))) return
}

export async function closeAll(): Promise<void> {
  for (const t of [...getState().tabs]) if (!(await closeTab(t.path))) return
}

export async function save(path = getState().active): Promise<boolean> {
  if (!path || path.startsWith('diff:')) return false
  if (isUntitled(path)) return saveAs(path)
  const content = ed.getContent(path)
  if (content === null) return false
  try {
    await api.writeFile(path, content)
    ed.markSaved(path)
    refreshGit(150)
    return true
  } catch (err) {
    fail(err)
    return false
  }
}

export async function saveAs(path = getState().active): Promise<boolean> {
  if (!path || path.startsWith('diff:')) return false
  const content = ed.getContent(path)
  if (content === null) return false
  const root = getState().root
  const suggested = isUntitled(path)
    ? `${root ?? ''}${root ? window.ecode.pathSep : ''}${path.slice('untitled:'.length)}.txt`
    : path
  const target = await api.saveFileDialog(suggested)
  if (!target) return false
  try {
    await api.writeFile(target, content)
  } catch (err) {
    fail(err)
    return false
  }
  if (target !== path) {
    if (ed.hasModel(target)) await closeTab(target, true)
    ed.moveModel(path, target)
    setState((s) => ({
      tabs: s.tabs.map((t) => (t.path === path ? { path: target, name: basename(target), dirty: false } : t))
    }))
  }
  ed.markSaved(target)
  setActive(target)
  toast(`Сохранено: ${basename(target)}`, 'success')
  return true
}

export async function saveAll(): Promise<void> {
  for (const t of getState().tabs) if (t.dirty) await save(t.path)
}

// ────────────────────────── file operations ──────────────────────────

export function beginCreate(kind: 'newFile' | 'newFolder', dir?: string): void {
  const { root, selected, tree } = getState()
  if (!root) {
    if (kind === 'newFile') newUntitled()
    return
  }
  let target = dir ?? root
  if (!dir && selected) {
    const parent = dirname(selected)
    target = tree[selected] !== undefined || getState().expanded[selected] ? selected : parent
    if (!isInside(root, target)) target = root
  }
  setState({ sidebar: 'explorer', lastSidebar: 'explorer' })
  toggleDir(target, true)
  setState({ inlineEdit: { kind, dir: target } })
}

export async function commitCreate(kind: 'newFile' | 'newFolder', dir: string, name: string): Promise<void> {
  setState({ inlineEdit: null })
  name = name.trim()
  if (!name) return
  try {
    // Allow "a/b/c.ts" to create intermediate folders.
    const parts = name.split(/[\\/]/).filter(Boolean)
    let parent = dir
    for (let i = 0; i < parts.length - 1; i++) {
      const next = parent + window.ecode.pathSep + parts[i]
      const st = await api.stat(next)
      if (!st) await api.createDir(parent, parts[i])
      parent = next
    }
    const leaf = parts[parts.length - 1]
    const created = kind === 'newFile' ? await api.createFile(parent, leaf) : await api.createDir(parent, leaf)
    await loadDir(parent)
    if (parent !== dir) await loadDir(dir)
    if (kind === 'newFile') await openFile(created)
    else await toggleDir(created, true)
    await revealInTree(created)
  } catch (err) {
    fail(err)
  }
}

export async function commitRename(path: string, newName: string): Promise<void> {
  setState({ inlineEdit: null })
  newName = newName.trim()
  if (!newName || newName === basename(path)) return
  try {
    const target = await api.rename(path, newName)
    // Re-point any open tabs that lived at or under the old path.
    const { tabs, active } = getState()
    const remap = (p: string): string => (isInside(path, p) ? target + p.slice(path.length) : p)
    for (const t of tabs) if (isInside(path, t.path)) ed.moveModel(t.path, remap(t.path))
    setState({
      tabs: tabs.map((t) => (isInside(path, t.path) ? { ...t, path: remap(t.path), name: basename(remap(t.path)) } : t)),
      selected: target
    })
    if (active) setActive(remap(active))
    await loadDir(dirname(path))
  } catch (err) {
    fail(err)
  }
}

export async function deleteEntry(path: string): Promise<void> {
  const r = await api.confirm(`Удалить «${basename(path)}»?`, 'Файл будет перемещён в корзину.', ['Удалить', 'Отмена'])
  if (r !== 0) return
  try {
    await api.remove(path)
    for (const t of getState().tabs) if (isInside(path, t.path)) await closeTab(t.path, true)
    await loadDir(dirname(path))
  } catch (err) {
    fail(err)
  }
}

// ───────────────────────────── layout ─────────────────────────────

export function showSidebar(view: SidebarView): void {
  const { sidebar } = getState()
  setState({ sidebar: sidebar === view ? null : view, lastSidebar: view })
}

export function focusSidebar(view: SidebarView): void {
  setState({ sidebar: view, lastSidebar: view })
}

export function toggleSidebar(): void {
  const { sidebar, lastSidebar } = getState()
  setState({ sidebar: sidebar ? null : lastSidebar })
}

export function togglePanel(): void {
  setState((s) => ({ panelOpen: !s.panelOpen }))
}

export function showPanel(tab: 'terminal' | 'problems'): void {
  setState({ panelOpen: true, panelTab: tab })
}

export async function restartLanguageServers(): Promise<void> {
  await lsp.stopAll()
  for (const [path, model] of ed.allModels()) if (!isUntitled(path)) void lsp.attachModel(path, model)
  toast('Языковые серверы перезапущены')
}

export function zoom(delta: number): void {
  const size = delta === 0 ? 14 : Math.max(9, Math.min(32, getState().settings.fontSize + delta))
  updateSettings({ fontSize: size })
}

// ──────────────────────────── palette ─────────────────────────────

export function openQuick(value = ''): void {
  setState({ palette: { kind: 'quick', value } })
}

export function pick(placeholder: string, items: PickItem[], onPick: (id: string) => void): void {
  setState({ palette: { kind: 'pick', placeholder, items, onPick } })
}

export function prompt(placeholder: string, promptText: string, onSubmit: (value: string) => void): void {
  setState({ palette: { kind: 'input', placeholder, prompt: promptText, onSubmit } })
}

export function closePalette(): void {
  setState({ palette: null })
  ed.focusEditor()
}

export function pickTheme(): void {
  const current = getState().settings.theme
  pick(
    'Выберите тему',
    THEME_LIST.map((t) => ({ id: t.id, label: t.name, detail: t.tagline, active: t.id === current })),
    (id) => updateSettings({ theme: id as Settings['theme'] })
  )
}

export function pickLanguage(): void {
  const { active, language } = getState()
  if (!active || isVirtual(active)) return
  pick(
    'Выберите язык файла',
    ed.languages().map((l) => ({
      id: l.id,
      label: l.name,
      hint: l.extensions.slice(0, 4).join(' '),
      active: l.id === language
    })),
    (id) => ed.setLanguage(active, id)
  )
}

export function pickRecent(): void {
  const { recent } = getState().settings
  if (!recent.length) {
    toast('Недавних папок пока нет')
    return
  }
  pick(
    'Открыть недавнюю папку',
    recent.map((r) => ({ id: r, label: basename(r), detail: r })),
    (id) => openFolder(id)
  )
}
