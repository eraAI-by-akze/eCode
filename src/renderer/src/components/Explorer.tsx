import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { DirEntry } from '@shared/types'
import { useStore, setState, getState } from '../store'
import * as a from '../actions'
import { focusEditor } from '../editorService'
import { basename, dirname, relative } from '../lib/path'
import {
  FileIcon,
  IconChevron,
  IconCollapse,
  IconFilePlus,
  IconFolderOpen,
  IconFolderPlus,
  IconRefresh
} from './Icons'

const ROW = 24
const api = window.ecode

type Row =
  | { kind: 'entry'; entry: DirEntry; depth: number; open: boolean }
  | { kind: 'input'; mode: 'newFile' | 'newFolder' | 'rename'; dir: string; depth: number; initial: string; path?: string }

function useRows(): Row[] {
  const root = useStore((s) => s.root)
  const tree = useStore((s) => s.tree)
  const expanded = useStore((s) => s.expanded)
  const inlineEdit = useStore((s) => s.inlineEdit)

  return useMemo(() => {
    const rows: Row[] = []
    if (!root) return rows
    const visit = (dir: string, depth: number): void => {
      if (inlineEdit && inlineEdit.kind !== 'rename' && inlineEdit.dir === dir) {
        rows.push({ kind: 'input', mode: inlineEdit.kind, dir, depth, initial: '' })
      }
      for (const entry of tree[dir] ?? []) {
        if (inlineEdit?.kind === 'rename' && inlineEdit.path === entry.path) {
          rows.push({ kind: 'input', mode: 'rename', dir, depth, initial: entry.name, path: entry.path })
        } else {
          const open = entry.isDir && !!expanded[entry.path]
          rows.push({ kind: 'entry', entry, depth, open })
        }
        if (entry.isDir && expanded[entry.path]) visit(entry.path, depth + 1)
      }
    }
    visit(root, 0)
    return rows
  }, [root, tree, expanded, inlineEdit])
}

function InlineInput({ row }: { row: Extract<Row, { kind: 'input' }> }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    // Select the stem so renaming "app.tsx" starts with "app" highlighted.
    const dot = row.initial.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : row.initial.length)
  }, [row.initial])

  const commit = (value: string): void => {
    if (done.current) return
    done.current = true
    if (row.mode === 'rename' && row.path) a.commitRename(row.path, value)
    else if (row.mode !== 'rename') a.commitCreate(row.mode, row.dir, value)
  }

  return (
    <div className="tree-row tree-input" style={{ paddingLeft: 10 + row.depth * 14 + 18 }}>
      {row.mode === 'newFolder' ? <IconFolderOpen size={15} /> : <FileIcon name={row.initial || 'file'} />}
      <input
        ref={ref}
        defaultValue={row.initial}
        spellCheck={false}
        placeholder={row.mode === 'newFolder' ? 'имя папки' : 'имя файла'}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') commit(e.currentTarget.value)
          if (e.key === 'Escape') {
            done.current = true
            setState({ inlineEdit: null })
          }
        }}
        onBlur={(e) => commit(e.currentTarget.value)}
      />
    </div>
  )
}

async function showContextMenu(entry: DirEntry | null): Promise<void> {
  const root = getState().root
  if (!root) return
  const target = entry ?? { name: basename(root), path: root, isDir: true }
  const dir = target.isDir ? target.path : dirname(target.path)
  const isRoot = target.path === root
  const id = await api.contextMenu([
    { id: 'newFile', label: 'Новый файл' },
    { id: 'newFolder', label: 'Новая папка' },
    { type: 'separator' },
    ...(!target.isDir ? [{ id: 'open', label: 'Открыть' }] : []),
    { id: 'reveal', label: 'Показать в системе' },
    { id: 'copyPath', label: 'Копировать путь' },
    { id: 'copyRel', label: 'Копировать относительный путь' },
    ...(!isRoot
      ? [
          { type: 'separator' as const },
          { id: 'rename', label: 'Переименовать', accelerator: 'F2' },
          { id: 'delete', label: 'Удалить', accelerator: 'Delete' }
        ]
      : [])
  ])
  switch (id) {
    case 'newFile':
    case 'newFolder':
      a.beginCreate(id, dir)
      break
    case 'open':
      a.openFile(target.path)
      break
    case 'reveal':
      api.revealInFolder(target.path)
      break
    case 'copyPath':
      navigator.clipboard.writeText(target.path)
      break
    case 'copyRel':
      navigator.clipboard.writeText(relative(root, target.path))
      break
    case 'rename':
      setState({ inlineEdit: { kind: 'rename', path: target.path } })
      break
    case 'delete':
      a.deleteEntry(target.path)
      break
  }
}

