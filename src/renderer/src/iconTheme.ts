import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { monaco } from './monaco'
import { parseJsonc } from './lib/jsonc'
import { dirname } from './lib/path'

/**
 * File icon themes from VS Code extensions (Material Icon Theme, vscode-icons…).
 * Icons are SVG/PNG files read through the backend as data: URLs, on demand.
 */

const api = window.ecode

type Maps = {
  file?: string
  folder?: string
  folderExpanded?: string
  rootFolder?: string
  rootFolderExpanded?: string
  fileExtensions?: Record<string, string>
  fileNames?: Record<string, string>
  folderNames?: Record<string, string>
  folderNamesExpanded?: Record<string, string>
  languageIds?: Record<string, string>
}

interface IconThemeJson extends Maps {
  iconDefinitions?: Record<string, { iconPath?: string; fontCharacter?: string }>
  light?: Maps
}

interface Active {
  maps: Maps
  defs: Record<string, string>
}

/** Bumped when the theme or a loaded icon changes, so icons re-render. */
const useIconStore = create<{ version: number }>(() => ({ version: 0 }))
let active: Active | null = null
const urls = new Map<string, string | null>()
const loading = new Set<string>()

const lower = (m: Record<string, string> | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k.toLowerCase(), v]))

/** Load an icon theme JSON (null = eCode's own icons). */
export async function setIconTheme(path: string | null, dark: boolean): Promise<void> {
  urls.clear()
  if (!path) {
    active = null
    useIconStore.setState((s) => ({ version: s.version + 1 }))
    return
  }
  const r = await api.readFile(path)
  if (r.content === undefined) throw new Error(r.error ?? path)
  const json = parseJsonc<IconThemeJson>(r.content)
  const base = dirname(path)
  const defs: Record<string, string> = {}
  for (const [id, d] of Object.entries(json.iconDefinitions ?? {})) {
    if (d.iconPath) defs[id] = joinPath(base, d.iconPath)
  }
  const light = !dark ? json.light ?? {} : {}
  const merge = (k: keyof Maps): Record<string, string> => ({ ...lower(json[k] as Record<string, string>), ...lower(light[k] as Record<string, string>) })
  active = {
    defs,
    maps: {
      file: light.file ?? json.file,
      folder: light.folder ?? json.folder,
      folderExpanded: light.folderExpanded ?? json.folderExpanded,
      rootFolder: light.rootFolder ?? json.rootFolder,
      rootFolderExpanded: light.rootFolderExpanded ?? json.rootFolderExpanded,
      fileExtensions: merge('fileExtensions'),
      fileNames: merge('fileNames'),
      folderNames: merge('folderNames'),
      folderNamesExpanded: merge('folderNamesExpanded'),
      languageIds: { ...(json.languageIds ?? {}), ...(light.languageIds ?? {}) }
    }
  }
  useIconStore.setState((s) => ({ version: s.version + 1 }))
}

function joinPath(dir: string, rel: string): string {
  const sep = api.pathSep
  const out: string[] = []
  for (const p of `${dir}/${rel}`.split(/[/\\]/)) {
    if (p === '..') out.pop()
    else if (p !== '.') out.push(p)
  }
  return out.join(sep)
}

function languageOf(name: string): string | undefined {
  const lowerName = name.toLowerCase()
  for (const l of monaco.languages.getLanguages()) {
    if (l.filenames?.some((f) => f.toLowerCase() === lowerName)) return l.id
    if (l.extensions?.some((e) => lowerName.endsWith(e.toLowerCase()))) return l.id
  }
  return undefined
}

function iconId(name: string, kind: 'file' | 'folder' | 'folderOpen'): string | undefined {
  const m = active?.maps
  if (!m) return undefined
  const n = name.toLowerCase()
  if (kind !== 'file') {
    const open = kind === 'folderOpen'
    return (open ? m.folderNamesExpanded?.[n] : undefined) ?? (open ? undefined : m.folderNames?.[n]) ?? (open ? m.folderExpanded : m.folder) ?? m.folder
  }
  if (m.fileNames?.[n]) return m.fileNames[n]
  // "a.test.ts" tries "test.ts", then "ts".
  const parts = n.split('.')
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join('.')
    if (m.fileExtensions?.[ext]) return m.fileExtensions[ext]
  }
  const lang = languageOf(name)
  if (lang && m.languageIds?.[lang]) return m.languageIds[lang]
  return m.file
}

/** Data URL of the themed icon, or null while loading / when the theme has none. */
export function useThemedIcon(name: string, kind: 'file' | 'folder' | 'folderOpen'): string | null {
  const version = useIconStore((s) => s.version)
  const id = active ? iconId(name, kind) : undefined
  const path = id ? active?.defs[id] : undefined
  const [, force] = useState(0)
  useEffect(() => {
    if (!path || urls.has(path) || loading.has(path)) return
    loading.add(path)
    void api
      .readDataUrl(path)
      .catch(() => null)
      .then((url) => {
        urls.set(path, url)
        loading.delete(path)
        force((x) => x + 1)
      })
  }, [path, version])
  return path ? urls.get(path) ?? null : null
}

export function iconThemeActive(): boolean {
  return !!active
}
