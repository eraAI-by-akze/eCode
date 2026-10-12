import type { ProblemMatcherSpec } from '@shared/types'
import type { Diagnostic } from '../store'

/**
 * Turn compiler / linter output lines into diagnostics. Each matcher is a
 * regex with named groups: file, line, column?, severity?, code?, message.
 */

interface Matcher {
  re: RegExp
  severity?: Diagnostic['severity']
}

// A path may start with a Windows drive ("C:\…") — keep that colon out of the separators.
const FILE = String.raw`(?<file>(?:[A-Za-z]:)?[^:\s(][^:(]*?)`

const BUILTIN: Record<string, Matcher[]> = {
  // dotnet / MSBuild, also tsc: path(12,5): error CS0103: message [project]
  msbuild: [
    {
      re: new RegExp(
        String.raw`^\s*${FILE}\((?<line>\d+),(?<column>\d+)(?:,\d+,\d+)?\)\s*:\s*(?<severity>error|warning|info)\s+(?<code>[A-Z]+\d+)\s*:\s*(?<message>.*?)(?:\s+\[[^\]]+\])?\s*$`
      )
    }
  ],
  // rustc / cargo --message-format=short: src/main.rs:2:5: error[E0425]: message
  rustc: [
    {
      re: new RegExp(
        String.raw`^${FILE}:(?<line>\d+):(?<column>\d+): (?<severity>error|warning)(?:\[(?<code>[A-Za-z0-9_:]+)\])?: (?<message>.+)$`
      )
    }
  ],
  // gcc / clang: file:line:col: error: message
  gcc: [
    {
      re: new RegExp(String.raw`^${FILE}:(?<line>\d+):(?<column>\d+): (?<severity>fatal error|error|warning|note): (?<message>.+)$`)
    }
  ],
  python: [
    // ruff --output-format=concise: path:1:8: F401 [*] `os` imported but unused
    {
      re: new RegExp(String.raw`^${FILE}:(?<line>\d+):(?<column>\d+): (?<code>[A-Z]+\d+) (?:\[\*\] )?(?<message>.+)$`),
      severity: 'warning'
    },
    // mypy --show-column-numbers: path:5:12: error: message  [code]
    {
      re: new RegExp(
        String.raw`^${FILE}:(?<line>\d+)(?::(?<column>\d+))?: (?<severity>error|warning|note): (?<message>.+?)(?:\s+\[(?<code>[\w-]+)\])?$`
      )
    },
    // pytest --tb=short: path.py:12: in test_x / AssertionError
    { re: new RegExp(String.raw`^${FILE}\.py:(?<line>\d+): (?<message>.+)$`), severity: 'error' }
  ]
}
BUILTIN.tsc = BUILTIN.msbuild

// "  File "x.py", line 3, in <module>" … "ValueError: boom"
const TRACEBACK_FRAME = /^\s*File "(?<file>[^"]+)", line (?<line>\d+)/
const TRACEBACK_ERROR = /^(?<code>[A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt)): ?(?<message>.*)$/

function compile(spec: string | ProblemMatcherSpec): Matcher[] {
  if (typeof spec === 'string') return BUILTIN[spec] ?? []
  try {
    return [{ re: new RegExp(spec.regexp), severity: spec.severity }]
  } catch {
    return []
  }
}

export interface RawProblem extends Omit<Diagnostic, 'endLine' | 'endColumn'> {
  file: string
}

function severityOf(raw: string | undefined, fallback: Diagnostic['severity'] = 'error'): Diagnostic['severity'] {
  if (!raw) return fallback
  if (raw.includes('error')) return 'error'
  if (raw.startsWith('warn')) return 'warning'
  return 'info'
}

/** Stateful line parser (Python tracebacks span several lines). */
export class ProblemParser {
  private matchers: Matcher[]
  private python: boolean
  private frame: { file: string; line: number } | null = null
  readonly problems: RawProblem[] = []

  constructor(specs: (string | ProblemMatcherSpec)[], private source: string) {
    this.matchers = specs.flatMap(compile)
    this.python = specs.includes('python')
  }

  /** Parse one line; returns the problem it produced, if any. */
  push(line: string): RawProblem | null {
    if (this.python) {
      const f = TRACEBACK_FRAME.exec(line)
      if (f?.groups) {
        this.frame = { file: f.groups.file, line: Number(f.groups.line) }
        return null
      }
      const e = this.frame && TRACEBACK_ERROR.exec(line.trim())
      if (e?.groups && this.frame) {
        const p: RawProblem = {
          file: this.frame.file,
          line: this.frame.line,
          column: 1,
          severity: 'error',
          code: e.groups.code,
          message: `${e.groups.code}: ${e.groups.message}`,
          source: this.source
        }
        this.frame = null
        this.problems.push(p)
        return p
      }
    }
    for (const m of this.matchers) {
      const g = m.re.exec(line)?.groups
      if (!g?.file || !g.line) continue
      const p: RawProblem = {
        file: g.file.trim(),
        line: Number(g.line),
        column: g.column ? Number(g.column) : 1,
        severity: m.severity ?? severityOf(g.severity),
        code: g.code,
        message: (g.message ?? line).trim(),
        source: this.source
      }
      this.problems.push(p)
      return p
    }
    return null
  }
}
