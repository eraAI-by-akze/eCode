import type { GitFile, GitSyncOp } from '@shared/types'
import * as ed from './editorService'
import { getState, setState } from './store'
import { openFile, pick, prompt, setActive, toast } from './actions'
import { basename } from './lib/path'

const api = window.ecode

// ─────────────────────────── classification ───────────────────────────

export const isConflict = (f: GitFile): boolean =>
  f.x === 'U' || f.y === 'U' || (f.x === 'A' && f.y === 'A') || (f.x === 'D' && f.y === 'D')
export const isUntracked = (f: GitFile): boolean => f.x === '?'
export const isStaged = (f: GitFile): boolean => !isConflict(f) && f.x !== ' ' && f.x !== '?' && f.x !== '!'
export const isChanged = (f: GitFile): boolean => !isConflict(f) && f.y !== ' ' && f.y !== '!'

export type Decoration = 'modified' | 'added' | 'untracked' | 'deleted' | 'conflict'

/** Single status letter VS Code-style; untracked shows as "U". */
export function letter(code: string): string {
  return code === '?' ? 'U' : code
}

export function decorationOfCode(code: string): Decoration {
  if (code === 'U') return 'conflict'
  if (code === '?') return 'untracked'
  if (code === 'D') return 'deleted'
  if (code === 'A') return 'added'
  return 'modified'
}

export function decorationOf(f: GitFile): Decoration {
  if (isConflict(f)) return 'conflict'
  if (isUntracked(f)) return 'untracked'
  if (f.x === 'D' || f.y === 'D') return 'deleted'
  if (f.x === 'A') return 'added'
  return 'modified'
}

// ─────────────────────────── refresh ───────────────────────────

let timer: ReturnType<typeof setTimeout> | null = null
let inflight: Promise<void> | null = null
let again = false

export function refreshGit(delay = 0): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void runRefresh()
  }, delay)
}

async function runRefresh(): Promise<void> {
  if (inflight) {
    again = true
    return inflight
  }
  const root = getState().root
  inflight = (async () => {
    const status = root ? await api.gitStatus(root) : null
    if (getState().root === root) setState({ git: status })
  })()
  try {
    await inflight
  } finally {
    inflight = null
    if (again) {
      again = false
      void runRefresh()
    }
  }
}

function repo(): string | null {
  return getState().git?.repoRoot ?? null
}

async function guarded(label: string, fn: () => Promise<unknown>): Promise<boolean> {
  setState({ gitBusy: label })
  try {
    await fn()
    return true
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
    toast(msg, 'error')
    return false
  } finally {
    setState({ gitBusy: null })
    refreshGit()
    void refreshOpenDiffs()
  }
}

// ─────────────────────────── operations ───────────────────────────

export async function initRepo(): Promise<void> {
  const root = getState().root
  if (!root) return
  if (await guarded('init', () => api.gitInit(root))) toast('Репозиторий создан', 'success')
}

export function stage(paths: string[]): Promise<boolean> {
  const r = repo()
  return r && paths.length ? guarded('stage', () => api.gitStage(r, paths)) : Promise.resolve(false)
}

export function unstage(paths: string[]): Promise<boolean> {
  const r = repo()
  return r && paths.length ? guarded('unstage', () => api.gitUnstage(r, paths)) : Promise.resolve(false)
}

export async function discard(files: GitFile[]): Promise<void> {
  const r = repo()
  if (!r || !files.length) return
  const untracked = files.filter(isUntracked)
  const tracked = files.filter((f) => !isUntracked(f))
  const what = files.length === 1 ? `«${basename(files[0].path)}»` : `${files.length} файлов`
  const detail = untracked.length
    ? 'Изменения будут потеряны, новые файлы уйдут в корзину.'
    : 'Изменения будут потеряны безвозвратно.'
  const choice = await api.confirm(`Отменить изменения в ${what}?`, detail, ['Отменить изменения', 'Отмена'])
  if (choice !== 0) return
  await guarded('discard', () =>
    api.gitDiscard(
      r,
      tracked.map((f) => f.path),
      untracked.map((f) => f.path)
    )
  )
}

export async function commit(): Promise<void> {
  const r = repo()
  const git = getState().git
  if (!r || !git) return
  const message = getState().commitMessage.trim()
  if (!message) {
    toast('Введите сообщение коммита')
    return
  }
  let all = false
  if (!git.files.some(isStaged)) {
    if (!git.files.length) {
      toast('Нет изменений для коммита')
      return
    }
    const choice = await api.confirm(
      'Нет проиндексированных изменений',
      'Проиндексировать все изменения и закоммитить их?',
      ['Да, все изменения', 'Отмена']
    )
    if (choice !== 0) return
    all = true
  }
  if (await guarded('commit', () => api.gitCommit(r, message, all))) {
    setState({ commitMessage: '' })
    toast('Коммит создан', 'success')
  }
}

const SYNC_LABEL: Record<GitSyncOp, string> = { push: 'Отправка', pull: 'Получение', fetch: 'Синхронизация' }

export async function sync(op: GitSyncOp): Promise<void> {
  const r = repo()
  if (!r) return
  if (await guarded(op, () => api.gitSync(r, op))) toast(`${SYNC_LABEL[op]}: готово`, 'success')
}

export async function pickBranch(): Promise<void> {
  const r = repo()
  if (!r) return
  const b = await api.gitBranches(r)
  const items = [
    { id: '\u0000new', label: '+ Создать ветку…' },
    ...b.local.map((name) => ({ id: name, label: name, hint: 'локальная', active: name === b.current })),
    ...b.remote.map((name) => ({ id: name, label: name, hint: 'remote' }))
  ]
  pick('Переключиться на ветку', items, (id) => {
    if (id === '\u0000new') {
      prompt('Имя новой ветки', 'Новая ветка будет создана от текущего коммита', (name) => {
        const clean = name.trim().replace(/\s+/g, '-')
        if (clean) void guarded('checkout', () => api.gitCheckout(r, clean, true))
      })
    } else if (id !== b.current) {
      void guarded('checkout', () => api.gitCheckout(r, id, false))
    }
  })
}

// ─────────────────────────── diffs ───────────────────────────

export const diffKey = (file: string, staged: boolean): string => `diff:${staged ? 'staged' : 'work'}:${file}`

export async function openDiff(file: GitFile, staged: boolean): Promise<void> {
  const r = repo()
  if (!r) return
  const { original, modified } = await api.gitDiffContents(r, file.path, staged)
  const key = diffKey(file.path, staged)
  ed.setDiff(key, file.path, original, modified)
  setState((s) =>
    s.tabs.some((t) => t.path === key)
      ? {}
      : {
          tabs: [
            ...s.tabs,
            {
              path: key,
              name: `${basename(file.path)} ${staged ? '(индекс)' : '(изменения)'}`,
              dirty: false,
              diff: { file: file.path, staged }
            }
          ]
        }
  )
  setActive(key, false)
}

/** Re-read every open diff tab, e.g. after staging changed what it compares. */
export async function refreshOpenDiffs(): Promise<void> {
  const r = repo()
  if (!r) return
  for (const t of getState().tabs) {
    if (!t.diff) continue
    const { original, modified } = await api.gitDiffContents(r, t.diff.file, t.diff.staged)
    ed.setDiff(t.path, t.diff.file, original, modified)
  }
}

export function openChangedFile(file: GitFile): void {
  if (file.y === 'D' || (file.x === 'D' && file.y === ' ')) {
    toast('Файл удалён')
    return
  }
  void openFile(file.path)
}
