import { create } from 'zustand'
import { DEFAULT_SETTINGS, type DirEntry, type GitStatus, type LspServerId, type PluginEntry, type Settings } from '@shared/types'

export type SidebarView = 'explorer' | 'search' | 'scm' | 'debug' | 'ai' | 'plugins' | 'extensions' | 'settings'

export interface Tab {
  path: string
  name: string
  dirty: boolean
  /** Set for git diff tabs; `path` is then a virtual "diff:…" key. */
  diff?: { file: string; staged: boolean }
}

export interface TerminalTab {
  id: number
  title: string
  pty: boolean
}

export interface Diagnostic {
  line: number
  column: number
  endLine: number
  endColumn: number
  message: string
  severity: 'error' | 'warning' | 'info' | 'hint'
  source?: string
  code?: string
}

export interface LspStatus {
  state: 'starting' | 'ready' | 'error'
  message?: string
}

export type AiToolStatus = 'running' | 'pending' | 'applied' | 'rejected' | 'done' | 'error'

export interface AiToolCard {
  callId: string
  name: string
  args: Record<string, unknown>
  status: AiToolStatus
  /** One line for the card header, e.g. "Прочитан src/app.py (1–40)". */
  summary: string
  /** For edits: the lines being replaced and their replacement. */
  preview?: { path: string; startLine: number; oldLines: string[]; newLines: string[]; isNew: boolean }
  result?: string
}

export type AiPart = { kind: 'text'; text: string } | { kind: 'tool'; card: AiToolCard }

export interface AiMessage {
  id: string
  role: 'user' | 'assistant'
  parts: AiPart[]
  error?: string
}

export interface AiStatus {
  state: 'idle' | 'starting' | 'loading' | 'ready' | 'missing' | 'error'
  message?: string
  eracore?: string
  python?: string
  pythonPath?: string
}

export interface TaskRunState {
  /** Backend process id. */
  pid: number
  taskId: string
  label: string
  command: string
  cwd: string
  startedAt: number
}

export interface TaskResult {
  taskId: string
  label: string
  code: number | null
  errors: number
  warnings: number
  ms: number
}

export interface Breakpoint {
  id: string
  path: string
  line: number
  enabled: boolean
  condition?: string
  /** Log message instead of stopping (logpoint). */
  logMessage?: string
  /** From the adapter while a session runs; undefined = not sent yet. */
  verified?: boolean
  message?: string
}

export interface DebugFrame {
  id: number
  name: string
  path?: string
  line: number
  column: number
}

export interface DebugThread {
  id: number
  name: string
}

export interface DebugSessionState {
  status: 'starting' | 'running' | 'paused' | 'stopping'
  name: string
  type: string
  threads: DebugThread[]
  threadId?: number
  frames: DebugFrame[]
  frameId?: number
  stopReason?: string
  /** Exception text when stopped on one. */
  exception?: string
  /** Bumped on every stop so variable views refetch. */
  stopSeq: number
}

export interface ConsoleLine {
  id: number
  kind: 'stdout' | 'stderr' | 'console' | 'input' | 'result' | 'error' | 'info'
  text: string
  /** For expandable REPL results. */
  ref?: number
}

export interface InstalledExtension {
  /** publisher.name, lower case. */
  id: string
  name: string
  displayName: string
  publisher: string
  version: string
  description: string
  dir: string
  /** Absolute path of the extension's icon (PNG/SVG). */
  icon?: string
  enabled: boolean
  /** What eCode uses from it, e.g. ["Тема", "Синтаксис"]. */
  features: string[]
  /** It ships JavaScript (activation code) that eCode doesn't run. */
  hasCode: boolean
  /** Nothing in it works in eCode. */
  unsupported: boolean
  error?: string
}

export interface IconThemeInfo {
  id: string
  label: string
  path: string
  extension: string
}

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'error' | 'success'
}

export interface PickItem {
  id: string
  label: string
  detail?: string
  hint?: string
  active?: boolean
}

export type PaletteState =
  | null
  | { kind: 'quick'; value: string }
  | { kind: 'pick'; placeholder: string; items: PickItem[]; onPick: (id: string) => void }
  | { kind: 'input'; placeholder: string; prompt: string; onSubmit: (value: string) => void }

export type InlineEdit =
  | null
  | { kind: 'newFile' | 'newFolder'; dir: string }
  | { kind: 'rename'; path: string }

