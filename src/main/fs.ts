import { BrowserWindow, ipcMain, shell } from 'electron'
import { promises as fsp, watch, type FSWatcher, type Dirent } from 'fs'
import { dirname, join, relative, sep } from 'path'
import type { DirEntry, ReadFileResult, SearchFileResult, SearchOptions, SearchResult } from '../shared/types'

/** Hidden from the explorer entirely. */
const HIDDEN = new Set(['.git', '.DS_Store', 'Thumbs.db'])
/** Skipped by quick open, search and the watcher. */
const HEAVY_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.nuxt',
  'dist',
  'out',
  'build',
  '.cache',
  '.turbo',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
  '.idea',
  'target'
])

const MAX_OPEN_SIZE = 50 * 1024 * 1024
const MAX_SEARCH_FILE_SIZE = 2 * 1024 * 1024
const MAX_LIST_FILES = 60000
const MAX_SEARCH_MATCHES = 5000

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

function assertName(name: string): void {
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
    throw new Error(`Недопустимое имя: ${name}`)
  }
}

async function isDirEntry(dir: string, d: Dirent): Promise<boolean> {
  if (d.isDirectory()) return true
  if (!d.isSymbolicLink()) return false
  try {
    return (await fsp.stat(join(dir, d.name))).isDirectory()
  } catch {
    return false
  }
}

async function readDir(dir: string): Promise<DirEntry[]> {
  const dirents = await fsp.readdir(dir, { withFileTypes: true })
  const entries = await Promise.all(
    dirents
      .filter((d) => !HIDDEN.has(d.name))
      .map(async (d) => ({ name: d.name, path: join(dir, d.name), isDir: await isDirEntry(dir, d) }))
  )
  return entries.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : collator.compare(a.name, b.name)))
}

async function readFile(path: string): Promise<ReadFileResult> {
  try {
    const st = await fsp.stat(path)
    if (st.size > MAX_OPEN_SIZE) return { tooLarge: true }
    const buf = await fsp.readFile(path)
    if (isBinary(buf)) return { binary: true }
    return { content: buf.toString('utf8') }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

/** Breadth-first walk that skips heavy folders; yields absolute file paths. */
async function* walk(root: string): AsyncGenerator<string> {
  const queue = [root]
  while (queue.length) {
    const dir = queue.shift()!
    let dirents: Dirent[]
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of dirents) {
      if (HIDDEN.has(d.name)) continue
      const full = join(dir, d.name)
      if (d.isDirectory()) {
        if (!HEAVY_DIRS.has(d.name)) queue.push(full)
      } else if (d.isFile()) {
        yield full
      }
    }
  }
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = []
  for await (const f of walk(root)) {
    out.push(f)
    if (out.length >= MAX_LIST_FILES) break
  }
  return out
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Turns "*.ts, src/**" into matchers against the root-relative, slash-separated path. */
function buildIncludeFilter(include: string): ((rel: string) => boolean) | null {
  const parts = include
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!parts.length) return null
  const matchers = parts.map((p) => {
    const hasSlash = p.includes('/')
    const hasGlob = /[*?]/.test(p)
    if (!hasGlob) return (rel: string) => rel.includes(p)
    const re = new RegExp(
      '^' +
        p
          .split('**')
          .map((chunk) => chunk.split('*').map((c) => escapeRegExp(c).replace(/\\\?/g, '.')).join('[^/]*'))
          .join('.*') +
        '$'
    )
    return (rel: string) => re.test(hasSlash ? rel : rel.slice(rel.lastIndexOf('/') + 1))
  })
  return (rel) => matchers.some((m) => m(rel))
}

let searchGeneration = 0

async function search(root: string, query: string, opts: SearchOptions): Promise<SearchResult> {
  const generation = ++searchGeneration
  const result: SearchResult = { files: [], total: 0, truncated: false }
  if (!query) return result

  let re: RegExp
  try {
    let src = opts.regex ? query : escapeRegExp(query)
    if (opts.wholeWord) src = `\\b(?:${src})\\b`
    re = new RegExp(src, opts.caseSensitive ? 'g' : 'gi')
  } catch (err) {
    return { ...result, error: (err as Error).message }
  }
  const include = buildIncludeFilter(opts.include)

  for await (const file of walk(root)) {
    if (generation !== searchGeneration) return result // superseded by a newer query
    const rel = relative(root, file).split(sep).join('/')
    if (include && !include(rel)) continue
    let buf: Buffer
    try {
      const st = await fsp.stat(file)
      if (st.size > MAX_SEARCH_FILE_SIZE) continue
      buf = await fsp.readFile(file)
    } catch {
      continue
    }
    if (isBinary(buf)) continue
    const text = buf.toString('utf8')
    const fileResult: SearchFileResult = { path: file, matches: [] }
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(line))) {
        if (m[0].length === 0) {
          re.lastIndex++
          continue
        }
        const previewStart = Math.max(0, m.index - 40)
        fileResult.matches.push({
          line: i + 1,
          column: m.index + 1,
          length: m[0].length,
          preview: line.slice(previewStart, previewStart + 220),
          previewStart
        })
        result.total++
        if (result.total >= MAX_SEARCH_MATCHES) {
          result.truncated = true
          result.files.push(fileResult)
          return result
        }
      }
    }
    if (fileResult.matches.length) result.files.push(fileResult)
  }
  return result
}

