import { ipcMain, shell } from 'electron'
import { execFile } from 'child_process'
import { promises as fsp } from 'fs'
import { join, relative, sep } from 'path'
import type { GitBranches, GitFile, GitStatus, GitSyncOp } from '../shared/types'

interface RunResult {
  stdout: string
  stderr: string
}

function run(cwd: string, args: string[], allowFail = false): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          // Never block on a credential prompt nobody can see.
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C'
        }
      },
      (err, stdout, stderr) => {
        if (err && !allowFail) {
          const msg = (stderr || err.message).trim().split('\n').slice(-6).join('\n')
          reject(new Error(msg || `git ${args[0]} failed`))
        } else {
          resolve({ stdout, stderr })
        }
      }
    )
  })
}

const toRel = (repo: string, p: string): string => relative(repo, p).split(sep).join('/')

async function repoRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await run(cwd, ['rev-parse', '--show-toplevel'])
    return join(stdout.trim()) // normalises separators on Windows
  } catch {
    return null
  }
}

async function hasHead(repo: string): Promise<boolean> {
  try {
    await run(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    return true
  } catch {
    return false
  }
}

async function status(cwd: string): Promise<GitStatus | null> {
  const repo = await repoRoot(cwd)
  if (!repo) return null
  const [{ stdout }, head] = await Promise.all([
    run(repo, ['status', '--porcelain=v1', '-z', '-b', '-uall', '--no-renames']),
    hasHead(repo)
  ])
  const parts = stdout.split('\0')
  const result: GitStatus = {
    repoRoot: repo,
    branch: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    hasHead: head,
    files: []
  }
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry) continue
    if (entry.startsWith('## ')) {
      const line = entry.slice(3)
      // "No commits yet on main", "HEAD (no branch)", "main...origin/main [ahead 1, behind 2]"
      const noCommits = /^No commits yet on (.+)$/.exec(line)
      if (noCommits) {
        result.branch = noCommits[1]
        continue
      }
      if (line.startsWith('HEAD (no branch)')) {
        result.detached = true
        continue
      }
      const m = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(line)
      if (m) {
        result.branch = m[1]
        result.upstream = m[2] ?? null
        const ahead = /ahead (\d+)/.exec(m[3] ?? '')
        const behind = /behind (\d+)/.exec(m[3] ?? '')
        result.ahead = ahead ? Number(ahead[1]) : 0
        result.behind = behind ? Number(behind[1]) : 0
      }
      continue
    }
    const x = entry[0]
    const y = entry[1]
    const rel = entry.slice(3)
    const file: GitFile = { path: join(repo, rel), rel, x, y }
    result.files.push(file)
  }
  if (result.detached) {
    const { stdout: sha } = await run(repo, ['rev-parse', '--short', 'HEAD'], true)
    result.branch = sha.trim() || null
  }
  return result
}

async function readHeadOrIndex(repo: string, spec: string): Promise<string> {
  try {
    return (await run(repo, ['show', spec])).stdout
  } catch {
    return '' // file doesn't exist at that revision (new / deleted)
  }
}

async function diffContents(repo: string, path: string, staged: boolean): Promise<{ original: string; modified: string }> {
  const rel = toRel(repo, path)
  if (staged) {
    const [original, modified] = await Promise.all([
      readHeadOrIndex(repo, `HEAD:${rel}`),
      readHeadOrIndex(repo, `:${rel}`)
    ])
    return { original, modified }
  }
  const [original, modified] = await Promise.all([
    readHeadOrIndex(repo, `:${rel}`),
    fsp.readFile(path, 'utf8').catch(() => '')
  ])
  return { original, modified }
}

async function branches(repo: string): Promise<GitBranches> {
  const [{ stdout: local }, { stdout: remote }, { stdout: current }] = await Promise.all([
    run(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], true),
    run(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], true),
    run(repo, ['branch', '--show-current'], true)
  ])
  const lines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter(Boolean)
  return {
    current: current.trim() || null,
    local: lines(local),
    remote: lines(remote).filter((r) => !r.endsWith('/HEAD'))
  }
}

async function sync(repo: string, op: GitSyncOp): Promise<string> {
  if (op === 'fetch') return (await run(repo, ['fetch', '--prune'])).stderr
  if (op === 'pull') return (await run(repo, ['pull', '--no-rebase'])).stdout
  // Publish the branch if it has no upstream yet.
  const { stdout } = await run(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], true)
  if (!stdout.trim()) {
    const { stdout: remotes } = await run(repo, ['remote'], true)
    const remote = remotes.split('\n').map((r) => r.trim()).filter(Boolean)[0]
    if (!remote) throw new Error('У репозитория нет remote. Добавьте его: git remote add origin <url>')
    return (await run(repo, ['push', '-u', remote, 'HEAD'])).stderr
  }
  return (await run(repo, ['push'])).stderr
}

export function registerGitHandlers(): void {
  ipcMain.handle('git:status', (_e, root: string) => status(root).catch(() => null))
  ipcMain.handle('git:init', async (_e, root: string) => {
    await run(root, ['init'])
  })
  ipcMain.handle('git:stage', async (_e, repo: string, paths: string[]) => {
    await run(repo, ['add', '-A', '--', ...paths.map((p) => toRel(repo, p))])
  })
  ipcMain.handle('git:unstage', async (_e, repo: string, paths: string[]) => {
    const rels = paths.map((p) => toRel(repo, p))
    if (await hasHead(repo)) await run(repo, ['reset', '-q', 'HEAD', '--', ...rels])
    else await run(repo, ['rm', '--cached', '-r', '-q', '--', ...rels])
  })
  ipcMain.handle('git:discard', async (_e, repo: string, tracked: string[], untracked: string[]) => {
    if (tracked.length) await run(repo, ['checkout', '--', ...tracked.map((p) => toRel(repo, p))])
    for (const p of untracked) {
      try {
        await shell.trashItem(p)
      } catch {
        await fsp.rm(p, { recursive: true, force: true })
      }
    }
  })
  ipcMain.handle('git:commit', async (_e, repo: string, message: string, all: boolean) => {
    if (all) await run(repo, ['add', '-A'])
    await run(repo, ['commit', '-m', message])
  })
  ipcMain.handle('git:diffContents', (_e, repo: string, path: string, staged: boolean) =>
    diffContents(repo, path, staged)
  )
  ipcMain.handle('git:branches', (_e, repo: string) => branches(repo))
  ipcMain.handle('git:checkout', async (_e, repo: string, ref: string, create: boolean) => {
    if (create) {
      await run(repo, ['checkout', '-b', ref])
      return
    }
    // "origin/feature" → local tracking branch "feature".
    const { stdout } = await run(repo, ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${ref}`], true)
    if (stdout.trim()) {
      const local = ref.slice(ref.indexOf('/') + 1)
      const exists = (await run(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${local}`], true)).stdout.trim()
      await run(repo, exists ? ['checkout', local] : ['checkout', '--track', ref])
      return
    }
    await run(repo, ['checkout', ref])
  })
  ipcMain.handle('git:sync', (_e, repo: string, op: GitSyncOp) => sync(repo, op))
}
