import { create } from 'zustand'
import { DEFAULT_SETTINGS, type DirEntry, type GitStatus, type LspServerId, type Settings } from '@shared/types'

export type SidebarView = 'explorer' | 'search' | 'scm' | 'settings'

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
  panelTab: 'terminal' | 'problems'
  terminals: TerminalTab[]
  activeTerminal: number | null
  diagnostics: Record<string, Diagnostic[]>
  lsp: Partial<Record<LspServerId, LspStatus>>
  git: GitStatus | null
  gitBusy: string | null
  commitMessage: string
  palette: PaletteState
  cursor: { line: number; column: number; selected: number }
  language: string
  eol: 'LF' | 'CRLF'
  toasts: Toast[]
  fileIndex: string[] | null
  maximized: boolean
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
  lsp: {},
  git: null,
  gitBusy: null,
  commitMessage: '',
  palette: null,
  cursor: { line: 1, column: 1, selected: 0 },
  language: 'plaintext',
  eol: 'LF',
  toasts: [],
  fileIndex: null,
  maximized: false
}))

export const getState = useStore.getState
export const setState = useStore.setState
