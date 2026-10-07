import { monaco } from './monaco'
import { getState, setState } from './store'
import { isUntitled } from './lib/path'

type Model = monaco.editor.ITextModel

const models = new Map<string, Model>()
const savedVersions = new Map<string, number>()
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>()
let editor: monaco.editor.IStandaloneCodeEditor | null = null
let shownPath: string | null = null

const FONT_FAMILY =
  '"JetBrains Mono", "Fira Code", "Cascadia Code", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

function uriFor(path: string): monaco.Uri {
  return isUntitled(path) ? monaco.Uri.parse(path) : monaco.Uri.file(path)
}

function editorOptions(): monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions {
  const s = getState().settings
  return {
    fontSize: s.fontSize,
    fontFamily: FONT_FAMILY,
    fontLigatures: s.fontLigatures,
    lineHeight: Math.round(s.fontSize * 1.6),
    tabSize: s.tabSize,
    wordWrap: s.wordWrap ? 'on' : 'off',
    minimap: { enabled: s.minimap, renderCharacters: false, scale: 1, maxColumn: 100 },
    theme: s.theme
  }
}

function syncDirty(path: string): void {
  const model = models.get(path)
  if (!model) return
  const dirty = model.getAlternativeVersionId() !== savedVersions.get(path)
  const tabs = getState().tabs
  const tab = tabs.find((t) => t.path === path)
  if (tab && tab.dirty !== dirty) {
    setState({ tabs: tabs.map((t) => (t.path === path ? { ...t, dirty } : t)) })
  }
}

function syncStatus(): void {
  if (!editor) return
  const model = editor.getModel()
  const pos = editor.getPosition()
  const sel = editor.getSelection()
  const selected = model && sel && !sel.isEmpty() ? model.getValueInRange(sel).length : 0
  setState({
    cursor: { line: pos?.lineNumber ?? 1, column: pos?.column ?? 1, selected },
    language: model?.getLanguageId() ?? 'plaintext',
    eol: model?.getEOL() === '\r\n' ? 'CRLF' : 'LF'
  })
}

export function mountEditor(el: HTMLElement): () => void {
  editor = monaco.editor.create(el, {
    ...editorOptions(),
    model: null,
    automaticLayout: true,
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    cursorWidth: 2,
    renderLineHighlight: 'all',
    roundedSelection: true,
    scrollBeyondLastLine: false,
    padding: { top: 12, bottom: 12 },
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: 'active', indentation: true },
    stickyScroll: { enabled: true },
    mouseWheelZoom: true,
    fixedOverflowWidgets: true,
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
    overviewRulerBorder: false,
    renderWhitespace: 'selection',
    linkedEditing: true,
    'semanticHighlighting.enabled': true
  })
  const subs = [
    editor.onDidChangeCursorSelection(syncStatus),
    editor.onDidChangeModel(syncStatus),
    editor.onDidChangeModelContent(() => {
      if (shownPath) syncDirty(shownPath)
    })
  ]
  if (shownPath) show(shownPath)
  return () => {
    subs.forEach((s) => s.dispose())
    if (shownPath && editor) viewStates.set(shownPath, editor.saveViewState())
    editor?.dispose()
    editor = null
  }
}

export function applyEditorOptions(): void {
  monaco.editor.setTheme(getState().settings.theme)
  editor?.updateOptions(editorOptions())
  for (const m of models.values()) m.updateOptions({ tabSize: getState().settings.tabSize })
}

export function hasModel(path: string): boolean {
  return models.has(path)
}

export function createModel(path: string, content: string, language?: string): Model {
  const existing = models.get(path)
  if (existing) return existing
  const model = monaco.editor.createModel(content, language, uriFor(path))
  model.updateOptions({ tabSize: getState().settings.tabSize })
  models.set(path, model)
  savedVersions.set(path, model.getAlternativeVersionId())
  return model
}

export function show(path: string | null, focus = true): void {
  if (!editor) {
    shownPath = path
    return
  }
  if (shownPath && shownPath !== path && models.has(shownPath)) {
    viewStates.set(shownPath, editor.saveViewState())
  }
  shownPath = path
  const model = path ? models.get(path) ?? null : null
  editor.setModel(model)
  if (path && model) {
    const vs = viewStates.get(path)
    if (vs) editor.restoreViewState(vs)
    // The host may still be hidden until React renders the first tab; focus next frame.
    if (focus) requestAnimationFrame(() => editor?.focus())
  }
  syncStatus()
}

export function revealRange(line: number, column: number, length = 0): void {
  if (!editor) return
  const range = new monaco.Range(line, column, line, column + length)
  editor.setSelection(range)
  editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Smooth)
  requestAnimationFrame(() => editor?.focus())
}

export function focusEditor(): void {
  editor?.focus()
}

export function runEditorAction(id: string): void {
  if (!editor) return
  editor.focus()
  editor.getAction(id)?.run()
}

export function getContent(path: string): string | null {
  return models.get(path)?.getValue() ?? null
}

export function markSaved(path: string): void {
  const model = models.get(path)
  if (!model) return
  savedVersions.set(path, model.getAlternativeVersionId())
  syncDirty(path)
}

export function isDirty(path: string): boolean {
  const model = models.get(path)
  return !!model && model.getAlternativeVersionId() !== savedVersions.get(path)
}

/** Replace the contents of a clean model after an on-disk change, keeping undo. */
export function reloadFromDisk(path: string, content: string): void {
  const model = models.get(path)
  if (!model || isDirty(path) || model.getValue() === content) return
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null)
  savedVersions.set(path, model.getAlternativeVersionId())
  syncDirty(path)
}

/** Move a model to a new path (rename / save as), preserving its text (undo history is reset). */
export function moveModel(from: string, to: string): void {
  const model = models.get(from)
  if (!model) return
  const content = model.getValue()
  const wasDirty = isDirty(from)
  const vs = from === shownPath && editor ? editor.saveViewState() : viewStates.get(from) ?? null
  disposeModel(from)
  createModel(to, content)
  if (wasDirty) savedVersions.set(to, -1)
  viewStates.set(to, vs)
}

export function disposeModel(path: string): void {
  const model = models.get(path)
  if (shownPath === path) {
    editor?.setModel(null)
    shownPath = null
  }
  model?.dispose()
  models.delete(path)
  savedVersions.delete(path)
  viewStates.delete(path)
}

export function setLanguage(path: string, languageId: string): void {
  const model = models.get(path)
  if (!model) return
  monaco.editor.setModelLanguage(model, languageId)
  syncStatus()
}

export function languages(): { id: string; name: string; extensions: string[] }[] {
  return monaco.languages
    .getLanguages()
    .map((l) => ({ id: l.id, name: l.aliases?.[0] ?? l.id, extensions: l.extensions ?? [] }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function languageName(id: string): string {
  const l = monaco.languages.getLanguages().find((x) => x.id === id)
  return l?.aliases?.[0] ?? id
}
