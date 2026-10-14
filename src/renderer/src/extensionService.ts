import type { ExtensionFolder, PluginDebugger, PluginEntry, PluginLanguageServer, PluginManifest } from '@shared/types'
import { monaco } from './monaco'
import { getState, setState, type IconThemeInfo, type InstalledExtension } from './store'
import { toast, pick } from './actions'
import { addGrammar, activateLanguage, hasGrammar, resetGrammars } from './textmate'
import { loadVSCodeTheme, registerTheme, toAppTheme, unregisterExtensionThemes } from './extThemes'
import { THEMES } from './themes'
import { setIconTheme } from './iconTheme'
import { redetectLanguages } from './editorService'
import { parseJsonc } from './lib/jsonc'

/**
 * VS Code / VSCodium extensions. eCode reads what extensions declare in
 * package.json (colour and icon themes, TextMate grammars, language
 * configuration, snippets) and maps a few well-known ones (CodeLLDB,
 * rust-analyzer, debugpy) to its own debugger and language-server hooks.
 * Extension JavaScript (`main`) is not executed.
 */

const api = window.ecode
const isWin = api.platform === 'win32'

type Manifest = Record<string, unknown> & {
  name?: string
  publisher?: string
  displayName?: string
  description?: string
  version?: string
  icon?: string
  main?: string
  browser?: string
  extensionPack?: string[]
  contributes?: Contributes
}

interface Contributes {
  languages?: {
    id: string
    extensions?: string[]
    filenames?: string[]
    filenamePatterns?: string[]
    aliases?: string[]
    firstLine?: string
    mimetypes?: string[]
    configuration?: string
  }[]
  grammars?: { language?: string; scopeName: string; path: string; embeddedLanguages?: Record<string, string>; injectTo?: string[] }[]
  themes?: { id?: string; label: string; uiTheme?: string; path: string }[]
  iconThemes?: { id: string; label: string; path: string }[]
  snippets?: { language: string; path: string }[]
  debuggers?: { type: string; label?: string }[]
}

let disposables: monaco.IDisposable[] = []

// ─────────────────────────── helpers ───────────────────────────

function join(dir: string, rel: string): string {
  const sep = api.pathSep
  const out: string[] = []
  for (const p of `${dir}/${rel}`.split(/[/\\]/)) {
    if (p === '..') out.pop()
    else if (p !== '.') out.push(p)
  }
  return out.join(sep)
}

function localize(value: unknown, nls: Record<string, string> | undefined): string {
  const s = typeof value === 'string' ? value : ''
  const m = /^%(.+)%$/.exec(s)
  return m ? nls?.[m[1]] ?? m[1] : s
}

const extId = (m: Manifest): string => `${m.publisher ?? 'unknown'}.${m.name ?? ''}`.toLowerCase()

function regex(v: unknown): RegExp | undefined {
  try {
    if (typeof v === 'string') return new RegExp(v)
    if (v && typeof v === 'object' && 'pattern' in v) {
      const o = v as { pattern: string; flags?: string }
      return new RegExp(o.pattern, o.flags)
    }
  } catch {
    // Oniguruma-only syntax: skip the rule.
  }
  return undefined
}