export interface State {
  ready: boolean
  settings: Settings
  root: string | null
  tree: Record<string, DirEntry[]>
  expanded: Record<string, boolean>
  selected: string | null
  inlineEdit: InlineEdit
  tabs: Tab[]
  active: string | null
  sidebar: SidebarView | null
  lastSidebar: SidebarView
  panelOpen: boolean
  panelTab: 'terminal' | 'problems' | 'output' | 'debug'
  terminals: TerminalTab[]
  activeTerminal: number | null
  /** From language servers. */
  diagnostics: Record<string, Diagnostic[]>
  /** From build/check tasks (compiler output). */
  taskDiagnostics: Record<string, Diagnostic[]>
  plugins: PluginEntry[]
  extensions: InstalledExtension[]
  /** Debuggers / language servers that extensions bring, as pseudo-plugins. */
  extPlugins: PluginEntry[]
  iconThemes: IconThemeInfo[]
  /** Bumped when extension themes change, so theme lists re-render. */
  themesVersion: number
  /** Resolved paths of CLI tools plugins need (null = not found). */
  tools: Record<string, string | null>
  task: TaskRunState | null
  lastTask: TaskResult | null
  taskOutput: string
  /** Font family picked by "auto" (a Nerd Font when one is installed). */
  autoFont: string | null
  /** Folder whose children should animate in (just expanded). */
  expandPulse: { dir: string; at: number } | null
  lsp: Partial<Record<LspServerId, LspStatus>>
  git: GitStatus | null
  gitBusy: string | null
  commitMessage: string
  ai: AiStatus
  aiMessages: AiMessage[]
  aiBusy: string | null
  aiDraft: string
  palette: PaletteState
  cursor: { line: number; column: number; selected: number }
  language: string
  eol: 'LF' | 'CRLF'
  toasts: Toast[]
  fileIndex: string[] | null
  maximized: boolean
  breakpoints: Breakpoint[]
  debug: DebugSessionState | null
  debugConsole: ConsoleLine[]
  watches: string[]
  /** Id of the chosen launch configuration in the Run & Debug view. */
  debugConfig: string | null
}

export const useStore = create<State>(() => ({
  ready: false,
  settings: DEFAULT_SETTINGS,
  root: null,
  tree: {},
  expanded: {},
  selected: null,
  inlineEdit: null,
  tabs: [],
  active: null,
  sidebar: 'explorer',
  lastSidebar: 'explorer',
  panelOpen: false,
  panelTab: 'terminal',
  terminals: [],
  activeTerminal: null,
  diagnostics: {},
  taskDiagnostics: {},
  plugins: [],
  extensions: [],
  extPlugins: [],
  iconThemes: [],
  themesVersion: 0,
  tools: {},
  task: null,
  lastTask: null,
  taskOutput: '',
  autoFont: null,
  expandPulse: null,
  lsp: {},
  git: null,
  gitBusy: null,
  commitMessage: '',
  ai: { state: 'idle' },
  aiMessages: [],
  aiBusy: null,
  aiDraft: '',
  palette: null,
  cursor: { line: 1, column: 1, selected: 0 },
  language: 'plaintext',
  eol: 'LF',
  toasts: [],
  fileIndex: null,
  maximized: false,
  breakpoints: [],
  debug: null,
  debugConsole: [],
  watches: [],
  debugConfig: null
}))

export const getState = useStore.getState
export const setState = useStore.setState

/** LSP + task diagnostics for one view (Problems panel, explorer, status bar). */
export function mergeDiagnostics(a: Record<string, Diagnostic[]>, b: Record<string, Diagnostic[]>): Record<string, Diagnostic[]> {
  if (!Object.keys(b).length) return a
  if (!Object.keys(a).length) return b
  const out: Record<string, Diagnostic[]> = { ...a }
  for (const [path, list] of Object.entries(b)) {
    const live = out[path]
    if (!live) {
      out[path] = list
      continue
    }
    // A compiler error the language server already reports (same spot, same code) shows once.
    const key = (d: Diagnostic): string => `${d.line}:${d.column}:${d.severity}:${d.code ?? d.message}`
    const seen = new Set(live.map(key))
    out[path] = [...live, ...list.filter((d) => !seen.has(key(d)))]
  }
  return out
}
