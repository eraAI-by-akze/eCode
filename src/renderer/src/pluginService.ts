import type { PluginEntry, PluginLanguageServer, PluginManifest, PluginRunner, PluginTask } from '@shared/types'
import { getState, setState } from './store'

/**
 * Plugins are folders with a plugin.json (built-in ones ship in
 * resources/plugins, user ones live in ~/.ecode/plugins). They are
 * declarative: language servers, tasks with problem matchers, file runners.
 * Nothing runs inside the window, so they behave the same on Electron and Tauri.
 */

const api = window.ecode

export interface Contributed<T> {
  item: T
  plugin: PluginManifest
  dir: string
}

export async function loadPlugins(): Promise<void> {
  let plugins: PluginEntry[] = []
  try {
    plugins = await api.pluginsList()
  } catch {
    plugins = []
  }
  setState({ plugins })
  await refreshTools()
}

export function isEnabled(id: string): boolean {
  return !getState().settings.disabledPlugins.includes(id)
}

function active(): { manifest: PluginManifest; dir: string }[] {
  return getState()
    .plugins.filter((p): p is PluginEntry & { manifest: PluginManifest } => !!p.manifest?.id && isEnabled(p.manifest.id))
    .map((p) => ({ manifest: p.manifest, dir: p.dir }))
}

function collect<T>(pick: (m: PluginManifest) => T[] | undefined): Contributed<T>[] {
  return active().flatMap(({ manifest, dir }) => (pick(manifest) ?? []).map((item) => ({ item, plugin: manifest, dir })))
}

export const pluginTasks = (): Contributed<PluginTask>[] => collect((m) => m.tasks)
export const pluginRunners = (): Contributed<PluginRunner>[] => collect((m) => m.runners)
export const pluginServers = (): Contributed<PluginLanguageServer>[] => collect((m) => m.languageServers)

/** Look up which CLI tools the active plugins need, for the Plugins view. */
export async function refreshTools(): Promise<void> {
  const names = new Set<string>()
  for (const p of getState().plugins) {
    for (const r of p.manifest?.requires ?? []) names.add(r.command)
    for (const s of p.manifest?.languageServers ?? []) names.add(s.command)
  }
  const tools: Record<string, string | null> = {}
  await Promise.all(
    [...names].map(async (n) => {
      tools[n] = await api.which(n).catch(() => null)
    })
  )
  setState({ tools })
}

const TEMPLATE = (id: string): PluginManifest => ({
  id,
  name: 'Мой плагин',
  version: '0.1.0',
  description: 'Задачи и языковой сервер для моего языка.',
  requires: [{ command: 'make', install: 'https://www.gnu.org/software/make/' }],
  tasks: [
    {
      id: `${id}.build`,
      label: 'make',
      group: 'build',
      command: 'make',
      problemMatcher: 'gcc',
      when: { files: ['Makefile'] }
    }
  ],
  runners: [{ extensions: ['.sh'], command: 'bash "${file}"' }]
})

/** Create ~/.ecode/plugins/<name>/plugin.json from a template and return its path. */
export async function scaffoldPlugin(name: string): Promise<string> {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'my-plugin'
  const base = await api.pluginsDir()
  const sep = api.pathSep
  const dir = `${base}${sep}${slug}`
  if (!(await api.stat(dir))) await api.createDir(base, slug)
  const file = `${dir}${sep}plugin.json`
  if (!(await api.stat(file))) await api.writeFile(file, JSON.stringify(TEMPLATE(`user.${slug}`), null, 2) + '\n')
  return file
}