/** language-configuration.json → Monaco's LanguageConfiguration. */
function languageConfiguration(raw: Record<string, unknown>): monaco.languages.LanguageConfiguration {
  const conf: monaco.languages.LanguageConfiguration = {}
  if (raw.comments) conf.comments = raw.comments as monaco.languages.CommentRule
  if (raw.brackets) conf.brackets = raw.brackets as monaco.languages.CharacterPair[]
  if (raw.autoClosingPairs) {
    conf.autoClosingPairs = (raw.autoClosingPairs as unknown[]).map((p) =>
      Array.isArray(p) ? { open: p[0], close: p[1] } : (p as monaco.languages.IAutoClosingPairConditional)
    )
  }
  if (raw.surroundingPairs) {
    conf.surroundingPairs = (raw.surroundingPairs as unknown[]).map((p) => (Array.isArray(p) ? { open: p[0], close: p[1] } : (p as monaco.languages.IAutoClosingPair)))
  }
  if (typeof raw.autoCloseBefore === 'string') conf.autoCloseBefore = raw.autoCloseBefore
  const word = regex(raw.wordPattern)
  if (word) conf.wordPattern = word
  const ind = raw.indentationRules as Record<string, unknown> | undefined
  if (ind) {
    const inc = regex(ind.increaseIndentPattern)
    const dec = regex(ind.decreaseIndentPattern)
    if (inc && dec) {
      conf.indentationRules = {
        increaseIndentPattern: inc,
        decreaseIndentPattern: dec,
        indentNextLinePattern: regex(ind.indentNextLinePattern),
        unIndentedLinePattern: regex(ind.unIndentedLinePattern)
      }
    }
  }
  const fold = raw.folding as { offSide?: boolean; markers?: { start: unknown; end: unknown } } | undefined
  if (fold) {
    const start = regex(fold.markers?.start)
    const end = regex(fold.markers?.end)
    conf.folding = { offSide: fold.offSide, ...(start && end ? { markers: { start, end } } : {}) }
  }
  const ACTION: Record<string, monaco.languages.IndentAction> = {
    none: monaco.languages.IndentAction.None,
    indent: monaco.languages.IndentAction.Indent,
    indentOutdent: monaco.languages.IndentAction.IndentOutdent,
    outdent: monaco.languages.IndentAction.Outdent
  }
  if (Array.isArray(raw.onEnterRules)) {
    conf.onEnterRules = (raw.onEnterRules as Record<string, unknown>[]).flatMap((r) => {
      const before = regex(r.beforeText)
      if (!before) return []
      const a = (r.action ?? {}) as { indent?: string; appendText?: string; removeText?: number }
      return [
        {
          beforeText: before,
          afterText: regex(r.afterText),
          previousLineText: regex(r.previousLineText),
          action: { indentAction: ACTION[a.indent ?? 'none'] ?? monaco.languages.IndentAction.None, appendText: a.appendText, removeText: a.removeText }
        }
      ]
    })
  }
  return conf
}

async function readJsonc<T>(path: string): Promise<T | null> {
  const r = await api.readFile(path).catch(() => null)
  if (!r?.content) return null
  try {
    return parseJsonc<T>(r.content)
  } catch {
    return null
  }
}

// ─────────────────────────── known extensions ───────────────────────────

const exe = (p: string): string => (isWin ? `${p}.exe` : p)
const CARGO_LAUNCH = { program: '${cargoTarget}', args: [], cwd: '${cargoDir}' }

/** Debuggers and language servers of well-known extensions, which VS Code starts from JavaScript. */
function knownContributions(id: string, dir: string): { debuggers?: PluginDebugger[]; languageServers?: PluginLanguageServer[] } | null {
  switch (id) {
    case 'vadimcn.vscode-lldb':
      return {
        debuggers: [
          {
            type: 'lldb',
            types: ['codelldb'],
            label: 'Rust: CodeLLDB (расширение)',
            languages: ['rust', 'c', 'cpp'],
            adapter: { command: exe(join(dir, 'adapter/codelldb')) },
            launch: { ...CARGO_LAUNCH, sourceLanguages: ['rust'] },
            preLaunchTask: 'cargo.build',
            when: { files: ['**/Cargo.toml'] }
          }
        ]
      }
    case 'rust-lang.rust-analyzer':
      return { languageServers: [{ id: 'rust', name: 'rust-analyzer', languages: ['rust'], command: exe(join(dir, 'server/rust-analyzer')) }] }
    case 'ms-python.debugpy':
      return {
        debuggers: [
          {
            type: 'debugpy',
            types: ['python'],
            label: 'Python: текущий файл (debugpy из расширения)',
            languages: ['python'],
            adapter: { command: '${python}', args: [join(dir, 'bundled/libs/debugpy/adapter')], env: { PYTHONPATH: join(dir, 'bundled/libs') } },
            launch: { program: '${file}', cwd: '${workspaceFolder}', console: 'integratedTerminal', justMyCode: true }
          }
        ]
      }
    case 'muhammad-sammy.csharp':
      return {
        debuggers: [
          {
            type: 'coreclr',
            label: '.NET: запуск проекта (netcoredbg из расширения)',
            languages: ['csharp', 'fsharp'],
            adapter: { command: [exe(join(dir, '.debugger/netcoredbg/netcoredbg')), exe(join(dir, '.debugger/netcoredbg'))], args: ['--interpreter=vscode'] },
            launch: { program: '${dotnetTarget}', args: [], cwd: '${dotnetProjectDir}', stopAtEntry: false, console: 'internalConsole' },
            preLaunchTask: 'dotnet.build',
            when: { files: ['**/*.csproj', '**/*.fsproj'] }
          }
        ]
      }
  }
  return null
}