export function Explorer() {
  const root = useStore((s) => s.root)
  const selected = useStore((s) => s.selected)
  const active = useStore((s) => s.active)
  const dirtyPaths = useStore((s) => s.tabs.filter((t) => t.dirty).map((t) => t.path).join('\n'))
  const recent = useStore((s) => s.settings.recent)
  const rows = useRows()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(600)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [root])

  // Keep the selected row in view when it changes from elsewhere (reveal, keyboard).
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !selected) return
    const i = rows.findIndex((r) => r.kind === 'entry' && r.entry.path === selected)
    if (i < 0) return
    const top = i * ROW
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight
  }, [selected, rows])

  if (!root) {
    return (
      <div className="sidebar-empty">
        <p>Папка не открыта</p>
        <button className="btn-primary" onClick={() => a.openFolder()}>
          Открыть папку
        </button>
        {recent.length > 0 && (
          <div className="recent-list">
            <div className="section-label">Недавние</div>
            {recent.slice(0, 6).map((r) => (
              <button key={r} className="recent-item" title={r} onClick={() => a.openFolder(r)}>
                <IconFolderOpen size={14} />
                <span>{basename(r)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  const dirty = new Set(dirtyPaths ? dirtyPaths.split('\n') : [])
  const overscan = 10
  const start = Math.max(0, Math.floor(scrollTop / ROW) - overscan)
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW) + overscan)

  const activate = (entry: DirEntry): void => {
    setState({ selected: entry.path })
    if (entry.isDir) a.toggleDir(entry.path)
    else a.openFile(entry.path, { preserveFocus: true })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const entries = rows.filter((r): r is Extract<Row, { kind: 'entry' }> => r.kind === 'entry')
    const i = entries.findIndex((r) => r.entry.path === selected)
    const cur = entries[i]
    const select = (r?: (typeof entries)[number]): void => {
      if (r) setState({ selected: r.entry.path })
    }
    switch (e.key) {
      case 'ArrowDown':
        select(entries[Math.min(entries.length - 1, i + 1)])
        break
      case 'ArrowUp':
        select(entries[Math.max(0, i - 1)])
        break
      case 'ArrowRight':
        if (cur?.entry.isDir) {
          if (!cur.open) a.toggleDir(cur.entry.path, true)
          else select(entries[i + 1])
        }
        break
      case 'ArrowLeft':
        if (cur?.entry.isDir && cur.open) a.toggleDir(cur.entry.path, false)
        else if (cur) setState({ selected: dirname(cur.entry.path) })
        break
      case 'Enter':
        if (cur?.entry.isDir) a.toggleDir(cur.entry.path)
        else if (cur) a.openFile(cur.entry.path)
        break
      case 'F2':
        if (cur) setState({ inlineEdit: { kind: 'rename', path: cur.entry.path } })
        break
      case 'Delete':
      case 'Backspace':
        if (cur && (e.key === 'Delete' || e.metaKey)) a.deleteEntry(cur.entry.path)
        break
      default:
        return
    }
    e.preventDefault()
  }

  return (
    <div className="explorer">
      <div className="sidebar-section-header">
        <span className="folder-name" title={root}>
          {basename(root)}
        </span>
        <div className="header-actions">
          <button title="Новый файл" onClick={() => a.beginCreate('newFile')}>
            <IconFilePlus size={15} />
          </button>
          <button title="Новая папка" onClick={() => a.beginCreate('newFolder')}>
            <IconFolderPlus size={15} />
          </button>
          <button title="Обновить" onClick={() => a.refreshTree()}>
            <IconRefresh size={15} />
          </button>
          <button title="Свернуть все" onClick={() => a.collapseAll()}>
            <IconCollapse size={15} />
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="tree"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onContextMenu={(e) => {
          e.preventDefault()
          showContextMenu(null)
        }}
      >
        <div style={{ height: rows.length * ROW, position: 'relative' }}>
          <div style={{ transform: `translateY(${start * ROW}px)` }}>
            {rows.slice(start, end).map((row) => {
              if (row.kind === 'input') return <InlineInput key={`input:${row.dir}:${row.path ?? ''}`} row={row} />
              const { entry, depth, open } = row
              const isSel = selected === entry.path
              const isActive = active === entry.path
              return (
                <div
                  key={entry.path}
                  className={`tree-row ${isSel ? 'selected' : ''} ${isActive ? 'active' : ''} ${dirty.has(entry.path) ? 'dirty' : ''}`}
                  style={{ paddingLeft: 10 + depth * 14 }}
                  onClick={() => activate(entry)}
                  onDoubleClick={() => !entry.isDir && focusEditor()}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setState({ selected: entry.path })
                    showContextMenu(entry)
                  }}
                  title={entry.path}
                >
                  {depth > 0 &&
                    Array.from({ length: depth }, (_, d) => (
                      <span key={d} className="indent-guide" style={{ left: 17 + d * 14 }} />
                    ))}
                  {entry.isDir ? (
                    <IconChevron size={14} className={`chev ${open ? 'open' : ''}`} />
                  ) : (
                    <span className="chev-spacer" />
                  )}
                  {entry.isDir ? (
                    <span className={`folder-icon ${open ? 'open' : ''}`} />
                  ) : (
                    <FileIcon name={entry.name} />
                  )}
                  <span className="tree-label">{entry.name}</span>
                  {dirty.has(entry.path) && <span className="dirty-dot" />}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
