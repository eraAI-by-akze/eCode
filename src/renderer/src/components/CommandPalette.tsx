import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStore, getState, type PickItem } from '../store'
import * as a from '../actions'
import * as ed from '../editorService'
import { COMMANDS, formatKeys } from '../commands'
import { fuzzy, fuzzyPath } from '../lib/fuzzy'
import { basename, relative } from '../lib/path'
import { FileIcon, IconSparkle } from './Icons'

interface Item {
  key: string
  label: string
  labelIndices?: number[]
  detail?: string
  hint?: string
  icon?: ReactNode
  active?: boolean
  run: () => void
}

const MAX_ITEMS = 80

function highlight(text: string, indices?: number[]): ReactNode {
  if (!indices?.length) return text
  const set = new Set(indices)
  const out: ReactNode[] = []
  let buf = ''
  let inMatch = false
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i)
    if (m !== inMatch && buf) {
      out.push(inMatch ? <b key={i}>{buf}</b> : buf)
      buf = ''
    }
    inMatch = m
    buf += text[i]
  }
  if (buf) out.push(inMatch ? <b key="end">{buf}</b> : buf)
  return out
}

export function CommandPalette() {
  const palette = useStore((s) => s.palette)
  if (!palette) return null
  return <PaletteInner key={palette.kind === 'pick' ? palette.placeholder : 'quick'} />
}

function PaletteInner() {
  const palette = useStore((s) => s.palette)!
  const root = useStore((s) => s.root)
  const tabs = useStore((s) => s.tabs)
  const [value, setValue] = useState(palette.kind === 'quick' ? palette.value : '')
  const [index, setIndex] = useState(0)
  const [files, setFiles] = useState<string[] | null>(getState().fileIndex)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const mode = palette.kind === 'pick' ? 'pick' : value.startsWith('>') ? 'commands' : value.startsWith(':') ? 'line' : 'files'

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (mode === 'files' && !files) a.getFileIndex().then(setFiles)
  }, [mode, files])

  const items: Item[] = useMemo(() => {
    const close = (fn: () => void) => () => {
      a.closePalette()
      fn()
    }
    if (palette.kind === 'pick') {
      return rank(palette.items, value, (it: PickItem) => it.label).map(({ item, indices }) => ({
        key: item.id,
        label: item.label,
        labelIndices: indices,
        detail: item.detail,
        hint: item.hint,
        active: item.active,
        run: close(() => palette.onPick(item.id))
      }))
    }
    if (mode === 'commands') {
      const q = value.slice(1).trim()
      const avail = COMMANDS.filter((c) => !c.when || c.when())
      return rank(avail, q, (c) => c.label).map(({ item, indices }) => ({
        key: item.id,
        label: item.label,
        labelIndices: indices,
        hint: formatKeys(item.keys),
        icon: <IconSparkle size={13} />,
        run: close(item.run)
      }))
    }
    if (mode === 'line') {
      const [lineStr, colStr] = value.slice(1).split(/[:,]/)
      const line = parseInt(lineStr, 10)
      const col = parseInt(colStr, 10)
      if (!getState().active) return []
      if (!line) return [{ key: 'hint', label: 'Введите номер строки (и колонки через «:»)', run: () => {} }]
      return [
        {
          key: 'go',
          label: `Перейти к строке ${line}${col ? `, колонке ${col}` : ''}`,
          run: close(() => ed.revealRange(line, col || 1)),
          icon: <IconSparkle size={13} />
        }
      ]
    }
    // Files: open tabs first (recent work), then the indexed workspace.
    const q = value.trim()
    const seen = new Set<string>()
    const out: { item: Item; score: number }[] = []
    const openPaths = [...tabs].reverse().map((t) => t.path)
    const candidates = [...openPaths, ...(files ?? [])]
    for (const path of candidates) {
      if (seen.has(path)) continue
      seen.add(path)
      const rel = path.startsWith('untitled:') ? path.slice(9) : relative(root, path)
      const m = fuzzyPath(q, rel)
      if (!m) continue
      const name = basename(rel)
      const isOpen = openPaths.includes(path)
      out.push({
        score: m.score + (isOpen ? (q ? 2 : 1000 - openPaths.indexOf(path)) : 0),
        item: {
          key: path,
          label: name,
          labelIndices: m.inName ? m.indices : undefined,
          detail: rel.slice(0, Math.max(0, rel.length - name.length - 1)),
          hint: isOpen ? 'открыт' : undefined,
          icon: <FileIcon name={name} size={15} />,
          run: close(() => a.openFile(path))
        }
      })
      if (!q && out.length > MAX_ITEMS * 2) break
    }
    out.sort((x, y) => y.score - x.score)
    return out.slice(0, MAX_ITEMS).map((o) => o.item)
  }, [palette, value, mode, files, tabs, root])

  useEffect(() => {
    const activeIdx = palette.kind === 'pick' && !value ? items.findIndex((i) => i.active) : -1
    setIndex(activeIdx >= 0 ? activeIdx : 0)
  }, [items, palette.kind, value])

  useEffect(() => {
    listRef.current?.children[index]?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const placeholder =
    palette.kind === 'pick'
      ? palette.placeholder
      : 'Имя файла · «>» команды · «:» строка'

  return (
    <div className="palette-backdrop" onMouseDown={() => a.closePalette()}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') a.closePalette()
            else if (e.key === 'ArrowDown') setIndex((i) => Math.min(items.length - 1, i + 1))
            else if (e.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1))
            else if (e.key === 'PageDown') setIndex((i) => Math.min(items.length - 1, i + 10))
            else if (e.key === 'PageUp') setIndex((i) => Math.max(0, i - 10))
            else if (e.key === 'Enter') items[index]?.run()
            else return
            e.preventDefault()
          }}
        />
        <div className="palette-list" ref={listRef}>
          {items.map((it, i) => (
            <div
              key={it.key}
              className={`palette-item ${i === index ? 'selected' : ''} ${it.active ? 'current' : ''}`}
              onMouseMove={() => i !== index && setIndex(i)}
              onClick={() => it.run()}
            >
              {it.icon && <span className="pi-icon">{it.icon}</span>}
              <span className="pi-label">{highlight(it.label, it.labelIndices)}</span>
              {it.detail && <span className="pi-detail">{it.detail}</span>}
              {it.hint && <kbd className="pi-hint">{it.hint}</kbd>}
            </div>
          ))}
          {mode === 'files' && !files && root && <div className="palette-empty">Индексирую файлы…</div>}
          {mode === 'files' && !root && !tabs.length && (
            <div className="palette-empty">Откройте папку, чтобы искать файлы. Введите «&gt;» для команд.</div>
          )}
          {items.length === 0 && (mode !== 'files' || (files && root)) && <div className="palette-empty">Ничего не найдено</div>}
        </div>
      </div>
    </div>
  )
}

function rank<T>(list: T[], q: string, text: (t: T) => string): { item: T; indices?: number[] }[] {
  if (!q) return list.map((item) => ({ item }))
  return list
    .map((item) => ({ item, m: fuzzy(q, text(item)) }))
    .filter((x) => x.m)
    .sort((x, y) => y.m!.score - x.m!.score)
    .map(({ item, m }) => ({ item, indices: m!.indices }))
}
