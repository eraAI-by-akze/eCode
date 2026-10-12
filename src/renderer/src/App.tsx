import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useStore } from './store'
import * as a from './actions'
import { commandForEvent } from './commands'
import { TitleBar } from './components/TitleBar'
import { ActivityBar } from './components/ActivityBar'
import { Sidebar } from './components/Sidebar'
import { EditorArea } from './components/EditorArea'
import { Panel } from './components/Panel'
import { StatusBar } from './components/StatusBar'
import { CommandPalette } from './components/CommandPalette'

const api = window.ecode

function Resizer({
  axis,
  value,
  min,
  max,
  invert,
  onChange
}: {
  axis: 'x' | 'y'
  value: number
  min: number
  max: number
  invert?: boolean
  onChange: (v: number, done: boolean) => void
}) {
  const start = useRef<{ pos: number; value: number } | null>(null)
  const clamp = (v: number): number => Math.max(min, Math.min(max, v))
  const pos = (e: ReactPointerEvent): number => (axis === 'x' ? e.clientX : e.clientY)
  return (
    <div
      className={`resizer resizer-${axis}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { pos: pos(e), value }
        document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y')
      }}
      onPointerMove={(e) => {
        if (!start.current) return
        const d = pos(e) - start.current.pos
        onChange(clamp(start.current.value + (invert ? -d : d)), false)
      }}
      onPointerUp={(e) => {
        if (!start.current) return
        const d = pos(e) - start.current.pos
        onChange(clamp(start.current.value + (invert ? -d : d)), true)
        start.current = null
        document.body.classList.remove('resizing-x', 'resizing-y')
      }}
    />
  )
}

function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.message}
        </div>
      ))}
    </div>
  )
}

export function App() {
  const ready = useStore((s) => s.ready)
  const sidebar = useStore((s) => s.sidebar)
  const panelOpen = useStore((s) => s.panelOpen)
  const settings = useStore((s) => s.settings)
  const widthKey = sidebar === 'ai' ? 'aiPanelWidth' : 'sidebarWidth'
  const [sidebarWidth, setSidebarWidth] = useState(settings[widthKey])
  const [panelHeight, setPanelHeight] = useState(settings.panelHeight)
  const [panelMounted, setPanelMounted] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    setSidebarWidth(settings[widthKey])
    setPanelHeight(settings.panelHeight)
  }, [settings, widthKey])

  useEffect(() => {
    if (panelOpen) setPanelMounted(true)
  }, [panelOpen])

  // Global shortcuts run in the capture phase so they win over Monaco.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const cmd = commandForEvent(e)
      if (!cmd || (cmd.when && !cmd.when())) return
      // Inside the terminal, keys belong to the shell unless the command is global.
      if (!cmd.global && (document.activeElement as HTMLElement | null)?.closest('.xterm')) return
      e.preventDefault()
      e.stopPropagation()
      cmd.run()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div
      className={`app ${ready ? 'ready' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.relatedTarget) setDragOver(false)
      }}
      onDrop={async (e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        setDragOver(false)
        for (const file of Array.from(e.dataTransfer.files)) {
          const p = api.getPathForFile(file)
          if (!p) continue
          const st = await api.stat(p)
          if (st?.isDir) {
            await a.openFolder(p)
            break
          }
          if (st) await a.openFile(p)
        }
      }}
    >
      <div className="backdrop" />
      <TitleBar />
      <div className="main">
        <ActivityBar />
        {sidebar && (
          <>
            <div className="sidebar-wrap" style={{ width: sidebarWidth }}>
              <Sidebar />
            </div>
            <Resizer
              axis="x"
              value={sidebarWidth}
              min={180}
              max={640}
              onChange={(v, done) => {
                setSidebarWidth(v)
                if (done) a.updateSettings({ [widthKey]: v })
              }}
            />
          </>
        )}
        <div className="workbench">
          <EditorArea />
          {panelMounted && (
            <div style={{ display: panelOpen ? 'contents' : 'none' }}>
              <Resizer
                axis="y"
                value={panelHeight}
                min={100}
                max={900}
                invert
                onChange={(v, done) => {
                  setPanelHeight(v)
                  if (done) a.updateSettings({ panelHeight: v })
                }}
              />
              <div className="panel-wrap" style={{ height: panelHeight }}>
                <Panel />
              </div>
            </div>
          )}
        </div>
      </div>
      <StatusBar />
      <CommandPalette />
      <Toasts />
      {dragOver && <div className="drop-overlay">Отпустите, чтобы открыть</div>}
    </div>
  )
}
