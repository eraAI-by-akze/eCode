import { useEffect, useMemo, useRef } from 'react'
import { useStore, setState, mergeDiagnostics, type Diagnostic } from '../store'
import * as tasks from '../taskService'
import * as a from '../actions'
import * as term from '../terminalService'
import { basename, relative } from '../lib/path'
import { FileIcon, IconChevron, IconClose, IconError, IconHammer, IconInfo, IconPlus, IconStop, IconTrash, IconWarning } from './Icons'

function TerminalView() {
  const terminals = useStore((s) => s.terminals)
  const active = useStore((s) => s.activeTerminal)
  const panelOpen = useStore((s) => s.panelOpen)
  const slotRef = useRef<HTMLDivElement>(null)

  // First time the panel shows the terminal tab, start a shell.
  useEffect(() => {
    if (panelOpen && terminals.length === 0) void term.createTerminal()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen])

  useEffect(() => {
    if (slotRef.current && active !== null) term.attachTerminal(active, slotRef.current)
  }, [active])

  useEffect(() => {
    const el = slotRef.current
    if (!el) return
    let frame = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => term.fitTerminal(useStore.getState().activeTerminal))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="terminal-view">
      <div className="term-slot" ref={slotRef} />
      {terminals.length === 0 && (
        <div className="panel-empty">
          <button className="btn-primary" onClick={() => term.createTerminal()}>
            Новый терминал
          </button>
        </div>
      )}
    </div>
  )
}

const SEVERITY_ORDER: Record<Diagnostic['severity'], number> = { error: 0, warning: 1, info: 2, hint: 3 }

function SeverityIcon({ severity }: { severity: Diagnostic['severity'] }) {
  if (severity === 'error') return <IconError size={14} className="sev sev-error" />
  if (severity === 'warning') return <IconWarning size={14} className="sev sev-warning" />
  return <IconInfo size={14} className="sev sev-info" />
}

/** LSP and task diagnostics together; memoised on both inputs. */
export function useAllDiagnostics(): Record<string, Diagnostic[]> {
  const lsp = useStore((s) => s.diagnostics)
  const task = useStore((s) => s.taskDiagnostics)
  return useMemo(() => mergeDiagnostics(lsp, task), [lsp, task])
}

const PROBLEM_LINE = /(error|warning)/i

function OutputView() {
  const output = useStore((s) => s.taskOutput)
  const task = useStore((s) => s.task)
  const last = useStore((s) => s.lastTask)
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [output])
  if (!output) {
    return (
      <div className="panel-empty muted">
        Здесь появится вывод сборки и проверок. Ctrl+Shift+B — собрать проект, или выберите задачу в палитре: «Задачи».
      </div>
    )
  }
  const lines = output.split('\n')
  return (
    <div className="output-view">
      <div className="output-status">
        {task ? (
          <>
            <span className="spinner tiny" />
            <span>{task.label}…</span>
            <button className="btn-ghost small" onClick={() => tasks.stopTask()}>
              <IconStop size={11} /> Стоп
            </button>
          </>
        ) : last ? (
          <span className={last.code === 0 ? 'ok' : 'fail'}>
            {last.code === 0 ? '✓' : '✗'} {last.label}: ошибок {last.errors}, предупреждений {last.warnings} ·{' '}
            {(last.ms / 1000).toFixed(1)} с
          </span>
        ) : null}
      </div>
      <pre className="output-log" ref={ref}>
        {lines.map((l, i) => {
          const kind = /\berror\b|^✗/i.test(l) ? 'err' : /\bwarning\b/i.test(l) ? 'warn' : /^✓/.test(l) ? 'ok' : ''
          return (
            <div
              key={i}
              className={`output-line ${kind} ${kind && PROBLEM_LINE.test(l) ? 'link' : ''}`}
              onClick={() => kind && tasks.openProblemLine(l)}
            >
              {l || '\u200b'}
            </div>
          )
        })}
      </pre>
    </div>
  )
}

