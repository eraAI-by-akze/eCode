import { monaco } from './monaco'
import { getState, useStore, type Breakpoint } from './store'
import { getEditor, getModel, onEditorMounted, onModelCreated, pathForModel } from './editorService'
import * as dbg from './debugService'
import { prompt } from './actions'

/**
 * The editor side of debugging: breakpoints in the glyph margin (click, F9),
 * the paused line, and variable values on hover while stopped.
 */

/** Breakpoint decoration ids per file, in the same order as `ids`. */
const bpDecos = new Map<string, { ids: string[]; bps: string[] }>()
const frameDecos = new Map<string, string[]>()
let hintDeco: monaco.editor.IEditorDecorationsCollection | null = null

function bpClass(b: Breakpoint, debugging: boolean): string {
  const kind = b.logMessage ? 'log' : b.condition ? 'cond' : 'plain'
  const state = !b.enabled ? 'disabled' : debugging && b.verified === false ? 'unverified' : 'on'
  return `bp-glyph bp-${kind} bp-${state}`
}

function bpHover(b: Breakpoint): string {
  if (b.logMessage) return `Точка журнала: ${b.logMessage}`
  if (b.condition) return `Условие: ${b.condition}`
  if (b.message) return b.message
  return b.verified === false ? 'Точка останова ещё не привязана к коду' : 'Точка останова'
}

function renderBreakpoints(path: string): void {
  const model = getModel(path)
  if (!model || model.isDisposed()) return
  const debugging = !!getState().debug
  const list = getState().breakpoints.filter((b) => b.path === path && b.line <= model.getLineCount())
  const prev = bpDecos.get(path)?.ids ?? []
  const ids = model.deltaDecorations(
    prev,
    list.map((b) => ({
      range: new monaco.Range(b.line, 1, b.line, 1),
      options: {
        glyphMarginClassName: bpClass(b, debugging),
        glyphMarginHoverMessage: { value: bpHover(b) },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        overviewRuler: { color: '#e5484d', position: monaco.editor.OverviewRulerLane.Left }
      }
    }))
  )
  bpDecos.set(path, { ids, bps: list.map((b) => b.id) })
}

function renderFrame(): void {
  const d = getState().debug
  const frame = d?.status === 'paused' ? d.frames.find((f) => f.id === d.frameId) : undefined
  const top = d?.frames.find((f) => f.path)
  for (const [path, ids] of frameDecos) {
    const model = getModel(path)
    if (model && !model.isDisposed()) model.deltaDecorations(ids, [])
  }
  frameDecos.clear()
  if (!frame?.path) return
  const model = getModel(frame.path)
  if (!model || frame.line > model.getLineCount()) return
  const isTop = frame.id === top?.id
  const kind = isTop ? (d?.stopReason === 'exception' ? 'exception' : 'current') : 'frame'
  const decos: monaco.editor.IModelDeltaDecoration[] = [
    {
      range: new monaco.Range(frame.line, 1, frame.line, 1),
      options: {
        isWholeLine: true,
        className: `debug-line debug-line-${kind}`,
        glyphMarginClassName: `debug-arrow debug-arrow-${kind}`,
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
      }
    }
  ]
  if (isTop && d?.exception) {
    const max = model.getLineMaxColumn(frame.line)
    decos.push({
      range: new monaco.Range(frame.line, max, frame.line, max),
      options: { showIfCollapsed: true, after: { content: `   ⚡ ${d.exception}`, inlineClassName: 'debug-exception-text' } }
    })
  }
  frameDecos.set(frame.path, model.deltaDecorations([], decos))
}

/** Read back where edits moved the breakpoints of a file. */
let moveTimer = 0
function trackMoves(path: string): void {
  clearTimeout(moveTimer)
  moveTimer = window.setTimeout(() => {
    const model = getModel(path)
    const entry = bpDecos.get(path)
    if (!model || !entry) return
    const lines = new Map<string, number>()
    entry.ids.forEach((id, i) => {
      const r = model.getDecorationRange(id)
      if (r) lines.set(entry.bps[i], r.startLineNumber)
    })
    dbg.moveBreakpoints(path, lines)
  }, 250)
}

function activePathAndLine(): { path: string; line: number } | null {
  const ed = getEditor()
  const model = ed?.getModel()
  const path = model ? pathForModel(model) : null
  const pos = ed?.getPosition()
  return path && pos ? { path, line: pos.lineNumber } : null
}

