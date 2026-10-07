import { useEffect, useRef, useState } from 'react'
import type { SearchOptions, SearchResult } from '@shared/types'
import { useStore } from '../store'
import * as a from '../actions'
import { basename, dirname, relative } from '../lib/path'
import { FileIcon, IconCase, IconChevron, IconRegex, IconWord } from './Icons'

const api = window.ecode

export function SearchView() {
  const root = useStore((s) => s.root)
  const [query, setQuery] = useState('')
  const [opts, setOpts] = useState<SearchOptions>({ caseSensitive: false, regex: false, wholeWord: false, include: '' })
  const [result, setResult] = useState<SearchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    if (!root || !query) {
      setResult(null)
      return
    }
    let cancelled = false
    const t = setTimeout(async () => {
      setBusy(true)
      const r = await api.search(root, query, opts)
      if (!cancelled) {
        setResult(r)
        setBusy(false)
      }
    }, 220)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [root, query, opts])

  const toggle = (k: 'caseSensitive' | 'regex' | 'wholeWord'): void => setOpts((o) => ({ ...o, [k]: !o[k] }))

  if (!root) {
    return (
      <div className="sidebar-empty">
        <p>Откройте папку, чтобы искать по файлам</p>
        <button className="btn-primary" onClick={() => a.openFolder()}>
          Открыть папку
        </button>
      </div>
    )
  }

  return (
    <div className="search-view">
      <div className="search-inputs">
        <div className="search-box">
          <input
            ref={inputRef}
            value={query}
            placeholder="Искать"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="search-toggles">
            <button className={opts.caseSensitive ? 'on' : ''} title="Учитывать регистр" onClick={() => toggle('caseSensitive')}>
              <IconCase size={15} />
            </button>
            <button className={opts.wholeWord ? 'on' : ''} title="Слово целиком" onClick={() => toggle('wholeWord')}>
              <IconWord size={15} />
            </button>
            <button className={opts.regex ? 'on' : ''} title="Регулярное выражение" onClick={() => toggle('regex')}>
              <IconRegex size={15} />
            </button>
          </div>
        </div>
        <input
          className="search-include"
          value={opts.include}
          placeholder="Файлы, например: *.ts, src/**"
          spellCheck={false}
          onChange={(e) => setOpts((o) => ({ ...o, include: e.target.value }))}
        />
      </div>

      <div className="search-summary">
        {busy && <span className="spinner" />}
        {result?.error ? (
          <span className="error">{result.error}</span>
        ) : result ? (
          <span>
            {result.total} {plural(result.total, 'совпадение', 'совпадения', 'совпадений')} в {result.files.length}{' '}
            {plural(result.files.length, 'файле', 'файлах', 'файлах')}
            {result.truncated && ' (показаны первые)'}
          </span>
        ) : null}
      </div>

      <div className="search-results">
        {result?.files.map((f) => {
          const rel = relative(root, f.path)
          const isCollapsed = collapsed[f.path]
          return (
            <div key={f.path} className="search-file">
              <div className="search-file-header" onClick={() => setCollapsed((c) => ({ ...c, [f.path]: !c[f.path] }))}>
                <IconChevron size={13} className={`chev ${isCollapsed ? '' : 'open'}`} />
                <FileIcon name={basename(f.path)} size={15} />
                <span className="search-file-name">{basename(f.path)}</span>
                <span className="search-file-dir">{dirname(rel) === rel ? '' : dirname(rel)}</span>
                <span className="badge">{f.matches.length}</span>
              </div>
              {!isCollapsed &&
                f.matches.slice(0, 200).map((m, i) => {
                  const s = m.column - 1 - m.previewStart
                  const pre = m.preview.slice(0, s).trimStart()
                  return (
                    <div
                      key={i}
                      className="search-match"
                      onClick={() => a.openFile(f.path, { line: m.line, column: m.column, length: m.length })}
                      title={`Строка ${m.line}`}
                    >
                      <span className="search-line">{m.line}</span>
                      <span className="search-preview">
                        {m.previewStart > 0 && '…'}
                        {pre}
                        <mark>{m.preview.slice(s, s + m.length)}</mark>
                        {m.preview.slice(s + m.length)}
                      </span>
                    </div>
                  )
                })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}
