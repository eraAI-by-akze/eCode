import { useEffect, useState, type ReactNode } from 'react'
import { useStore, type Breakpoint } from '../store'
import * as dbg from '../debugService'
import * as a from '../actions'
import { formatKeys } from '../commands'
import { basename, relative } from '../lib/path'
import { IconChevron, IconClose, IconDebugStart, IconPlus, IconTrash, FileIcon } from './Icons'

function Section({ title, actions, children, open: initial = true }: { title: string; actions?: ReactNode; children: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(initial)
  return (
    <div className={`dbg-section ${open ? 'open' : ''}`}>
      <div className="dbg-section-header" onClick={() => setOpen(!open)}>
        <IconChevron size={12} className={`chev ${open ? 'open' : ''}`} />
        <span>{title}</span>
        <div className="header-actions" onClick={(e) => e.stopPropagation()}>
          {actions}
        </div>
      </div>
      {open && <div className="dbg-section-body">{children}</div>}
    </div>
  )
}

/** One variable; children load when expanded. */
function VarNode({ v, depth, seq }: { v: dbg.DebugVariable; depth: number; seq: string }) {
  const [open, setOpen] = useState(false)
  const [kids, setKids] = useState<dbg.DebugVariable[] | null>(null)
  useEffect(() => {
    setKids(null)
    if (open && v.ref) void dbg.variables(v.ref).then(setKids, () => setKids([]))
  }, [open, v.ref, seq])
  const kind = /^['"]/.test(v.value) ? 'str' : /^-?\d/.test(v.value) ? 'num' : /^(true|false|True|False|None|null)$/.test(v.value) ? 'kw' : ''
  return (
    <>
      <div className="dbg-var" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => v.ref && setOpen(!open)} title={v.type ? `${v.name}: ${v.type}` : v.name}>
        {v.ref ? <IconChevron size={11} className={`chev ${open ? 'open' : ''}`} /> : <span className="chev-spacer" />}
        <span className="dbg-var-name">{v.name}</span>
        <span className="dbg-var-sep">=</span>
        <span className={`dbg-var-value ${kind}`}>{v.value}</span>
      </div>
      {open && kids?.map((k, i) => <VarNode key={`${k.name}-${i}`} v={k} depth={depth + 1} seq={seq} />)}
      {open && v.ref > 0 && !kids && <div className="dbg-hint" style={{ paddingLeft: 26 + depth * 12 }}>…</div>}
    </>
  )
}

function Variables() {
  const debug = useStore((s) => s.debug)
  const [scopes, setScopes] = useState<{ name: string; ref: number; expensive: boolean }[]>([])
  const seq = `${debug?.stopSeq}:${debug?.frameId}`
  useEffect(() => {
    if (debug?.status !== 'paused' || debug.frameId === undefined) {
      setScopes([])
      return
    }
    void dbg.scopes(debug.frameId).then(setScopes, () => setScopes([]))
  }, [seq, debug?.status])
  if (debug?.status !== 'paused') return <div className="dbg-hint">{debug ? 'Программа выполняется…' : 'Запустите отладку, чтобы увидеть переменные.'}</div>
  return (
    <>
      {scopes.map((s, i) => (
        <ScopeNode key={`${s.name}-${seq}`} scope={s} seq={seq} open={i === 0 && !s.expensive} />
      ))}
    </>
  )
}

function ScopeNode({ scope, seq, open: initial }: { scope: { name: string; ref: number }; seq: string; open: boolean }) {
  const [open, setOpen] = useState(initial)
  const [vars, setVars] = useState<dbg.DebugVariable[] | null>(null)
  useEffect(() => {
    if (open) void dbg.variables(scope.ref).then(setVars, () => setVars([]))
  }, [open, scope.ref, seq])
  return (
    <>
      <div className="dbg-scope" onClick={() => setOpen(!open)}>
        <IconChevron size={11} className={`chev ${open ? 'open' : ''}`} />
        {scope.name}
      </div>
      {open && vars?.map((v, i) => <VarNode key={`${v.name}-${i}`} v={v} depth={1} seq={seq} />)}
      {open && vars?.length === 0 && <div className="dbg-hint indent">пусто</div>}
    </>
  )
}

function Watches() {
  const watches = useStore((s) => s.watches)
  const debug = useStore((s) => s.debug)
  const [values, setValues] = useState<Record<string, dbg.DebugVariable | string>>({})
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const seq = `${debug?.stopSeq}:${debug?.frameId}:${debug?.status}`
  useEffect(() => {
    if (debug?.status !== 'paused') {
      setValues({})
      return
    }
    void Promise.all(
      watches.map(async (w) => [w, await dbg.evaluate(w, 'watch').catch((e: Error) => e.message)] as const)
    ).then((pairs) => setValues(Object.fromEntries(pairs)))
  }, [seq, watches])
  return (
    <Section
      title="Наблюдение"
      actions={
        <button title="Добавить выражение" onClick={() => setAdding(true)}>
          <IconPlus size={14} />
        </button>
      }
    >
      {watches.map((w, i) => {
        const v = values[w]
        return (
          <div className="dbg-watch" key={`${w}-${i}`}>
            {v && typeof v !== 'string' ? (
              <VarNode v={{ ...v, name: w }} depth={0} seq={seq} />
            ) : (
              <div className="dbg-var" style={{ paddingLeft: 8 }}>
                <span className="chev-spacer" />
                <span className="dbg-var-name">{w}</span>
                <span className="dbg-var-sep">=</span>
                <span className="dbg-var-value muted">{typeof v === 'string' ? v : debug?.status === 'paused' ? '…' : 'недоступно'}</span>
              </div>
            )}
            <button className="dbg-row-x" title="Удалить" onClick={() => dbg.removeWatch(i)}>
              <IconClose size={11} />
            </button>
          </div>
        )
      })}
      {adding && (
        <input
          className="dbg-input"
          autoFocus
          placeholder="Выражение, Enter"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setAdding(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              dbg.addWatch(draft)
              setDraft('')
              setAdding(false)
            } else if (e.key === 'Escape') setAdding(false)
          }}
        />
      )}
      {!watches.length && !adding && <div className="dbg-hint">Добавьте выражение кнопкой «+».</div>}
    </Section>
  )
}

