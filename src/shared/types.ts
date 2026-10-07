export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

export interface ReadFileResult {
  content?: string
  binary?: boolean
  tooLarge?: boolean
  error?: string
}

export interface SearchOptions {
  caseSensitive: boolean
  regex: boolean
  wholeWord: boolean
  include: string
}

export interface SearchMatch {
  line: number
  column: number
  length: number
  preview: string
  previewStart: number
}

export interface SearchFileResult {
  path: string
  matches: SearchMatch[]
}

export interface SearchResult {
  files: SearchFileResult[]
  total: number
  truncated: boolean
  error?: string
}

export type ThemeId = 'era-glass' | 'graphite' | 'aurora-light'

export interface Settings {
  theme: ThemeId
  fontSize: number
  tabSize: number
  wordWrap: boolean
  minimap: boolean
  fontLigatures: boolean
  sidebarWidth: number
  panelHeight: number
  lastFolder: string | null
  recent: string[]
  openFiles: string[]
  activeFile: string | null
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'era-glass',
  fontSize: 14,
  tabSize: 2,
  wordWrap: false,
  minimap: true,
  fontLigatures: true,
  sidebarWidth: 260,
  panelHeight: 240,
  lastFolder: null,
  recent: [],
  openFiles: [],
  activeFile: null
}

export interface ContextMenuItem {
  id?: string
  label?: string
  accelerator?: string
  type?: 'separator'
  enabled?: boolean
}

export interface EcodeApi {
  platform: NodeJS.Platform
  pathSep: string
  // window
  minimize(): void
  toggleMaximize(): void
  close(): void
  toggleDevTools(): void
  onMaximizedChange(cb: (maximized: boolean) => void): () => void
  setDirty(dirty: boolean): void
  // dialogs
  openFolderDialog(): Promise<string | null>
  openFileDialog(): Promise<string | null>
  saveFileDialog(defaultName: string): Promise<string | null>
  confirm(message: string, detail?: string, buttons?: string[]): Promise<number>
  contextMenu(items: ContextMenuItem[]): Promise<string | null>
  openExternal(url: string): void
  revealInFolder(path: string): void
  // fs
  readDir(dir: string): Promise<DirEntry[]>
  readFile(path: string): Promise<ReadFileResult>
  writeFile(path: string, content: string): Promise<void>
  stat(path: string): Promise<{ isDir: boolean } | null>
  createFile(dir: string, name: string): Promise<string>
  createDir(dir: string, name: string): Promise<string>
  rename(path: string, newName: string): Promise<string>
  remove(path: string): Promise<void>
  listFiles(root: string): Promise<string[]>
  search(root: string, query: string, opts: SearchOptions): Promise<SearchResult>
  watch(root: string | null): void
  onFsChange(cb: (paths: string[]) => void): () => void
  gitBranch(root: string): Promise<string | null>
  getPathForFile(file: File): string
  // terminal
  termCreate(cwd: string | null): Promise<{ id: number; cwd: string; shell: string }>
  termWrite(id: number, data: string): void
  termKill(id: number): void
  onTermData(cb: (id: number, data: string) => void): () => void
  onTermExit(cb: (id: number, code: number | null) => void): () => void
  // settings
  loadSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): void
}
