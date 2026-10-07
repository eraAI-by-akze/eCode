import { create } from 'zustand'
import { DEFAULT_SETTINGS, type DirEntry, type Settings } from '@shared/types'

export type SidebarView = 'explorer' | 'search' | 'settings'

export interface Tab {
  path: string
  name: string
  dirty: boolean
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
  palette: PaletteState
  cursor: { line: number; column: number; selected: number }
  language: string
  eol: 'LF' | 'CRLF'
  branch: string | null
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
  palette: null,
  cursor: { line: 1, column: 1, selected: 0 },
  language: 'plaintext',
  eol: 'LF',
  branch: null,
  toasts: [],
  fileIndex: null,
  maximized: false
}))

export const getState = useStore.getState
export const setState = useStore.setState
