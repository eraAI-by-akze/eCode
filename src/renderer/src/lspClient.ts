/* eslint-disable @typescript-eslint/no-explicit-any -- LSP payloads are loosely typed JSON. */
import type { LspServerId } from '@shared/types'
import { monaco } from './monaco'
import { getState, setState, type Diagnostic, type LspStatus } from './store'
import { dirname } from './lib/path'

/**
 * Bridges Monaco to language servers running in the main process. Only the
 * features that work without a full VS Code workbench are wired up:
 * completion, hover, signature help, go to definition, document symbols,
 * formatting, rename and diagnostics.
 */

const api = window.ecode

type Model = monaco.editor.ITextModel
type Caps = Record<string, any>

const SERVER_FOR_LANGUAGE: Record<string, LspServerId> = {
  typescript: 'typescript',
  javascript: 'typescript',
  python: 'python'
}
const LANGUAGES_OF: Record<LspServerId, string[]> = {
  typescript: ['typescript', 'javascript'],
  python: ['python']
}
export const SERVER_NAMES: Record<LspServerId, string> = { typescript: 'TypeScript', python: 'Pyright' }

interface Server {
  root: string
  caps: Caps
  ready: Promise<boolean>
}
interface Doc {
  server: LspServerId
  path: string
  model: Model
  sub: monaco.IDisposable
}

const servers = new Map<LspServerId, Server>()
const docs = new Map<string, Doc>() // keyed by model URI string
const rawDiagnostics = new Map<string, any[]>()
const providers = new Map<LspServerId, monaco.IDisposable[]>()
const restarts = new Map<LspServerId, number>()

let loadModel: (path: string) => Promise<void> = async () => {}

/**
 * Read-only models for definition targets that aren't open, so Ctrl+hover
 * previews can show them. editorService adopts/drops them when the file opens.
 */
const shadows = new Map<string, Model>()
const MAX_SHADOWS = 30

async function ensureShadowModel(uri: monaco.Uri): Promise<void> {
  if (uri.scheme !== 'file' || monaco.editor.getModel(uri)) return
  const r = await api.readFile(uri.fsPath)
  if (r.content === undefined || monaco.editor.getModel(uri)) return
  shadows.set(uri.toString(), monaco.editor.createModel(r.content, undefined, uri))
  if (shadows.size > MAX_SHADOWS) {
    const [oldest, model] = shadows.entries().next().value as [string, Model]
    shadows.delete(oldest)
    model.dispose()
  }
}

/** Called before the editor creates a real model for this URI. */
export function dropShadowModel(uri: monaco.Uri): void {
  const key = uri.toString()
  const m = shadows.get(key)
  if (!m) return
  shadows.delete(key)
  m.dispose()
}
let notify: (message: string, kind: 'info' | 'error') => void = () => {}

// ─────────────────────────── conversions ───────────────────────────

const toPos = (p: monaco.IPosition) => ({ line: p.lineNumber - 1, character: p.column - 1 })
const toRange = (r: monaco.IRange) => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 }
})
const fromRange = (r: any): monaco.IRange => ({
  startLineNumber: r.start.line + 1,
  startColumn: r.start.character + 1,
  endLineNumber: r.end.line + 1,
  endColumn: r.end.character + 1
})
const uriKey = (uri: string): string => monaco.Uri.parse(uri).toString()

