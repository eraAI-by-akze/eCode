import { monaco } from './monaco'
import { getState, setState } from './store'
import { basename, extname, isUntitled } from './lib/path'
import * as lsp from './lspClient'

type Model = monaco.editor.ITextModel

const models = new Map<string, Model>()
const savedVersions = new Map<string, number>()
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>()
let editor: monaco.editor.IStandaloneCodeEditor | null = null
let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null
const diffs = new Map<string, { original: Model; modified: Model }>()
let diffInline = false
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
    'semanticHighlighting.enabled': true,
    // Peek views need every target model loaded; jump straight to the file instead.
    gotoLocation: { multiple: 'goto', multipleDefinitions: 'goto', multipleTypeDefinitions: 'goto' }
  })
  const subs = [
    editor.onDidChangeCursorSelection(syncStatus),
    editor.onDidChangeModel(syncStatus)
  ]
  for (const a of extraActions) editor.addAction(a)
  if (shownPath && models.has(shownPath)) show(shownPath, false)
  return () => {
    subs.forEach((s) => s.dispose())
    if (shownPath && editor) viewStates.set(shownPath, editor.saveViewState())
    editor?.dispose()
    editor = null
  }
}

export function mountDiffEditor(el: HTMLElement): () => void {
  diffEditor = monaco.editor.createDiffEditor(el, {
    ...diffOptions(),
    automaticLayout: true,
    readOnly: true,
    originalEditable: false,
    renderSideBySide: !diffInline,
    ignoreTrimWhitespace: false,
    renderOverviewRuler: false,
    scrollBeyondLastLine: false,
    padding: { top: 12, bottom: 12 },
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false }
  })
  if (shownPath && diffs.has(shownPath)) diffEditor.setModel(diffs.get(shownPath)!)
  return () => {
    diffEditor?.setModel(null)
    diffEditor?.dispose()
    diffEditor = null
  }
}

function diffOptions(): monaco.editor.IDiffEditorOptions {
  return { ...editorOptions(), minimap: { enabled: false }, wordWrap: 'off' }
}

export function toggleDiffInline(): boolean {
  diffInline = !diffInline
  diffEditor?.updateOptions({ renderSideBySide: !diffInline })
  return diffInline
}

export function isDiffInline(): boolean {
  return diffInline
}

function languageForPath(path: string): string {
  const ext = '.' + extname(path)
  const name = basename(path)
  const lang = monaco.languages
    .getLanguages()
    .find((l) => l.filenames?.includes(name) || (ext.length > 1 && l.extensions?.includes(ext)))
  return lang?.id ?? 'plaintext'
}

/** Create or refresh the read-only model pair behind a diff tab. */
export function setDiff(key: string, file: string, original: string, modified: string): void {
  const existing = diffs.get(key)
  if (existing) {
    existing.original.setValue(original)
    existing.modified.setValue(modified)
    return
  }
  const lang = languageForPath(file)
  const n = diffs.size + Date.now()
  diffs.set(key, {
    original: monaco.editor.createModel(original, lang, monaco.Uri.from({ scheme: 'ecode-diff', path: `/${n}/a/${basename(file)}` })),
    modified: monaco.editor.createModel(modified, lang, monaco.Uri.from({ scheme: 'ecode-diff', path: `/${n}/b/${basename(file)}` }))
  })
}

/** Selected text in the main editor (null when the selection is empty). */
export function getSelectionInfo(): { text: string; startLine: number; endLine: number } | null {
  const model = editor?.getModel()
  const sel = editor?.getSelection()
  if (!model || !sel || sel.isEmpty()) return null
  return { text: model.getValueInRange(sel), startLine: sel.startLineNumber, endLine: sel.endLineNumber }
}

const extraActions: monaco.editor.IActionDescriptor[] = []

/** Add an entry to the editor's right-click menu (kept across remounts). */
export function addEditorAction(id: string, label: string, run: () => void, order: number): void {
  const action = { id, label, contextMenuGroupId: '0_eraai', contextMenuOrder: order, run }
  extraActions.push(action)
  editor?.addAction(action)
}

/**
 * Replace a model's text with `next` as one undoable edit that only touches
 * the lines that actually differ, so cursors and scroll stay put.
 * Returns the 1-based changed line range in the new text.
 */