// ─────────────────────────── loading ───────────────────────────

interface Snippet {
  prefix: string | string[]
  body: string | string[]
  description?: string
}

/** Read every installed extension and apply what it contributes. */
export async function loadExtensions(): Promise<void> {
  let folders: ExtensionFolder[] = []
  try {
    folders = await api.extensionsList()
  } catch {
    folders = []
  }
  for (const d of disposables) d.dispose()
  disposables = []
  resetGrammars()
  unregisterExtensionThemes()

  const disabled = new Set(getState().settings.disabledExtensions)
  const extensions: InstalledExtension[] = []
  const extPlugins: PluginEntry[] = []
  const iconThemes: IconThemeInfo[] = []
  const snippets = new Map<string, { label: string; ext: string; s: Snippet }[]>()
  const grammarLanguages = new Set<string>()

  for (const f of folders) {
    const m = f.manifest as Manifest | undefined
    if (!m?.name) {
      extensions.push({ id: f.dir, name: f.dir, displayName: f.dir.split(/[/\\]/).pop() ?? f.dir, publisher: '', version: '', description: '', dir: f.dir, enabled: false, features: [], hasCode: false, unsupported: true, error: f.error ?? 'нет package.json' })
      continue
    }
    const id = extId(m)
    const nls = f.nls
    const c = m.contributes ?? {}
    const enabled = !disabled.has(id)
    const displayName = localize(m.displayName, nls) || m.name
    const features: string[] = []
    const known = knownContributions(id, f.dir)

    if (c.themes?.length) features.push(c.themes.length > 1 ? `Темы (${c.themes.length})` : 'Тема')
    if (c.iconThemes?.length) features.push('Значки файлов')
    if (c.grammars?.length) features.push('Синтаксис')
    if (c.languages?.length && !c.grammars?.length) features.push('Языки')
    if (c.snippets?.length) features.push('Сниппеты')
    if (known?.debuggers) features.push('Отладчик')
    if (known?.languageServers) features.push('Языковой сервер')
    const hasCode = !!(m.main || m.browser)
    extensions.push({
      id,
      name: m.name,
      displayName,
      publisher: m.publisher ?? '',
      version: m.version ?? '',
      description: localize(m.description, nls),
      dir: f.dir,
      icon: m.icon ? join(f.dir, m.icon) : undefined,
      enabled,
      features,
      hasCode,
      unsupported: !features.length && !m.extensionPack?.length
    })
    if (!enabled) continue

    if (known) {
      extPlugins.push({
        dir: f.dir,
        builtin: false,
        manifest: { id: `ext:${id}`, name: displayName, ...known } as PluginManifest
      })
    }
    for (const l of c.languages ?? []) {
      if (!l.id) continue
      monaco.languages.register({
        id: l.id,
        extensions: l.extensions,
        filenames: l.filenames,
        filenamePatterns: l.filenamePatterns,
        aliases: l.aliases,
        firstLine: l.firstLine,
        mimetypes: l.mimetypes
      })
      if (l.configuration) {
        const raw = await readJsonc<Record<string, unknown>>(join(f.dir, l.configuration))
        if (raw) disposables.push(monaco.languages.setLanguageConfiguration(l.id, languageConfiguration(raw)))
      }
    }
    for (const g of c.grammars ?? []) {
      if (!g.scopeName || !g.path) continue
      addGrammar({ scopeName: g.scopeName, path: join(f.dir, g.path), language: g.language, embeddedLanguages: g.embeddedLanguages, injectTo: g.injectTo })
      if (g.language) grammarLanguages.add(g.language)
    }
    for (const t of c.themes ?? []) {
      const label = localize(t.label, nls)
      try {
        const json = await loadVSCodeTheme(join(f.dir, t.path))
        registerTheme(toAppTheme(`ext:${id}/${t.id ?? label}`, label, t.uiTheme ?? 'vs-dark', json, displayName))
      } catch (err) {
        console.warn('theme', label, err)
      }
    }
    for (const t of c.iconThemes ?? []) {
      iconThemes.push({ id: `${id}/${t.id}`, label: localize(t.label, nls) || t.id, path: join(f.dir, t.path), extension: displayName })
    }
    for (const sn of c.snippets ?? []) {
      const file = await readJsonc<Record<string, Snippet>>(join(f.dir, sn.path))
      if (!file || !sn.language) continue
      const list = snippets.get(sn.language) ?? []
      for (const [label, s] of Object.entries(file)) if (s?.prefix && s.body) list.push({ label, ext: displayName, s })
      snippets.set(sn.language, list)
    }
  }

  for (const [language, list] of snippets) disposables.push(registerSnippets(language, list))
  redetectLanguages()
  for (const lang of grammarLanguages) {
    // Tokenize with the grammar as soon as a file of that language opens.
    disposables.push(monaco.languages.onLanguage(lang, () => void activateLanguage(lang)))
    if (monaco.editor.getModels().some((md) => md.getLanguageId() === lang)) void activateLanguage(lang)
  }
  setState((s) => ({ extensions: extensions.sort((a, b) => a.displayName.localeCompare(b.displayName)), extPlugins, iconThemes, themesVersion: s.themesVersion + 1 }))
  await applyIconTheme()
}