function markdown(doc: any): monaco.IMarkdownString | undefined {
  if (doc === undefined || doc === null || doc === '') return undefined
  if (typeof doc === 'string') return { value: doc }
  if (doc.kind === 'markdown') return { value: doc.value }
  if (doc.kind === 'plaintext') return { value: doc.value.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&') }
  if (doc.language) return { value: '```' + doc.language + '\n' + doc.value + '\n```' }
  return undefined
}

function hoverContents(c: any): monaco.IMarkdownString[] {
  if (!c) return []
  if (Array.isArray(c)) return c.flatMap(hoverContents)
  const md = markdown(c)
  return md ? [md] : []
}

const COMPLETION_KINDS = [
  'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module',
  'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder',
  'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'
] as const

function completionKind(kind?: number): monaco.languages.CompletionItemKind {
  const name = kind ? COMPLETION_KINDS[kind - 1] : undefined
  return name ? monaco.languages.CompletionItemKind[name] : monaco.languages.CompletionItemKind.Text
}

const SEVERITY: Record<number, [monaco.MarkerSeverity, Diagnostic['severity']]> = {
  1: [monaco.MarkerSeverity.Error, 'error'],
  2: [monaco.MarkerSeverity.Warning, 'warning'],
  3: [monaco.MarkerSeverity.Info, 'info'],
  4: [monaco.MarkerSeverity.Hint, 'hint']
}

/** LSP wants the React flavours for .tsx/.jsx or tsserver parses them as plain TS/JS. */
function lspLanguageId(model: Model): string {
  const path = model.uri.path.toLowerCase()
  if (path.endsWith('.tsx')) return 'typescriptreact'
  if (path.endsWith('.jsx')) return 'javascriptreact'
  return model.getLanguageId()
}

// ─────────────────────────── server lifecycle ───────────────────────────

function setStatus(id: LspServerId, status: LspStatus | null): void {
  setState((s) => {
    const lsp = { ...s.lsp }
    if (status) lsp[id] = status
    else delete lsp[id]
    return { lsp }
  })
}

/**
 * The workspace root, or for TypeScript without an open folder the first loose
 * file's directory (tsserver handles loose files; Pyright would crawl the whole
 * directory, so Python waits for a folder).
 */
function rootFor(id: LspServerId, path: string): string | null {
  const root = getState().root
  if (root) return root
  if (id !== 'typescript') return null
  return servers.get(id)?.root ?? dirname(path)
}

function ensureServer(id: LspServerId, path: string): Promise<boolean> {
  const root = rootFor(id, path)
  if (!root) return Promise.resolve(false)
  const existing = servers.get(id)
  if (existing && existing.root === root) return existing.ready
  const server: Server = { root, caps: {}, ready: Promise.resolve(false) }
  setStatus(id, { state: 'starting', message: 'запуск…' })
  server.ready = api
    .lspStart(id, root)
    .then(({ capabilities }) => {
      if (servers.get(id) !== server) return false
      server.caps = capabilities
      registerProviders(id)
      setStatus(id, { state: 'ready' })
      return true
    })
    .catch((err: Error) => {
      if (servers.get(id) === server) setStatus(id, { state: 'error', message: cleanError(err) })
      return false
    })
  servers.set(id, server)
  return server.ready
}

function cleanError(err: unknown): string {
  return String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
}

function request<T = any>(id: LspServerId, method: string, params: unknown): Promise<T | null> {
  return (api.lspRequest(id, method, params) as Promise<T>).catch((err) => {
    console.warn(`[lsp:${id}] ${method} failed:`, cleanError(err))
    return null
  })
}

function docFor(model: Model): Doc | undefined {
  return docs.get(model.uri.toString())
}

// ─────────────────────────── documents ───────────────────────────

export async function attachModel(path: string, model: Model): Promise<void> {
  const id = SERVER_FOR_LANGUAGE[model.getLanguageId()]
  if (!id) return
  if (!(await ensureServer(id, path)) || model.isDisposed()) return
  const key = model.uri.toString()
  if (docs.has(key)) return
  const caps = servers.get(id)!.caps
  const sync = caps.textDocumentSync
  const syncKind: number = typeof sync === 'number' ? sync : sync?.change ?? 1

  api.lspNotify(id, 'textDocument/didOpen', {
    textDocument: { uri: key, languageId: lspLanguageId(model), version: model.getVersionId(), text: model.getValue() }
  })
  const sub = model.onDidChangeContent((e) => {
    // Monaco lists changes back-to-front, so applying them in order is valid LSP.
    const contentChanges =
      syncKind === 2
        ? e.changes.map((c) => ({ range: toRange(c.range), rangeLength: c.rangeLength, text: c.text }))
        : [{ text: model.getValue() }]
    api.lspNotify(id, 'textDocument/didChange', {
      textDocument: { uri: key, version: model.getVersionId() },
      contentChanges
    })
  })
  docs.set(key, { server: id, path, model, sub })
  applyMarkers(key)
}

export function detachModel(model: Model): void {
  const key = model.uri.toString()
  const doc = docs.get(key)
  if (!doc) return
  doc.sub.dispose()
  docs.delete(key)
  api.lspNotify(doc.server, 'textDocument/didClose', { textDocument: { uri: key } })
}

export function didSave(model: Model): void {
  const doc = docFor(model)
  if (doc) api.lspNotify(doc.server, 'textDocument/didSave', { textDocument: { uri: model.uri.toString() } })
}

/** Path the editor uses for a server URI (keeps the original drive-letter casing). */
export function pathForUri(uri: monaco.Uri): string {
  return docs.get(uri.toString())?.path ?? uri.fsPath
}

// ─────────────────────────── diagnostics ───────────────────────────

function applyMarkers(key: string): void {
  const model = monaco.editor.getModel(monaco.Uri.parse(key))
  const list = rawDiagnostics.get(key) ?? []
  if (model && !model.isDisposed()) {
    monaco.editor.setModelMarkers(
      model,
      'lsp',
      list.map((d) => ({
        ...fromRange(d.range),
        message: d.message,
        severity: (SEVERITY[d.severity ?? 1] ?? SEVERITY[1])[0],
        source: d.source,
        code: d.code !== undefined ? String(d.code) : undefined,
        tags: d.tags
      }))
    )
  }
}

function publishDiagnostics(params: any): void {
  const key = uriKey(params.uri)
  const list: any[] = params.diagnostics ?? []
  rawDiagnostics.set(key, list)
  applyMarkers(key)
  const path = pathForUri(monaco.Uri.parse(key))
  setState((s) => {
    const diagnostics = { ...s.diagnostics }
    if (list.length) {
      diagnostics[path] = list.map((d) => {
        const r = fromRange(d.range)
        return {
          line: r.startLineNumber,
          column: r.startColumn,
          endLine: r.endLineNumber,
          endColumn: r.endColumn,
          message: d.message,
          severity: (SEVERITY[d.severity ?? 1] ?? SEVERITY[1])[1],
          source: d.source,
          code: d.code !== undefined ? String(d.code) : undefined
        }
      })
    } else {
      delete diagnostics[path]
    }
    return { diagnostics }
  })
}

// ─────────────────────────── providers ───────────────────────────

function registerProviders(id: LspServerId): void {
  providers.get(id)?.forEach((d) => d.dispose())
  const caps = servers.get(id)!.caps
  const langs = LANGUAGES_OF[id]
  const list: monaco.IDisposable[] = []
  const td = (model: Model) => ({ uri: model.uri.toString() })

  for (const lang of langs) {
    if (caps.completionProvider) {
      list.push(
        monaco.languages.registerCompletionItemProvider(lang, {
          triggerCharacters: caps.completionProvider.triggerCharacters ?? ['.'],
          async provideCompletionItems(model, position, context) {
            if (!docFor(model)) return null
            const r = await request(id, 'textDocument/completion', {
              textDocument: td(model),
              position: toPos(position),
              context: { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter }
            })
            if (!r) return null
            const items: any[] = Array.isArray(r) ? r : r.items ?? []
            const word = model.getWordUntilPosition(position)
            const wordEnd = model.getWordAtPosition(position)?.endColumn ?? position.column
            const insert = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column)
            const replace = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, wordEnd)
            return {
              incomplete: !Array.isArray(r) && !!r.isIncomplete,
              suggestions: items.map((item) => convertCompletion(item, { insert, replace }))
            }
          },
          async resolveCompletionItem(item) {
            const raw = (item as any).__lsp
            if (!caps.completionProvider.resolveProvider || !raw) return item
            const resolved = await request(id, 'completionItem/resolve', raw)
            if (!resolved) return item
            return {
              ...item,
              detail: resolved.detail ?? item.detail,
              documentation: markdown(resolved.documentation) ?? item.documentation,
              additionalTextEdits:
                resolved.additionalTextEdits?.map((e: any) => ({ range: fromRange(e.range), text: e.newText })) ??
                item.additionalTextEdits
            }
          }
        })
      )
    }

    if (caps.hoverProvider) {
      list.push(
        monaco.languages.registerHoverProvider(lang, {
          async provideHover(model, position) {
            if (!docFor(model)) return null
            const r = await request(id, 'textDocument/hover', { textDocument: td(model), position: toPos(position) })
            if (!r) return null
            const contents = hoverContents(r.contents)
            return contents.length ? { contents, range: r.range ? fromRange(r.range) : undefined } : null
          }
        })
      )
    }

    if (caps.signatureHelpProvider) {
      list.push(
        monaco.languages.registerSignatureHelpProvider(lang, {
          signatureHelpTriggerCharacters: caps.signatureHelpProvider.triggerCharacters ?? ['(', ','],
          signatureHelpRetriggerCharacters: caps.signatureHelpProvider.retriggerCharacters ?? [],
          async provideSignatureHelp(model, position, _token, context) {
            if (!docFor(model)) return null
            const r = await request(id, 'textDocument/signatureHelp', {
              textDocument: td(model),
              position: toPos(position),
              context: {
                triggerKind: context.triggerKind,
                triggerCharacter: context.triggerCharacter,
                isRetrigger: context.isRetrigger
              }
            })
            if (!r?.signatures?.length) return null
            return {
              value: {
                signatures: r.signatures.map((s: any) => ({
                  label: s.label,
                  documentation: markdown(s.documentation),
                  parameters: (s.parameters ?? []).map((p: any) => ({
                    label: p.label,
                    documentation: markdown(p.documentation)
                  })),
                  activeParameter: s.activeParameter
                })),
                activeSignature: r.activeSignature ?? 0,
                activeParameter: r.activeParameter ?? 0
              },
              dispose() {}
            }
          }
        })
      )
    }

    if (caps.definitionProvider) {
      list.push(
        monaco.languages.registerDefinitionProvider(lang, {
          async provideDefinition(model, position) {
            if (!docFor(model)) return null
            const r = await request(id, 'textDocument/definition', {
              textDocument: td(model),
              position: toPos(position)
            })
            if (!r) return null
            const locations: monaco.languages.Location[] = (Array.isArray(r) ? r : [r]).map((loc: any) =>
              loc.targetUri
                ? {
                    uri: monaco.Uri.parse(loc.targetUri),
                    range: fromRange(loc.targetSelectionRange ?? loc.targetRange)
                  }
                : { uri: monaco.Uri.parse(loc.uri), range: fromRange(loc.range) }
            )
            await Promise.all(locations.slice(0, 5).map((l) => ensureShadowModel(l.uri)))
            return locations
          }
        })
      )
    }

    if (caps.documentSymbolProvider) {
      list.push(
        monaco.languages.registerDocumentSymbolProvider(lang, {
          async provideDocumentSymbols(model) {
            if (!docFor(model)) return null
            const r = await request<any[]>(id, 'textDocument/documentSymbol', { textDocument: td(model) })
            return r?.map(convertSymbol) ?? null
          }
        })
      )
    }

    if (caps.documentFormattingProvider) {
      list.push(
        monaco.languages.registerDocumentFormattingEditProvider(lang, {
          async provideDocumentFormattingEdits(model, options) {
            if (!docFor(model)) return null
            const r = await request<any[]>(id, 'textDocument/formatting', {
              textDocument: td(model),
              options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces }
            })
            return r?.map((e) => ({ range: fromRange(e.range), text: e.newText })) ?? null
          }
        })
      )
    }

    if (caps.renameProvider) {
      list.push(
        monaco.languages.registerRenameProvider(lang, {
          async provideRenameEdits(model, position, newName) {
            if (!docFor(model)) return null
            const r = await request(id, 'textDocument/rename', {
              textDocument: td(model),
              position: toPos(position),
              newName
            })
            if (!r) return { edits: [], rejectReason: 'Переименование недоступно здесь' }
            const byUri: [string, any[]][] = r.documentChanges
              ? r.documentChanges.filter((c: any) => c.textDocument).map((c: any) => [c.textDocument.uri, c.edits])
              : Object.entries(r.changes ?? {})
            // Monaco can only edit models that exist; open the touched files first.
            for (const [uri] of byUri) {
              const u = monaco.Uri.parse(uri)
              if (!monaco.editor.getModel(u)) await loadModel(u.fsPath)
            }
            return {
              edits: byUri.flatMap(([uri, edits]) =>
                edits.map((e: any) => ({
                  resource: monaco.Uri.parse(uri),
                  textEdit: { range: fromRange(e.range), text: e.newText },
                  versionId: undefined
                }))
              )
            }
          }
        })
      )
    }
  }
  providers.set(id, list)
}