export function toggleAtCursor(): void {
  const at = activePathAndLine()
  if (at) dbg.toggleBreakpoint(at.path, at.line)
}

export function conditionalAtCursor(kind: 'condition' | 'log'): void {
  const at = activePathAndLine()
  if (!at) return
  const existing = getState().breakpoints.find((b) => b.path === at.path && b.line === at.line)
  prompt(
    kind === 'condition' ? 'например: i > 10' : 'например: x = {x}',
    kind === 'condition' ? `Условие остановки (строка ${at.line})` : `Сообщение точки журнала (строка ${at.line})`,
    (value) =>
      dbg.setBreakpointOptions(at.path, at.line, kind === 'condition' ? { condition: value, logMessage: existing?.logMessage } : { logMessage: value, condition: existing?.condition })
  )
}

/** Expression under the mouse: a dotted identifier chain, e.g. self.items[0] → self.items. */
function expressionAt(model: monaco.editor.ITextModel, pos: monaco.Position): { text: string; range: monaco.Range } | null {
  const line = model.getLineContent(pos.lineNumber)
  const re = /[A-Za-z_$][\w$]*(?:(?:\.|->|::)[A-Za-z_$][\w$]*)*/g
  for (const m of line.matchAll(re)) {
    const start = m.index! + 1
    const end = start + m[0].length
    if (pos.column >= start && pos.column <= end) {
      // Only up to the hovered segment: hovering "a" in a.b.c evaluates "a".
      const upTo = m[0].slice(0, pos.column - start)
      const tail = m[0].slice(pos.column - start).match(/^[\w$]*/)?.[0] ?? ''
      const text = upTo + tail
      return { text, range: new monaco.Range(pos.lineNumber, start, pos.lineNumber, start + text.length) }
    }
  }
  return null
}

const KEYWORDS = new Set(['def', 'class', 'return', 'if', 'else', 'for', 'while', 'in', 'import', 'from', 'fn', 'let', 'mut', 'pub', 'use', 'var', 'new', 'public', 'private', 'static', 'void', 'int', 'string', 'true', 'false', 'None', 'null'])

export function initDebugEditor(): void {
  onModelCreated((model) => {
    const path = pathForModel(model)
    if (!path) return
    renderBreakpoints(path)
    renderFrame()
    model.onDidChangeContent(() => trackMoves(path))
  })

  onEditorMounted((ed) => [
    ed.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.event.leftButton) return
      const model = ed.getModel()
      const path = model ? pathForModel(model) : null
      const line = e.target.position?.lineNumber
      if (path && line) dbg.toggleBreakpoint(path, line)
    }),
    // A faint dot follows the mouse in the glyph margin, as in VS Code.
    ed.onMouseMove((e) => {
      hintDeco ??= ed.createDecorationsCollection()
      const line = e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ? e.target.position?.lineNumber : undefined
      const model = ed.getModel()
      const path = model ? pathForModel(model) : null
      const taken = line && getState().breakpoints.some((b) => b.path === path && b.line === line)
      hintDeco.set(line && !taken ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'bp-glyph bp-hint' } }] : [])
    }),
    ed.onMouseLeave(() => hintDeco?.clear()),
    { dispose: () => (hintDeco = null) }
  ])

  monaco.languages.registerHoverProvider('*', {
    provideHover: async (model, position) => {
      if (getState().debug?.status !== 'paused') return null
      const hit = expressionAt(model, position)
      if (!hit || KEYWORDS.has(hit.text)) return null
      try {
        const r = await dbg.evaluate(hit.text, 'hover')
        const type = r.type ? `  // ${r.type}` : ''
        return { range: hit.range, contents: [{ value: '```\n' + `${hit.text} = ${r.value}${type}` + '\n```' }] }
      } catch {
        return null
      }
    }
  })

  useStore.subscribe((s, prev) => {
    if (s.breakpoints !== prev.breakpoints || !!s.debug !== !!prev.debug) {
      const paths = new Set([...s.breakpoints.map((b) => b.path), ...prev.breakpoints.map((b) => b.path)])
      for (const p of paths) renderBreakpoints(p)
    }
    if (s.debug?.frameId !== prev.debug?.frameId || s.debug?.status !== prev.debug?.status || s.debug?.stopSeq !== prev.debug?.stopSeq) {
      renderFrame()
    }
    if (s.root !== prev.root) dbg.loadBreakpoints()
  })
}
