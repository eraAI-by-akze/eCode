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

export type EraBackend = 'ollama' | 'openai' | 'gguf' | 'mock'

export interface EraSettings {
  /** Empty: auto-detect python3/python/py. */
  pythonPath: string
  backend: EraBackend
  url: string
  model: string
  ggufPath: string
  apiKey: string
  temperature: number
  maxTokens: number
  /** Apply file edits without asking. */
  autoApply: boolean
}

export const DEFAULT_ERA: EraSettings = {
  pythonPath: '',
  backend: 'ollama',
  url: 'http://localhost:11434/v1',
  model: 'qwen2.5-coder:7b',
  ggufPath: '',
  apiKey: '',
  temperature: 0.2,
  maxTokens: 2048,
  autoApply: false
}

export interface PythonInfo {
  path: string
  version: string
  eracore: boolean
}

export interface EraHello {
  type: 'hello'
  eracore: string | null
  python: string
  error: string | null
  pythonPath?: string
}

/** Built-in ids, or `ext:<extension>/<theme>` for themes from VS Code extensions. */
export type ThemeId = string

export interface Settings {
  theme: ThemeId
  fontSize: number
  tabSize: number
  wordWrap: boolean
  minimap: boolean
  fontLigatures: boolean
  sidebarWidth: number
  /** The eraAI chat wants more room than the file tree. */
  aiPanelWidth: number
  panelHeight: number
  lastFolder: string | null
  recent: string[]
  openFiles: string[]
  activeFile: string | null
  era: EraSettings
  /** Editor + terminal font family; '' = auto (first Nerd Font found). */
  editorFont: string
  /** Show diagnostics inline at the end of the line. */
  errorLens: boolean
  animations: boolean
  disabledPlugins: string[]
  /** Extension ids (publisher.name) switched off. */
  disabledExtensions: string[]
  /** `<extension>/<icon theme id>`, or '' for eCode's own icons. */
  iconTheme: string
  /** Open VSX compatible registry (VSCodium's marketplace). */
  extensionGallery: string
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'era-glass',
  fontSize: 14,
  tabSize: 2,
  wordWrap: false,
  minimap: true,
  fontLigatures: true,
  sidebarWidth: 260,
  aiPanelWidth: 380,
  panelHeight: 240,
  lastFolder: null,
  recent: [],
  openFiles: [],
  activeFile: null,
  era: DEFAULT_ERA,
  editorFont: '',
  errorLens: true,
  animations: true,
  disabledPlugins: [],
  disabledExtensions: [],
  iconTheme: '',
  extensionGallery: 'https://open-vsx.org'
}

export interface TermInfo {
  id: number
  cwd: string
  shell: string
  /** false when node-pty is unavailable and a plain pipe shell is used. */
  pty: boolean
}

/** Built-in ids ('typescript', 'python') or a plugin-defined server id. */
export type LspServerId = string

/** How to launch a language server that isn't bundled (from a plugin). */
export interface LspSpec {
  command: string
  args?: string[]
  initializationOptions?: unknown
}

// ───────────── plugins ─────────────

export interface PluginLanguageServer {
  id: string
  name: string
  /** Monaco language ids, e.g. ["rust"]. */
  languages: string[]
  command: string
  args?: string[]
  initializationOptions?: unknown
  /** Shell command that installs the server, shown when it's missing. */
  install?: string
}

export interface ProblemMatcherSpec {
  /** Regex with named groups: file, line, column?, severity?, code?, message. */
  regexp: string
  severity?: 'error' | 'warning' | 'info'
}

export interface PluginTask {
  id: string
  label: string
  group?: 'build' | 'check' | 'test' | 'run' | 'format' | 'clean'
  /** Shell command; supports ${file}, ${workspaceFolder}, ${find:glob}, ${findDir:glob}, ${pluginDir}. */
  command: string
  cwd?: string
  /** Built-in matcher name (msbuild, rustc, gcc, tsc, python) or a custom one. */
  problemMatcher?: string | ProblemMatcherSpec | (string | ProblemMatcherSpec)[]
  /** Run in the interactive terminal instead of the Output panel. */
  terminal?: boolean
  /** Only offered when the workspace contains a file matching one of these globs. */
  when?: { files?: string[] }
}

export interface PluginRunner {
  extensions: string[]
  command: string
  cwd?: string
}

/** An installed VS Code / VSCodium extension folder (~/.ecode/extensions/<id>-<version>). */
export interface ExtensionFolder {
  dir: string
  /** package.json */
  manifest?: Record<string, unknown>
  /** package.nls.json merged with the localized package.nls.<locale>.json. */
  nls?: Record<string, string>
  error?: string
}