function registerSnippets(language: string, list: { label: string; ext: string; s: Snippet }[]): monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider(language, {
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position)
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
      const suggestions: monaco.languages.CompletionItem[] = []
      for (const { label, ext, s } of list) {
        const body = Array.isArray(s.body) ? s.body.join('\n') : s.body
        for (const prefix of Array.isArray(s.prefix) ? s.prefix : [s.prefix]) {
          suggestions.push({
            label: { label: prefix, description: s.description ?? label },
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: body,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: { value: `**${label}** · ${ext}\n\n\`\`\`\n${body}\n\`\`\`` },
            range,
            sortText: `~${prefix}`
          })
        }
      }
      return { suggestions }
    }
  })
}

export async function applyIconTheme(): Promise<void> {
  const { settings, iconThemes } = getState()
  const theme = iconThemes.find((t) => t.id === settings.iconTheme)
  try {
    await setIconTheme(theme?.path ?? null, THEMES[settings.theme]?.dark ?? true)
  } catch (err) {
    toast(`Тема значков: ${(err as Error).message}`, 'error')
  }
}

export function grammarActive(language: string): boolean {
  return hasGrammar(language)
}

// ─────────────────────────── install / remove ───────────────────────────

/** After installing: offer the extension's themes, like VS Code's "Set Color Theme". */
function offerThemes(id: string, apply: (patch: { theme?: string; iconTheme?: string }) => void): void {
  const colorThemes = Object.values(THEMES).filter((t) => t.id.startsWith(`ext:${id}/`))
  const icons = getState().iconThemes.filter((t) => t.id.startsWith(`${id}/`))
  if (colorThemes.length) {
    pick(
      'Применить тему из расширения?',
      colorThemes.map((t) => ({ id: t.id, label: t.name, detail: t.tagline })),
      (themeId) => apply({ theme: themeId })
    )
  } else if (icons.length) {
    pick(
      'Включить тему значков?',
      icons.map((t) => ({ id: t.id, label: t.label, detail: t.extension })),
      (iconId) => apply({ iconTheme: iconId })
    )
  }
}

let applySettings: (patch: { theme?: string; iconTheme?: string; disabledExtensions?: string[] }) => void = () => {}
/** actions.updateSettings, injected to avoid an import cycle. */
export function bindSettings(fn: typeof applySettings): void {
  applySettings = fn
}