export function applyText(path: string, next: string): { startLine: number; endLine: number } | null {
  const model = models.get(path)
  if (!model) return null
  const eol = model.getEOL()
  const oldLines = model.getLinesContent()
  const newLines = next.split(/\r?\n/)
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  )
    suffix++
  if (prefix === oldLines.length && prefix === newLines.length) return { startLine: 1, endLine: 1 }
  // Replace whole lines [prefix, oldLen - suffix) including their line breaks.
  const oldEnd = oldLines.length - suffix
  const middle = newLines.slice(prefix, newLines.length - suffix).join(eol)
  let range: monaco.Range
  let text: string
  if (oldEnd < oldLines.length) {
    range = new monaco.Range(prefix + 1, 1, oldEnd + 1, 1)
    text = prefix < newLines.length - suffix ? middle + eol : ''
  } else if (prefix > 0) {
    // Change reaches the end of the file: start from the end of the previous line.
    range = new monaco.Range(prefix, oldLines[prefix - 1].length + 1, oldLines.length, oldLines[oldLines.length - 1].length + 1)
    text = prefix < newLines.length - suffix ? eol + middle : ''
  } else {
    range = model.getFullModelRange()
    text = middle
  }
  model.pushStackElement()
  model.pushEditOperations([], [{ range, text }], () => null)
  model.pushStackElement()
  const added = newLines.length - suffix - prefix
  return { startLine: prefix + 1, endLine: prefix + Math.max(1, added) }
}

/** Briefly highlight lines that an AI edit changed, if that file is on screen. */
export function flashLines(path: string, startLine: number, endLine: number): void {
  if (!editor || shownPath !== path) return
  const ids = editor.deltaDecorations(
    [],
    [{ range: new monaco.Range(startLine, 1, endLine, 1), options: { isWholeLine: true, className: 'ai-flash' } }]
  )
  editor.revealLinesInCenterIfOutsideViewport(startLine, endLine, monaco.editor.ScrollType.Smooth)
  setTimeout(() => editor?.deltaDecorations(ids, []), 1600)
}

export function allModels(): [string, Model][] {
  return [...models.entries()]
}

export function applyEditorOptions(): void {
  monaco.editor.setTheme(getState().settings.theme)
  editor?.updateOptions(editorOptions())
  diffEditor?.updateOptions(diffOptions())
  for (const m of models.values()) m.updateOptions({ tabSize: getState().settings.tabSize })
}

export function hasModel(path: string): boolean {
  return models.has(path) || diffs.has(path)
}

export function createModel(path: string, content: string, language?: string): Model {
  const existing = models.get(path)
  if (existing) return existing
  const uri = uriFor(path)
  lsp.dropShadowModel(uri)
  const model = monaco.editor.createModel(content, language, uri)
  model.updateOptions({ tabSize: getState().settings.tabSize })
  models.set(path, model)
  savedVersions.set(path, model.getAlternativeVersionId())
  // Per model, not per editor: rename/refactor edits can touch files in background tabs.
  model.onDidChangeContent(() => {
    if (models.get(path) === model) syncDirty(path)
  })
  if (!isUntitled(path)) lsp.attachModel(path, model)
  return model
}

export function show(path: string | null, focus = true): void {
  if (editor && shownPath && shownPath !== path && models.has(shownPath)) {
    viewStates.set(shownPath, editor.saveViewState())
  }
  shownPath = path
  const diff = path ? diffs.get(path) : undefined
  if (diff) {
    editor?.setModel(null)
    diffEditor?.setModel(diff)
    setState({ language: diff.modified.getLanguageId(), cursor: { line: 1, column: 1, selected: 0 } })
    return
  }
  diffEditor?.setModel(null)
  if (!editor) return
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
  lsp.didSave(model)
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
  const diff = diffs.get(path)
  if (diff) {
    if (shownPath === path) {
      diffEditor?.setModel(null)
      shownPath = null
    }
    diff.original.dispose()
    diff.modified.dispose()
    diffs.delete(path)
    return
  }
  const model = models.get(path)
  if (shownPath === path) {
    editor?.setModel(null)
    shownPath = null
  }
  if (model) lsp.detachModel(model)
  model?.dispose()
  models.delete(path)
  savedVersions.delete(path)
  viewStates.delete(path)
}

export function setLanguage(path: string, languageId: string): void {
  const model = models.get(path)
  if (!model) return
  lsp.detachModel(model)
  monaco.editor.setModelLanguage(model, languageId)
  if (!isUntitled(path)) lsp.attachModel(path, model)
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
