import * as ed from './editorService'
import { getState } from './store'
import { getFileIndex, loadDir, openFile, save } from './actions'
import { refreshGit } from './scm'
import { basename, dirname, isInside, relative } from './lib/path'

/**
 * Tools the eraCore agent may call. Reads are free; edits produce a preview
 * that the user approves (unless auto-apply is on), then go through the
 * editor model so they show up in tabs and can be undone with Ctrl+Z.
 */

const api = window.ecode
const MAX_READ_LINES = 400
const MAX_LIST = 300
const MAX_MATCHES = 60
const PREVIEW_LINES = 40

export interface Preview {
  path: string
  startLine: number
  oldLines: string[]
  newLines: string[]
  isNew: boolean
}

export interface ToolRun {
  summary: string
  /** Present for edits: shown to the user before `apply` runs. */
  preview?: Preview
  /** Read-only tools return their result directly. */
  result?: string
  apply?: () => Promise<string>
}

export class ToolError extends Error {}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new ToolError(`Аргумент "${name}" должен быть строкой`)
  return v
}
const int = (v: unknown, name: string, fallback?: number): number => {
  if (v === undefined || v === null || v === '') {
    if (fallback !== undefined) return fallback
    throw new ToolError(`Нужен аргумент "${name}"`)
  }
  const n = typeof v === 'number' ? v : parseInt(String(v), 10)
  if (!Number.isFinite(n)) throw new ToolError(`Аргумент "${name}" должен быть числом`)
  return Math.trunc(n)
}

/** Resolve a project-relative path; refuse anything outside the open folder. */
function resolve(p: unknown): string {
  const root = getState().root
  if (!root) throw new ToolError('Папка проекта не открыта')
  const raw = str(p ?? '', 'path').trim().replace(/^\.\/+/, '')
  const sep = window.ecode.pathSep
  const isAbs = raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw)
  const parts = (isAbs ? raw : `${root}${sep}${raw}`).split(/[\\/]+/)
  const out: string[] = []
  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  const prefix = window.ecode.platform === 'win32' ? '' : '/'
  const abs = prefix + out.join(sep)
  if (!isInside(root, abs)) throw new ToolError(`Путь вне проекта: ${raw}`)
  return abs
}

async function readText(abs: string): Promise<string | null> {
  if (ed.hasModel(abs)) return ed.getContent(abs)
  const r = await api.readFile(abs)
  if (r.content !== undefined) return r.content
  if (r.binary) throw new ToolError('Это бинарный файл')
  if (r.tooLarge) throw new ToolError('Файл слишком большой')
  return null // missing
}

const splitLines = (text: string): string[] => text.split(/\r?\n/)
const clip = (lines: string[]): string[] =>
  lines.length > PREVIEW_LINES ? [...lines.slice(0, PREVIEW_LINES), `… ещё ${lines.length - PREVIEW_LINES} строк`] : lines