function ProblemsView() {
  const diagnostics = useAllDiagnostics()
  const root = useStore((s) => s.root)
  const files = useMemo(
    () =>
      Object.entries(diagnostics)
        .map(([path, list]) => ({
          path,
          list: list.filter((d) => d.severity !== 'hint').sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity] || x.line - y.line)
        }))
        .filter((f) => f.list.length)
        .sort((x, y) => x.path.localeCompare(y.path)),
    [diagnostics]
  )
  if (!files.length) return <div className="panel-empty muted">Проблем в открытых файлах не обнаружено.</div>
  return (
    <div className="problems">
      {files.map((f) => (
        <div key={f.path}>
          <div className="problem-file">
            <IconChevron size={12} className="chev open" />
            <FileIcon name={basename(f.path)} size={14} />
            <span className="problem-file-name">{basename(f.path)}</span>
            <span className="problem-file-dir">{relative(root, f.path)}</span>
            <span className="badge">{f.list.length}</span>
          </div>
          {f.list.map((d, i) => (
            <div
              key={i}
              className="problem"
              onClick={() => a.openFile(f.path, { line: d.line, column: d.column })}
              title={d.message}
            >
              <SeverityIcon severity={d.severity} />
              <span className="problem-msg">{d.message}</span>
              <span className="problem-src">
                {d.source}
                {d.code ? `(${d.code})` : ''}
              </span>
              <span className="problem-pos">
                [{d.line}, {d.column}]
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

export function Panel() {
  const tab = useStore((s) => s.panelTab)
  const terminals = useStore((s) => s.terminals)
  const activeTerminal = useStore((s) => s.activeTerminal)
  const all = useAllDiagnostics()
  const problemCount = Object.values(all).reduce((n, l) => n + l.filter((d) => d.severity === 'error' || d.severity === 'warning').length, 0)
  const running = useStore((s) => !!s.task)

  return (
    <section className="panel glass">
      <div className="panel-header">
        <button className={`panel-tab ${tab === 'terminal' ? 'active' : ''}`} onClick={() => setState({ panelTab: 'terminal' })}>
          Терминал
        </button>
        <button className={`panel-tab ${tab === 'problems' ? 'active' : ''}`} onClick={() => setState({ panelTab: 'problems' })}>
          Проблемы {problemCount > 0 && <span className="badge bump" key={problemCount}>{problemCount}</span>}
        </button>
        <button className={`panel-tab ${tab === 'output' ? 'active' : ''}`} onClick={() => setState({ panelTab: 'output' })}>
          Вывод {running && <span className="spinner tiny" />}
        </button>
        <button className="panel-action" title="Собрать (Ctrl+Shift+B)" onClick={() => void tasks.runGroup('build')}>
          <IconHammer size={13} />
        </button>
        <div className="panel-spacer" />
        {tab === 'terminal' && (
          <>
            <div className="term-tabs">
              {terminals.map((t) => (
                <div
                  key={t.id}
                  className={`term-tab ${t.id === activeTerminal ? 'active' : ''}`}
                  onClick={() => setState({ activeTerminal: t.id })}
                  title={t.title}
                >
                  <span>{t.title}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      term.closeTerminal(t.id)
                    }}
                    aria-label="Закрыть терминал"
                  >
                    <IconClose size={11} />
                  </button>
                </div>
              ))}
            </div>
            <div className="header-actions">
              <button title="Новый терминал (Ctrl+Shift+`)" onClick={() => term.createTerminal()}>
                <IconPlus size={14} />
              </button>
              <button title="Очистить" onClick={() => term.clearTerminal(activeTerminal)}>
                <IconTrash size={14} />
              </button>
            </div>
          </>
        )}
        <div className="header-actions">
          <button title="Скрыть панель" onClick={() => a.togglePanel()}>
            <IconClose size={14} />
          </button>
        </div>
      </div>
      <div className="panel-body">
        <div style={{ display: tab === 'terminal' ? 'contents' : 'none' }}>
          <TerminalView />
        </div>
        {tab === 'problems' && <ProblemsView />}
        {tab === 'output' && <OutputView />}
      </div>
    </section>
  )
}
