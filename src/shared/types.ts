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

export interface TermInfo {
  id: number
  cwd: string
  shell: string
  /** false when node-pty is unavailable and a plain pipe shell is used. */
  pty: boolean
}

export type LspServerId = 'typescript' | 'python'

export interface GitFile {
  /** Absolute path. */
  path: string
  /** Path relative to the repository root, forward slashes. */
  rel: string
  /** Index status (porcelain X). */
  x: string
  /** Working tree status (porcelain Y). */
  y: string
  orig?: string
}

export interface GitStatus {
  repoRoot: string
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  hasHead: boolean
  files: GitFile[]
}

export interface GitBranches {
  current: string | null
  local: string[]
  remote: string[]
}

export type GitSyncOp = 'push' | 'pull' | 'fetch'

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
  getPathForFile(file: File): string
  // terminal
  termCreate(cwd: string | null, cols: number, rows: number): Promise<TermInfo>
  termWrite(id: number, data: string): void
  termResize(id: number, cols: number, rows: number): void
  termKill(id: number): void
  onTermData(cb: (id: number, data: string) => void): () => void
  onTermExit(cb: (id: number, code: number | null) => void): () => void
  // language servers
  lspStart(server: LspServerId, root: string): Promise<{ capabilities: Record<string, unknown> }>
  lspRequest(server: LspServerId, method: string, params: unknown): Promise<unknown>
  lspNotify(server: LspServerId, method: string, params: unknown): void
  lspStopAll(): Promise<void>
  onLspNotification(cb: (server: LspServerId, method: string, params: unknown) => void): () => void
  onLspExit(cb: (server: LspServerId, code: number | null) => void): () => void
  // git
  gitStatus(root: string): Promise<GitStatus | null>
  gitInit(root: string): Promise<void>
  gitStage(repo: string, paths: string[]): Promise<void>
  gitUnstage(repo: string, paths: string[]): Promise<void>
  gitDiscard(repo: string, tracked: string[], untracked: string[]): Promise<void>
  gitCommit(repo: string, message: string, all: boolean): Promise<void>
  gitDiffContents(repo: string, path: string, staged: boolean): Promise<{ original: string; modified: string }>
  gitBranches(repo: string): Promise<GitBranches>
  gitCheckout(repo: string, ref: string, create: boolean): Promise<void>
  gitSync(repo: string, op: GitSyncOp): Promise<string>
  // settings
  loadSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): void
}