function convertCompletion(
  item: any,
  defaultRange: { insert: monaco.IRange; replace: monaco.IRange }
): monaco.languages.CompletionItem {
  const te = item.textEdit
  const range = te
    ? te.range
      ? fromRange(te.range)
      : { insert: fromRange(te.insert), replace: fromRange(te.replace) }
    : defaultRange
  const result: monaco.languages.CompletionItem = {
    label: item.labelDetails
      ? { label: item.label, detail: item.labelDetails.detail, description: item.labelDetails.description }
      : item.label,
    kind: completionKind(item.kind),
    detail: item.detail,
    documentation: markdown(item.documentation),
    insertText: te?.newText ?? item.insertText ?? item.label,
    insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    range,
    sortText: item.sortText,
    filterText: item.filterText,
    preselect: item.preselect,
    commitCharacters: item.commitCharacters,
    additionalTextEdits: item.additionalTextEdits?.map((e: any) => ({ range: fromRange(e.range), text: e.newText })),
    tags: item.deprecated || item.tags?.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined
  }
  ;(result as any).__lsp = item
  return result
}

function convertSymbol(s: any): monaco.languages.DocumentSymbol {
  if (s.location) {
    const range = fromRange(s.location.range)
    return { name: s.name, detail: '', kind: s.kind - 1, tags: [], range, selectionRange: range, containerName: s.containerName }
  }
  return {
    name: s.name,
    detail: s.detail ?? '',
    kind: s.kind - 1,
    tags: [],
    range: fromRange(s.range),
    selectionRange: fromRange(s.selectionRange),
    children: s.children?.map(convertSymbol)
  }
}

