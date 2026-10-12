import { execFileSync } from 'child_process'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import { existsSync } from 'fs'

/**
 * Apps started from Finder / a desktop launcher get a minimal PATH
 * (/usr/bin:/bin…), so Homebrew's node/python, cargo, dotnet and friends are
 * invisible. Ask the user's login shell for its PATH once at startup, the way
 * VS Code does, and add the usual tool folders as a fallback.
 */
export function fixPath(): void {
  if (process.platform === 'win32') return
  const current = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  let fromShell: string[] = []
  try {
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    const out = execFileSync(shell, ['-ilc', 'printf "__ECODE_PATH__%s__ECODE_PATH__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const m = /__ECODE_PATH__(.*)__ECODE_PATH__/.exec(out)
    if (m) fromShell = m[1].split(delimiter).filter(Boolean)
  } catch {
    // A broken shell rc shouldn't stop the app; fall back to the defaults below.
  }
  const home = homedir()
  const extra = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.cargo', 'bin'),
    join(home, '.dotnet', 'tools'),
    '/usr/local/share/dotnet',
    join(home, '.dotnet'),
    join(home, '.local', 'bin')
  ].filter((d) => existsSync(d))
  process.env.PATH = [...new Set([...fromShell, ...current, ...extra])].join(delimiter)
}
