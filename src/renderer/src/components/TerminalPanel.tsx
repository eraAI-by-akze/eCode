import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import * as a from '../actions'
import { basename } from '../lib/path'
import { IconClose, IconRefresh, IconTrash } from './Icons'

const api = window.ecode
const MAX_CHARS = 400_000
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g
// eslint-disable-next-line no-control-regex
const MARKER = /\x1eCWD:([^\x1f]*)\x1f\r?\n?/g

interface Session {
  id: number
  cwd: string
}

export function TerminalPanel() {
  const root = useStore((s) => s.root)
  const [session, setSession] = useState<Session | null>(null)
  const [output, setOutput] = useState('')
  const [running, setRunning] = useState(false)
  const [input, setInput] = useState('')
  const history = useRef<string[]>([])
  const historyPos = useRef(-1)
  const outRef = useRef<HTMLPreElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const sessionRef = useRef<Session | null>(null)

  const start = async (cwd: string | null): Promise<void> => {
    if (sessionRef.current) api.termKill(sessionRef.current.id)
    const s = await api.termCreate(cwd)
    sessionRef.current = { id: s.id, cwd: s.cwd }
    setSession(sessionRef.current)
    setRunning(false)
    setOutput((o) => o + `⁣── ${basename(s.shell)} · ${s.cwd}\n`)
  }

  useEffect(() => {
    const offData = api.onTermData((id, data) => {
      if (id !== sessionRef.current?.id) return
      let text = data.replace(ANSI, '')
      text = text.replace(MARKER, (_m, cwd: string) => {
        sessionRef.current = { id, cwd }
        setSession({ id, cwd })
        setRunning(false)
        return ''
      })
      if (text) setOutput((o) => (o + text).slice(-MAX_CHARS))
    })
    const offExit = api.onTermExit((id, code) => {
      if (id !== sessionRef.current?.id) return
      setOutput((o) => o + `\n[процесс завершён с кодом ${code ?? '—'}]\n`)
      sessionRef.current = null
      setSession(null)
      setRunning(false)
    })
    start(root)
    inputRef.current?.focus()
    return () => {
      offData()
      offExit()
      if (sessionRef.current) api.termKill(sessionRef.current.id)
      sessionRef.current = null
    }
    // Restart only when the workspace changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])

  useEffect(() => {
    const el = outRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [output])

  const run = async (): Promise<void> => {
    const cmd = input
    setInput('')
    historyPos.current = -1
    if (cmd.trim()) history.current = [cmd, ...history.current.filter((h) => h !== cmd)].slice(0, 100)
    if (cmd.trim() === 'clear' || cmd.trim() === 'cls') {
      setOutput('')
      return
    }
    let s = sessionRef.current
    if (!s) {
      await start(root)
      s = sessionRef.current
    }
    if (!s) return
    setOutput((o) => o + `⁣❯ ${cmd}\n`)
    setRunning(true)
    api.termWrite(s.id, cmd)
  }

  const interrupt = (): void => {
    setOutput((o) => o + '^C\n')
    start(sessionRef.current?.cwd ?? root)
  }

  // Lines starting with U+2063 are UI echoes (prompts, banners); style them separately.
  const lines = output.split('\n')

  return (
    <section className="panel glass" onClick={() => window.getSelection()?.isCollapsed && inputRef.current?.focus()}>
      <div className="panel-header">
        <span className="panel-tab active">Терминал</span>
        <span className="panel-cwd">{session ? session.cwd : ''}</span>
        <div className="header-actions">
          <button title="Очистить" onClick={() => setOutput('')}>
            <IconTrash size={14} />
          </button>
          <button title="Перезапустить" onClick={() => start(root)}>
            <IconRefresh size={14} />
          </button>
          <button title="Закрыть" onClick={() => a.togglePanel()}>
            <IconClose size={14} />
          </button>
        </div>
      </div>
      <pre className="term-output" ref={outRef}>
        {lines.map((l, i) =>
          l.startsWith('⁣') ? (
            <div key={i} className={l.startsWith('⁣❯') ? 'term-cmd' : 'term-banner'}>
              {l.slice(1)}
            </div>
          ) : (
            <div key={i}>{l || '​'}</div>
          )
        )}
      </pre>
      <div className="term-input-row">
        <span className={`term-prompt ${running ? 'running' : ''}`}>{session ? basename(session.cwd) || '/' : '…'} ❯</span>
        <input
          ref={inputRef}
          value={input}
          spellCheck={false}
          placeholder={running ? 'выполняется… (Ctrl+C — прервать)' : 'введите команду'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') run()
            else if (e.key === 'c' && e.ctrlKey && !window.getSelection()?.toString()) {
              e.preventDefault()
              if (running) interrupt()
              else {
                setOutput((o) => o + `\u2063❯ ${input}^C\n`)
                setInput('')
              }
            } else if (e.key === 'l' && e.ctrlKey) {
              e.preventDefault()
              setOutput('')
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              const next = Math.min(history.current.length - 1, historyPos.current + 1)
              if (next >= 0) {
                historyPos.current = next
                setInput(history.current[next])
              }
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              const next = historyPos.current - 1
              historyPos.current = Math.max(-1, next)
              setInput(next >= 0 ? history.current[next] : '')
            }
          }}
        />
      </div>
    </section>
  )
}