export async function installVsix(path: string, offer = true): Promise<InstalledExtension | null> {
  try {
    const folder = await api.extensionInstall(path)
    await loadExtensions()
    const m = folder.manifest as Manifest | undefined
    const id = m ? extId(m) : ''
    const ext = getState().extensions.find((e) => e.id === id) ?? null
    if (ext) {
      toast(
        `Установлено: ${ext.displayName} ${ext.version}${ext.unsupported ? ' — eCode не может использовать это расширение (только код JavaScript)' : ''}`,
        ext.unsupported ? 'error' : 'success'
      )
      for (const dep of m?.extensionPack ?? []) await installFromGallery(dep, false).catch(() => {})
      if (offer) offerThemes(id, applySettings)
    }
    return ext
  } catch (err) {
    toast(`Не удалось установить: ${(err as Error).message}`, 'error')
    return null
  }
}

export async function uninstall(ext: InstalledExtension): Promise<void> {
  try {
    await api.extensionUninstall(ext.dir)
    const { settings } = getState()
    if (settings.theme.startsWith(`ext:${ext.id}/`)) applySettings({ theme: 'era-glass' })
    if (settings.iconTheme.startsWith(`${ext.id}/`)) applySettings({ iconTheme: '' })
    await loadExtensions()
    toast(`Удалено: ${ext.displayName}`)
  } catch (err) {
    toast(`Не удалось удалить: ${(err as Error).message}`, 'error')
  }
}

export function setExtensionEnabled(ext: InstalledExtension, enabled: boolean): void {
  const list = new Set(getState().settings.disabledExtensions)
  if (enabled) list.delete(ext.id)
  else list.add(ext.id)
  applySettings({ disabledExtensions: [...list] })
  void loadExtensions()
}

// ─────────────────────────── Open VSX ───────────────────────────

export interface GalleryExtension {
  namespace: string
  name: string
  version: string
  displayName: string
  description: string
  icon?: string
  downloads?: number
  rating?: number
}

function gallery(): string {
  return (getState().settings.extensionGallery || 'https://open-vsx.org').replace(/\/+$/, '')
}

/** VSCodium / Open VSX target platform for this machine. */
function targetPlatform(): string {
  const os = api.platform === 'win32' ? 'win32' : api.platform === 'darwin' ? 'darwin' : 'linux'
  return `${os}-${api.arch === 'arm64' ? 'arm64' : api.arch === 'arm' ? 'armhf' : 'x64'}`
}

export async function searchGallery(query: string): Promise<GalleryExtension[]> {
  const q = new URLSearchParams({
    query,
    size: '30',
    sortBy: query ? 'relevance' : 'downloadCount',
    sortOrder: 'desc',
    targetPlatform: targetPlatform()
  })
  const json = JSON.parse(await api.httpGet(`${gallery()}/api/-/search?${q}`)) as {
    extensions?: { namespace: string; name: string; version: string; displayName?: string; description?: string; files?: { icon?: string }; downloadCount?: number; averageRating?: number }[]
  }
  return (json.extensions ?? []).map((e) => ({
    namespace: e.namespace,
    name: e.name,
    version: e.version,
    displayName: e.displayName || e.name,
    description: e.description ?? '',
    icon: e.files?.icon,
    downloads: e.downloadCount,
    rating: e.averageRating
  }))
}

/** Install `namespace.name` (latest version, this platform's build when there is one). */
export async function installFromGallery(id: string, offer = true): Promise<InstalledExtension | null> {
  const [ns, name] = id.split('.')
  if (!ns || !name) throw new Error(`Неверный идентификатор: ${id}`)
  const base = `${gallery()}/api/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`
  const target = targetPlatform()
  let meta: { downloads?: Record<string, string>; files?: { download?: string }; targetPlatform?: string }
  try {
    meta = JSON.parse(await api.httpGet(`${base}/${target}`))
  } catch {
    meta = JSON.parse(await api.httpGet(base))
  }
  const url = meta.downloads?.[target] ?? meta.downloads?.universal ?? meta.files?.download
  if (!url) throw new Error(`${id}: нет файла для ${target}`)
  const file = await api.download(url)
  return installVsix(file, offer)
}

export function isInstalled(namespace: string, name: string): InstalledExtension | undefined {
  const id = `${namespace}.${name}`.toLowerCase()
  return getState().extensions.find((e) => e.id === id)
}

export async function pickAndInstallVsix(): Promise<void> {
  const path = await api.pickVsix()
  if (path) await installVsix(path)
}
