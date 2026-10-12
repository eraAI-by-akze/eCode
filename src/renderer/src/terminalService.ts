import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { getState, setState, useStore } from './store'
import { THEMES } from './themes'
import { basename } from './lib/path'
import { fontStack } from './fontService'

const api = window.ecode
const isMac = api.platform === 'darwin'
const isWin = api.platform === 'win32'

interface Session {
  id: number
  term: Terminal
  fit: FitAddon
  el: HTMLDivElement
  opened: boolean
  pty: boolean
  /** Line being typed, only used by the pipe fallback which has no echo. */
  line: string
}

const sessions = new Map<number, Session>()
let listening = false

function theme(): ITheme {
  const t = THEMES[getState().settings.theme]
  return { ...t.terminal, background: '#00000000', cursorAccent: t.vars['--bg'] }
}

function fontSize(): number {
  return Math.max(11, getState().settings.fontSize - 1)
}

function listen(): void {
  if (listening) return
  listening = true
  api.onTermData((id, data) => sessions.get(id)?.term.write(data))
  api.onTermExit((id) => closeTerminal(id, false))
  // Follow theme and font changes.
  let prev = getState().settings
  let prevAuto = getState().autoFont
  useStore.subscribe((s) => {
    if (
      s.settings.theme === prev.theme &&
      s.settings.fontSize === prev.fontSize &&
      s.settings.editorFont === prev.editorFont &&
      s.autoFont === prevAuto
    )
      return
    prev = s.settings
    prevAuto = s.autoFont
    for (const sess of sessions.values()) {
      sess.term.options.theme = theme()
      sess.term.options.fontSize = fontSize()
      sess.term.options.fontFamily = fontStack()
      fitSession(sess)
    }
  })
}

function fitSession(s: Session): void {
  if (!s.opened || !s.el.isConnected || s.el.clientWidth === 0) return
  try {
    s.fit.fit()
  } catch {
    // Not laid out yet.
  }
}

/** Pipe fallback: do the line editing a PTY would normally do. */
function fallbackInput(s: Session, data: string): void {
  for (const ch of data) {
    if (ch === '\r') {
      s.term.write('\r\n')
      api.termWrite(s.id, s.line + (isWin ? '\r\n' : '\n'))
      s.line = ''
    } else if (ch === '\x7f' || ch === '\b') {
      if (s.line) {
        s.line = s.line.slice(0, -1)
        s.term.write('\b \b')
      }
    } else if (ch === '\x03') {
      s.term.write('^C\r\n')
      s.line = ''
      api.termWrite(s.id, '\x03')
    } else if (ch >= ' ') {
      s.line += ch
      s.term.write(ch)
    }
  }
}

export async function createTerminal(): Promise<number> {
  listen()
  const term = new Terminal({
    fontFamily: fontStack(),
    fontSize: fontSize(),
    lineHeight: 1.25,
    cursorBlink: true,
    cursorStyle: 'bar',
    allowTransparency: true,
    scrollback: 10000,
    macOptionIsMeta: true,
    theme: theme()
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_e, uri) => api.openExternal(uri)))

  const el = document.createElement('div')
  el.className = 'xterm-host'
  const info = await api.termCreate(getState().root, 80, 24)
  const session: Session = { id: info.id, term, fit, el, opened: false, pty: info.pty, line: '' }
  sessions.set(info.id, session)

  term.onData((d) => (session.pty ? api.termWrite(info.id, d) : fallbackInput(session, d)))
  term.onResize(({ cols, rows }) => api.termResize(info.id, cols, rows))
  term.onTitleChange((raw) => {
    // Shells usually report "user@host: /long/path"; the folder name is what matters.
    const title = /^[^:]+:\s*(\S.*)$/.test(raw) ? basename(raw.slice(raw.indexOf(':') + 1).trim()) || raw : raw
    if (!title) return
    setState((st) => ({ terminals: st.terminals.map((t) => (t.id === info.id ? { ...t, title } : t)) }))
  })
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    const mod = isMac ? e.metaKey : e.ctrlKey
    // Copy / paste: Ctrl+Shift+C/V everywhere, plain Ctrl+C/V on Windows when it makes sense.
    if ((mod && e.shiftKey && e.code === 'KeyC') || (isWin && e.ctrlKey && e.code === 'KeyC' && term.hasSelection())) {
      navigator.clipboard.writeText(term.getSelection())
      return false
    }
    if ((mod && e.shiftKey && e.code === 'KeyV') || (isWin && e.ctrlKey && !e.shiftKey && e.code === 'KeyV')) {
      navigator.clipboard.readText().then((t) => term.paste(t))
      return false
    }
    return true
  })

  const n = getState().terminals.length + 1
  setState((st) => ({
    terminals: [...st.terminals, { id: info.id, title: `${basename(info.shell).replace(/\.exe$/i, '')} ${n}`, pty: info.pty }],
    activeTerminal: info.id
  }))
  if (!info.pty) term.write('\x1b[2m(упрощённый режим: node-pty недоступен)\x1b[0m\r\n')
  return info.id
}

/** Put a session's element into the visible slot (opening xterm on first use). */
export function attachTerminal(id: number, slot: HTMLElement): void {
  const s = sessions.get(id)
  if (!s) return
  if (s.el.parentElement !== slot) {
    slot.replaceChildren(s.el)
  }
  if (!s.opened) {
    s.term.open(s.el)
    s.opened = true
  }
  requestAnimationFrame(() => {
    fitSession(s)
    s.term.focus()
  })
}

export function fitTerminal(id: number | null): void {
  const s = id !== null ? sessions.get(id) : undefined
  if (s) fitSession(s)
}

export function focusTerminal(id: number | null): void {
  if (id !== null) sessions.get(id)?.term.focus()
}

export function clearTerminal(id: number | null): void {
  if (id !== null) sessions.get(id)?.term.clear()
}

export function closeTerminal(id: number, kill = true): void {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  if (kill) api.termKill(id)
  s.term.dispose()
  s.el.remove()
  setState((st) => {
    const terminals = st.terminals.filter((t) => t.id !== id)
    const activeTerminal =
      st.activeTerminal === id ? (terminals[terminals.length - 1]?.id ?? null) : st.activeTerminal
    return { terminals, activeTerminal }
  })
}

/** Run a command in the active terminal (creating one if needed). */
export async function runInTerminal(command: string): Promise<void> {
  let id = getState().activeTerminal
  if (id === null) id = await createTerminal()
  setState({ panelOpen: true, panelTab: 'terminal', activeTerminal: id })
  // A PTY expects Enter as CR; the pipe fallback needs a real newline.
  api.termWrite(id, command + (sessions.get(id)?.pty ? '\r' : isWin ? '\r\n' : '\n'))
}