/** How to start a debug adapter (always stdio). */
export interface DapAdapterSpec {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

export interface PluginDebugger {
  /** Unique id, also the launch.json `type` it answers to (plus `types`). */
  type: string
  label: string
  /** Monaco language ids whose files this debugger launches. */
  languages: string[]
  /** Extra launch.json `type` values handled by this adapter (e.g. "python" for debugpy). */
  types?: string[]
  adapter: {
    /** Executable, or candidates tried in order (first found on PATH wins). */
    command: string | string[]
    args?: string[]
    env?: Record<string, string>
  }
  /** Shown when the adapter can't be started. */
  install?: string
  /** Default `launch` request arguments; ${…} variables are resolved. */
  launch: Record<string, unknown>
  /** Task id to run (and wait for) before launching, e.g. "cargo.build". */
  preLaunchTask?: string
  when?: { files?: string[] }
}

export interface PluginManifest {
  id: string
  name: string
  version?: string
  description?: string
  /** CLI tools the plugin relies on, checked and shown in the Plugins view. */
  requires?: { command: string; install?: string }[]
  languageServers?: PluginLanguageServer[]
  tasks?: PluginTask[]
  runners?: PluginRunner[]
  debuggers?: PluginDebugger[]
}

export interface PluginEntry {
  dir: string
  builtin: boolean
  manifest?: PluginManifest
  error?: string
}

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
  runtime: 'electron' | 'tauri'
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
  /** Runtimes that don't expose paths on DOM drops report dropped files here. */
  onFileDrop?(cb: (paths: string[]) => void): () => void
  // terminal
  termCreate(cwd: string | null, cols: number, rows: number): Promise<TermInfo>
  termWrite(id: number, data: string): void
  termResize(id: number, cols: number, rows: number): void
  termKill(id: number): void
  onTermData(cb: (id: number, data: string) => void): () => void
  onTermExit(cb: (id: number, code: number | null) => void): () => void
  // language servers
  lspStart(server: LspServerId, root: string, spec?: LspSpec): Promise<{ capabilities: Record<string, unknown> }>
  lspRequest(server: LspServerId, method: string, params: unknown): Promise<unknown>
  lspNotify(server: LspServerId, method: string, params: unknown): void
  lspStopAll(): Promise<void>
  onLspNotification(cb: (server: LspServerId, method: string, params: unknown) => void): () => void
  onLspExit(cb: (server: LspServerId, code: number | null) => void): () => void
  // debug adapters
  dapStart(spec: DapAdapterSpec): Promise<number>
  dapSend(id: number, msg: unknown): void
  dapStop(id: number): void
  onDapMessage(cb: (id: number, msg: Record<string, unknown>) => void): () => void
  onDapStderr(cb: (id: number, data: string) => void): () => void
  onDapExit(cb: (id: number, code: number | null) => void): () => void
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
  // eraAI (eraCore bridge)
  eraDetect(pythonPath: string): Promise<PythonInfo | null>
  eraStart(pythonPath: string): Promise<EraHello>
  eraSend(msg: unknown): void
  eraStop(): Promise<void>
  eraListModels(url: string): Promise<string[]>
  eraPickModelFile(): Promise<string | null>
  onEraEvent(cb: (msg: Record<string, unknown>) => void): () => void
  // plugins, tasks, tools
  pluginsList(): Promise<PluginEntry[]>
  /** User plugin folder (created if missing). */
  pluginsDir(): Promise<string>
  taskRun(command: string, cwd: string): Promise<number>
  taskKill(id: number): void
  onTaskOutput(cb: (id: number, data: string) => void): () => void
  onTaskExit(cb: (id: number, code: number | null) => void): () => void
  homeDir(): Promise<string>
  /** CPU architecture in Node terms (x64, arm64). */
  arch: string
  // extensions (VS Code / VSCodium .vsix)
  extensionsDir(): Promise<string>
  extensionsList(): Promise<ExtensionFolder[]>
  /** Unpack a .vsix into the extensions folder (replacing other versions); returns the new folder. */
  extensionInstall(vsixPath: string): Promise<ExtensionFolder>
  extensionUninstall(dir: string): Promise<void>
  /** Download to a temporary file and return its path. */
  download(url: string): Promise<string>
  /** GET a URL as text (gallery JSON), from the backend so CORS doesn't apply. */
  httpGet(url: string): Promise<string>
  /** A small image file as a data: URL (extension icons, icon themes), or null. */
  readDataUrl(path: string): Promise<string | null>
  pickVsix(): Promise<string | null>
  /** Absolute path of a CLI tool on PATH, or null. */
  which(command: string): Promise<string | null>
  /** Installed font families (may be empty where the runtime can't enumerate). */
  listFonts(): Promise<string[]>
  // settings
  loadSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): void
}
