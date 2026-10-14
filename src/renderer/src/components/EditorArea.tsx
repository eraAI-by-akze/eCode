import { useEffect, useRef, useState } from 'react'
import { useStore, type Tab } from '../store'
import * as scm from '../scm'
import { useAllDiagnostics } from './Panel'
import * as a from '../actions'
import * as ed from '../editorService'
import { basename, relative } from '../lib/path'
import { formatKeys } from '../commands'
import { DebugToolbar } from './DebugToolbar'
import { FileIcon, IconChevron, IconClose, IconColumns, IconGoToFile, IconMinus, IconPlus, Logo } from './Icons'

const api = window.ecode

function Tabs() {
  const tabs = useStore((s) => s.tabs)
  const active = useStore((s) => s.active)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const diagnostics = useAllDiagnostics()

  // Scroll the active tab into view.
  useEffect(() => {
    ref.current?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  const names = new Map<string, number>()
  for (const t of tabs) names.set(t.name, (names.get(t.name) ?? 0) + 1)

  return (
    <div className="tabs" ref={ref} onWheel={(e) => (e.currentTarget.scrollLeft += e.deltaY)}>
      {tabs.map((t, i) => (
        <div
          key={t.path}
          className={`tab ${t.path === active ? 'active' : ''} ${t.dirty ? 'dirty' : ''} ${
            diagnostics[t.path]?.some((d) => d.severity === 'error')
              ? 'has-errors'
              : diagnostics[t.path]?.some((d) => d.severity === 'warning')
                ? 'has-warnings'
                : ''
          }`}
          title={t.path.replace(/^untitled:/, '')}
          draggable
          onDragStart={() => setDragIndex(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            if (dragIndex !== null && dragIndex !== i) a.moveTab(dragIndex, i)
            setDragIndex(null)
          }}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              a.closeTab(t.path)
            }
          }}
          onClick={() => a.setActive(t.path)}
          onContextMenu={async (e) => {
            e.preventDefault()
            const id = await api.contextMenu([
              { id: 'close', label: 'Закрыть' },
              { id: 'others', label: 'Закрыть остальные' },
              { id: 'all', label: 'Закрыть все' },
              { type: 'separator' },
              { id: 'reveal', label: 'Показать в проводнике', enabled: !t.path.startsWith('untitled:') && !t.diff },
              { id: 'copy', label: 'Копировать путь', enabled: !t.path.startsWith('untitled:') && !t.diff }
            ])
            if (id === 'close') a.closeTab(t.path)
            if (id === 'others') a.closeOthers(t.path)
            if (id === 'all') a.closeAll()
            if (id === 'reveal') a.revealInTree(t.path)
            if (id === 'copy') navigator.clipboard.writeText(t.path)
          }}
        >
          <FileIcon name={t.diff ? basename(t.diff.file) : t.name} size={15} />
          <span className="tab-name">{t.name}</span>
          {(names.get(t.name) ?? 0) > 1 && (
            <span className="tab-hint">{basename(t.path.slice(0, t.path.length - t.name.length - 1))}</span>
          )}
          <button
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation()
              a.closeTab(t.path)
            }}
            aria-label="Закрыть"
          >
            <span className="dot" />
            <IconClose size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}

function Breadcrumbs() {
  const active = useStore((s) => s.active)
  const root = useStore((s) => s.root)
  if (!active) return null
  const rel = active.startsWith('untitled:') ? active.slice(9) : relative(root, active)
  const parts = rel.split(/[\\/]/).filter(Boolean)
  return (
    <div className="breadcrumbs">
      {root && !active.startsWith('untitled:') && rel !== active && (
        <>
          <span className="crumb">{basename(root)}</span>
          <IconChevron size={12} />
        </>
      )}
      {parts.map((p, i) => (
        <span key={i} className="crumb-wrap">
          <span className={`crumb ${i === parts.length - 1 ? 'last' : ''}`}>
            {i === parts.length - 1 && <FileIcon name={p} size={13} />}
            {p}
          </span>
          {i < parts.length - 1 && <IconChevron size={12} />}
        </span>
      ))}
    </div>
  )
}

function DiffBar({ tab }: { tab: Tab & { diff: NonNullable<Tab['diff']> } }) {
  const root = useStore((s) => s.root)
  const file = useStore((s) => s.git?.files.find((f) => f.path === tab.diff.file))
  const [inline, setInline] = useState(ed.isDiffInline())
  return (
    <div className="breadcrumbs diff-bar">
      <FileIcon name={basename(tab.diff.file)} size={13} />
      <span className="crumb last">{relative(root, tab.diff.file)}</span>
      <span className="diff-label">{tab.diff.staged ? 'HEAD ↔ индекс' : 'индекс ↔ рабочая копия'}</span>
      <div className="diff-actions">
        {file && (
          <button onClick={() => scm.openChangedFile(file)} title="Открыть файл">
            <IconGoToFile size={14} />
            Открыть
          </button>
        )}
        {file &&
          (tab.diff.staged ? (
            <button onClick={() => scm.unstage([file.path])} title="Убрать из индекса">
              <IconMinus size={14} />
              Из индекса
            </button>
          ) : (
            <button onClick={() => scm.stage([file.path])} title="Индексировать">
              <IconPlus size={14} />
              В индекс
            </button>
          ))}
        <button onClick={() => setInline(ed.toggleDiffInline())} title="Рядом / в одну колонку">
          <IconColumns size={14} />
          {inline ? 'В колонку' : 'Рядом'}
        </button>
      </div>
    </div>
  )
}

function Welcome() {
  const recent = useStore((s) => s.settings.recent)
  const root = useStore((s) => s.root)
  const shortcuts: [string, string][] = [
    ['Перейти к файлу', 'mod+p'],
    ['Палитра команд', 'mod+shift+p'],
    ['Поиск по файлам', 'mod+shift+f'],
    ['Терминал', 'mod+j'],
    ['Боковая панель', 'mod+b'],
    ['Сохранить', 'mod+s']
  ]
  return (
    <div className="welcome">
      <div className="welcome-hero">
        <Logo size={64} />
        <h1>
          eCode<span>.</span>
        </h1>
        <p>For humans and comfort — быстрый редактор кода в стиле eraAI</p>
      </div>
      <div className="welcome-grid">
        <div className="welcome-col">
          <div className="section-label">Начать</div>
          <button className="welcome-action" onClick={() => a.openFolder()}>
            Открыть папку…<kbd>{formatKeys(['mod+o'])}</kbd>
          </button>
          <button className="welcome-action" onClick={() => a.newUntitled()}>
            Новый файл<kbd>{formatKeys(['mod+n'])}</kbd>
          </button>
          <button className="welcome-action" onClick={() => a.pickTheme()}>
            Выбрать тему…
          </button>
          {recent.length > 0 && !root && (
            <>
              <div className="section-label" style={{ marginTop: 18 }}>
                Недавние
              </div>
              {recent.slice(0, 5).map((r) => (
                <button key={r} className="welcome-recent" onClick={() => a.openFolder(r)} title={r}>
                  <strong>{basename(r)}</strong>
                  <span>{r}</span>
                </button>
              ))}
            </>
          )}
        </div>
        <div className="welcome-col">
          <div className="section-label">Горячие клавиши</div>
          {shortcuts.map(([label, keys]) => (
            <div key={keys} className="shortcut-row">
              <span>{label}</span>
              <kbd>{formatKeys([keys])}</kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function EditorArea() {
  const hostRef = useRef<HTMLDivElement>(null)
  const diffRef = useRef<HTMLDivElement>(null)
  const hasTabs = useStore((s) => s.tabs.length > 0)
  const activeTab = useStore((s) => s.tabs.find((t) => t.path === s.active))

  useEffect(() => {
    if (!hostRef.current) return
    return ed.mountEditor(hostRef.current)
  }, [])
  useEffect(() => {
    if (!diffRef.current) return
    return ed.mountDiffEditor(diffRef.current)
  }, [])

  const diffTab = activeTab?.diff ? (activeTab as Tab & { diff: NonNullable<Tab['diff']> }) : null

  return (
    <div className="editor-area glass-editor">
      {hasTabs && <Tabs />}
      {hasTabs && (diffTab ? <DiffBar tab={diffTab} /> : <Breadcrumbs />)}
      <div className="editor-host" ref={hostRef} style={{ display: hasTabs && !diffTab ? 'block' : 'none' }} />
      <div className="editor-host" ref={diffRef} style={{ display: diffTab ? 'block' : 'none' }} />
      {!hasTabs && <Welcome />}
      <DebugToolbar />
    </div>
  )
}