// ─────────────────────────── wiring ───────────────────────────

function forgetServer(id: LspServerId): void {
  servers.delete(id)
  providers.get(id)?.forEach((d) => d.dispose())
  providers.delete(id)
  for (const [key, doc] of [...docs]) {
    if (doc.server !== id) continue
    doc.sub.dispose()
    docs.delete(key)
  }
}

export function initLsp(opts: {
  loadModel: (path: string) => Promise<void>
  notify: (message: string, kind: 'info' | 'error') => void
  models: () => [string, Model][]
}): void {
  loadModel = opts.loadModel
  notify = opts.notify

  api.onLspNotification((id, method, params: any) => {
    if (method === 'textDocument/publishDiagnostics') publishDiagnostics(params)
    else if (method === 'window/showMessage' && params?.type === 1) notify(`${SERVER_NAMES[id]}: ${params.message}`, 'error')
    else if (method === '$/progress' && params?.value) {
      const v = params.value
      const text = [v.title, v.message].filter(Boolean).join(' · ')
      setStatus(id, { state: 'ready', message: v.kind === 'end' ? undefined : text || undefined })
    }
  })

  api.onLspExit((id) => {
    forgetServer(id)
    const n = (restarts.get(id) ?? 0) + 1
    restarts.set(id, n)
    if (n > 3) {
      setStatus(id, { state: 'error', message: 'сервер остановился' })
      return
    }
    // Crashed: bring it back and reopen its documents.
    setTimeout(() => {
      for (const [path, model] of opts.models()) {
        if (SERVER_FOR_LANGUAGE[model.getLanguageId()] === id) attachModel(path, model)
      }
    }, 800)
  })
}

/** Stop every server (folder closed/changed) and clear their state. */
export async function stopAll(): Promise<void> {
  for (const id of [...servers.keys()]) forgetServer(id)
  for (const key of rawDiagnostics.keys()) {
    const model = monaco.editor.getModel(monaco.Uri.parse(key))
    if (model) monaco.editor.setModelMarkers(model, 'lsp', [])
  }
  rawDiagnostics.clear()
  restarts.clear()
  setState({ lsp: {}, diagnostics: {} })
  await api.lspStopAll()
}

export function serverForLanguage(languageId: string): LspServerId | undefined {
  return SERVER_FOR_LANGUAGE[languageId]
}