async function gitBranch(root: string): Promise<string | null> {
  try {
    const head = (await fsp.readFile(join(root, '.git', 'HEAD'), 'utf8')).trim()
    const m = /^ref: refs\/heads\/(.+)$/.exec(head)
    return m ? m[1] : head.slice(0, 7)
  } catch {
    return null
  }
}

let watcher: FSWatcher | null = null
let pending = new Set<string>()
let flushTimer: NodeJS.Timeout | null = null

function startWatching(root: string | null, getWindow: () => BrowserWindow | null): void {
  watcher?.close()
  watcher = null
  if (!root) return
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return
      const rel = filename.toString()
      const first = rel.split(/[\\/]/)[0]
      if (first === '.git' || HEAVY_DIRS.has(first)) return
      pending.add(join(root, rel))
      if (flushTimer) return
      flushTimer = setTimeout(() => {
        flushTimer = null
        const paths = [...pending]
        pending = new Set()
        getWindow()?.webContents.send('fs:changed', paths)
      }, 150)
    })
    watcher.on('error', () => {
      watcher?.close()
      watcher = null
    })
  } catch {
    watcher = null
  }
}

export function registerFsHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('fs:readDir', (_e, dir: string) => readDir(dir))
  ipcMain.handle('fs:readFile', (_e, path: string) => readFile(path))
  ipcMain.handle('fs:writeFile', (_e, path: string, content: string) => fsp.writeFile(path, content, 'utf8'))
  ipcMain.handle('fs:stat', async (_e, path: string) => {
    try {
      return { isDir: (await fsp.stat(path)).isDirectory() }
    } catch {
      return null
    }
  })
  ipcMain.handle('fs:createFile', async (_e, dir: string, name: string) => {
    assertName(name)
    const p = join(dir, name)
    await fsp.writeFile(p, '', { flag: 'wx' })
    return p
  })
  ipcMain.handle('fs:createDir', async (_e, dir: string, name: string) => {
    assertName(name)
    const p = join(dir, name)
    await fsp.mkdir(p)
    return p
  })
  ipcMain.handle('fs:rename', async (_e, path: string, newName: string) => {
    assertName(newName)
    const target = join(dirname(path), newName)
    if (target !== path) {
      const exists = await fsp.stat(target).then(
        () => true,
        () => false
      )
      if (exists && target.toLowerCase() !== path.toLowerCase()) {
        throw new Error(`«${newName}» уже существует`)
      }
      await fsp.rename(path, target)
    }
    return target
  })
  ipcMain.handle('fs:remove', async (_e, path: string) => {
    try {
      await shell.trashItem(path)
    } catch {
      await fsp.rm(path, { recursive: true, force: true })
    }
  })
  ipcMain.handle('fs:listFiles', (_e, root: string) => listFiles(root))
  ipcMain.handle('fs:search', (_e, root: string, query: string, opts: SearchOptions) =>
    search(root, query, opts)
  )
  ipcMain.handle('fs:gitBranch', (_e, root: string) => gitBranch(root))
  ipcMain.on('fs:watch', (_e, root: string | null) => startWatching(root, getWindow))
}