function CallStack() {
  const debug = useStore((s) => s.debug)
  const root = useStore((s) => s.root)
  if (!debug || debug.status !== 'paused') return <div className="dbg-hint">{debug ? 'Выполняется' : 'Нет сеанса'}</div>
  const thread = debug.threads.find((t) => t.id === debug.threadId)
  return (
    <>
      {debug.threads.length > 1 && <div className="dbg-thread">{thread?.name ?? `Поток ${debug.threadId}`} · на паузе</div>}
      {debug.frames.map((f) => (
        <div
          key={f.id}
          className={`dbg-frame ${f.id === debug.frameId ? 'active' : ''} ${f.path ? '' : 'nosource'}`}
          onClick={() => dbg.selectFrame(f)}
          title={f.path}
        >
          <span className="dbg-frame-name">{f.name}</span>
          {f.path && (
            <span className="dbg-frame-loc">
              {root && f.path.startsWith(root) ? relative(root, f.path) : basename(f.path)}:{f.line}
            </span>
          )}
        </div>
      ))}
    </>
  )
}

function BreakpointRow({ b }: { b: Breakpoint }) {
  const debugging = useStore((s) => !!s.debug)
  return (
    <div className={`dbg-bp ${b.enabled ? '' : 'off'}`} onClick={() => void a.openFile(b.path, { line: b.line })} title={b.message ?? b.path}>
      <input
        type="checkbox"
        checked={b.enabled}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => dbg.setBreakpointEnabled(b.id, e.target.checked)}
      />
      <span className={`bp-dot ${b.logMessage ? 'log' : b.condition ? 'cond' : ''} ${debugging && b.verified === false ? 'unverified' : ''}`} />
      <FileIcon name={basename(b.path)} size={13} />
      <span className="dbg-bp-name">{basename(b.path)}</span>
      <span className="dbg-bp-line">{b.line}</span>
      {(b.condition || b.logMessage) && <span className="dbg-bp-extra">{b.logMessage ? `⟶ ${b.logMessage}` : b.condition}</span>}
      <button
        className="dbg-row-x"
        title="Удалить"
        onClick={(e) => {
          e.stopPropagation()
          dbg.removeBreakpoint(b.id)
        }}
      >
        <IconClose size={11} />
      </button>
    </div>
  )
}

function ConfigPicker() {
  const debug = useStore((s) => s.debug)
  const chosen = useStore((s) => s.debugConfig)
  const active = useStore((s) => s.active)
  const [configs, setConfigs] = useState<(dbg.LaunchConfig & { ok: boolean })[]>([])
  useEffect(() => {
    let alive = true
    void dbg.launchConfigs().then(async (list) => {
      const withState = await Promise.all(list.map(async (c) => ({ ...c, ok: await dbg.isAvailable(c) })))
      if (alive) setConfigs(withState)
    })
    return () => {
      alive = false
    }
  }, [active])
  const current = configs.find((c) => c.id === chosen) ?? configs.find((c) => c.ok) ?? configs[0]
  return (
    <div className="dbg-launch">
      <button
        className={`dbg-start ${debug ? 'running' : ''}`}
        disabled={!current}
        title={`Начать отладку (${formatKeys(['f6'])})`}
        onClick={() => void dbg.startDebugging(current?.id)}
      >
        <IconDebugStart size={15} />
      </button>
      <select
        className="dbg-config"
        value={current?.id ?? ''}
        onChange={(e) => useStore.setState({ debugConfig: e.target.value })}
        disabled={!configs.length}
      >
        {!configs.length && <option value="">Нет конфигураций</option>}
        {configs.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.ok ? '' : ' (не установлен)'}
          </option>
        ))}
      </select>
    </div>
  )
}

export function DebugView() {
  const breakpoints = useStore((s) => s.breakpoints)
  const debug = useStore((s) => s.debug)
  return (
    <div className="debug-view">
      <ConfigPicker />
      {debug && (
        <div className={`dbg-status ${debug.status}`}>
          <span className="dbg-status-dot" />
          {debug.status === 'paused'
            ? `Пауза: ${debug.stopReason === 'breakpoint' ? 'точка останова' : debug.stopReason === 'exception' ? 'исключение' : debug.stopReason === 'step' ? 'шаг' : debug.stopReason ?? ''}`
            : debug.status === 'running'
              ? 'Выполняется'
              : debug.status === 'starting'
                ? 'Запуск…'
                : 'Остановка…'}
          <span className="dbg-status-name">{debug.name}</span>
        </div>
      )}
      <Section title="Переменные">
        <Variables />
      </Section>
      <Watches />
      <Section title="Стек вызовов">
        <CallStack />
      </Section>
      <Section
        title="Точки останова"
        actions={
          breakpoints.length > 0 && (
            <button title="Удалить все" onClick={() => dbg.removeAllBreakpoints()}>
              <IconTrash size={14} />
            </button>
          )
        }
      >
        {breakpoints.map((b) => (
          <BreakpointRow key={b.id} b={b} />
        ))}
        {!breakpoints.length && <div className="dbg-hint">Щёлкните слева от номера строки или нажмите {formatKeys(['f9'])}.</div>}
      </Section>
    </div>
  )
}