function globToRegExp(glob: string): RegExp {
  const src = glob
    .split('**')
    .map((part) => part.split('*').map((c) => c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
    .join('.*')
  return new RegExp(`^${src}$`, 'i')
}

/** Write `next` into the file via its editor model (opening it in a background tab) and save. */
async function commit(abs: string, next: string, isNew: boolean): Promise<string> {
  const rel = relative(getState().root, abs)
  if (isNew) {
    await ensureDir(dirname(abs))
    await api.writeFile(abs, next)
    await loadDir(dirname(abs))
    await openFile(abs, { background: true, silent: true })
    refreshGit(200)
    return `Создан файл ${rel} (${splitLines(next).length} строк)`
  }
  await openFile(abs, { background: true, silent: true })
  const changed = ed.applyText(abs, next)
  if (!changed) throw new ToolError(`Не удалось открыть ${rel} для правки`)
  await save(abs)
  ed.flashLines(abs, changed.startLine, changed.endLine)
  return `Изменён ${rel}: строки ${changed.startLine}–${changed.endLine}. Файл сохранён.`
}

async function ensureDir(dir: string): Promise<void> {
  const root = getState().root!
  if (dir === root || (await api.stat(dir))?.isDir) return
  await ensureDir(dirname(dir))
  await api.createDir(dirname(dir), basename(dir))
}

export async function prepareTool(name: string, args: Record<string, unknown>): Promise<ToolRun> {
  const root = getState().root
  switch (name) {
    case 'list_files': {
      const base = args.path ? relative(root, resolve(args.path)) : ''
      const pattern = typeof args.pattern === 'string' && args.pattern ? globToRegExp(args.pattern) : null
      const files = (await getFileIndex())
        .map((f) => relative(root, f))
        .filter((rel) => !base || rel === base || rel.startsWith(base + '/'))
        .filter((rel) => !pattern || pattern.test(rel) || pattern.test(basename(rel)))
      const shown = files.slice(0, MAX_LIST)
      return {
        summary: `Список файлов${base ? ` в ${base}` : ''}: ${files.length}`,
        result: shown.join('\n') + (files.length > shown.length ? `\n… и ещё ${files.length - shown.length}` : '') || '(пусто)'
      }
    }

    case 'read_file': {
      const abs = resolve(args.path)
      const text = await readText(abs)
      if (text === null) throw new ToolError(`Файл не найден: ${relative(root, abs)}`)
      const lines = splitLines(text)
      const start = Math.max(1, int(args.start_line, 'start_line', 1))
      const end = Math.min(lines.length, int(args.end_line, 'end_line', start + MAX_READ_LINES - 1), start + MAX_READ_LINES - 1)
      const width = String(end).length
      const body = lines
        .slice(start - 1, end)
        .map((l, i) => `${String(start + i).padStart(width)}| ${l}`)
        .join('\n')
      const rel = relative(root, abs)
      return {
        summary: `Прочитан ${rel} (${start}–${end})`,
        result: `${rel}, строки ${start}–${end} из ${lines.length}:\n${body}` + (end < lines.length ? '\n…' : '')
      }
    }

    case 'search': {
      const query = str(args.query, 'query')
      if (!root) throw new ToolError('Папка проекта не открыта')
      const r = await api.search(root, query, { caseSensitive: false, regex: false, wholeWord: false, include: '' })
      const rows: string[] = []
      for (const f of r.files) {
        for (const m of f.matches) {
          if (rows.length >= MAX_MATCHES) break
          rows.push(`${relative(root, f.path)}:${m.line}: ${m.preview.trim()}`)
        }
      }
      return { summary: `Поиск «${query}»: ${r.total}`, result: rows.join('\n') || 'Ничего не найдено' }
    }

    case 'replace_lines':
    case 'insert_lines':
    case 'replace_text':
    case 'write_file':
      return prepareEdit(name, args)

    default:
      throw new ToolError(`Неизвестный инструмент: ${name}`)
  }
}

async function prepareEdit(name: string, args: Record<string, unknown>): Promise<ToolRun> {
  const abs = resolve(args.path)
  const rel = relative(getState().root, abs)
  const current = await readText(abs)

  if (name === 'write_file') {
    const content = str(args.content, 'content')
    const isNew = current === null
    return {
      summary: isNew ? `Новый файл ${rel}` : `Перезапись ${rel}`,
      preview: { path: rel, startLine: 1, oldLines: isNew ? [] : clip(splitLines(current)), newLines: clip(splitLines(content)), isNew },
      apply: () => commit(abs, content, isNew)
    }
  }

  if (current === null) throw new ToolError(`Файл не найден: ${rel}. Для нового файла используй write_file.`)
  const lines = splitLines(current)

  if (name === 'replace_text') {
    const oldText = str(args.old, 'old')
    const newText = str(args.new, 'new')
    if (!oldText) throw new ToolError('"old" не может быть пустым')
    // Models often send \n while the file uses \r\n; match on normalized text.
    const normalized = current.replace(/\r\n/g, '\n')
    const needle = oldText.replace(/\r\n/g, '\n')
    const first = normalized.indexOf(needle)
    if (first < 0) throw new ToolError(`Фрагмент не найден в ${rel}. Прочитай файл и повтори с точным текстом.`)
    if (normalized.indexOf(needle, first + 1) >= 0)
      throw new ToolError(`Фрагмент встречается в ${rel} несколько раз. Добавь в "old" больше контекста.`)
    const next = normalized.slice(0, first) + newText.replace(/\r\n/g, '\n') + normalized.slice(first + needle.length)
    const startLine = normalized.slice(0, first).split('\n').length
    return {
      summary: `Правка в ${rel}, строка ${startLine}`,
      preview: { path: rel, startLine, oldLines: clip(needle.split('\n')), newLines: clip(newText.split(/\r?\n/)), isNew: false },
      apply: () => commit(abs, next, false)
    }
  }

  const text = typeof args.text === 'string' ? args.text : ''
  const insert = text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')

  if (name === 'insert_lines') {
    const after = int(args.after_line, 'after_line')
    if (after < 0 || after > lines.length) throw new ToolError(`after_line вне файла (0–${lines.length})`)
    const next = [...lines.slice(0, after), ...insert, ...lines.slice(after)].join('\n')
    return {
      summary: `Вставка в ${rel} после строки ${after}`,
      preview: { path: rel, startLine: after + 1, oldLines: [], newLines: clip(insert), isNew: false },
      apply: () => commit(abs, next, false)
    }
  }

  // replace_lines
  const start = int(args.start_line, 'start_line')
  const end = int(args.end_line, 'end_line', start)
  if (start < 1 || end < start || end > lines.length)
    throw new ToolError(`Диапазон ${start}–${end} вне файла (1–${lines.length})`)
  const next = [...lines.slice(0, start - 1), ...insert, ...lines.slice(end)].join('\n')
  return {
    summary: `Замена строк ${start}–${end} в ${rel}`,
    preview: { path: rel, startLine: start, oldLines: clip(lines.slice(start - 1, end)), newLines: clip(insert), isNew: false },
    apply: () => commit(abs, next, false)
  }
}
