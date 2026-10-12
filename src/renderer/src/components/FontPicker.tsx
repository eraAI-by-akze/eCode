import { useMemo, useState } from 'react'
import { useStore } from '../store'
import * as a from '../actions'
import { detectAutoFont, isMonospace, isNerd, listInstalledFonts } from '../fontService'

// Code plus a few Nerd Font glyphs (folder, git branch, Python, Rust) to show icon support.
const PREVIEW = 'fn main() { let x = 0O1lI; }    '

export function FontPicker() {
  const font = useStore((s) => s.settings.editorFont)
  const auto = useStore((s) => s.autoFont)
  const [fonts, setFonts] = useState<string[] | null>(null)
  const [query, setQuery] = useState('')
  const [monoOnly, setMonoOnly] = useState(true)
  const [open, setOpen] = useState(false)

  const load = async (): Promise<void> => {
    setOpen(true)
    if (!fonts) setFonts(await listInstalledFonts())
  }

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (fonts ?? [])
      .filter((f) => !q || f.toLowerCase().includes(q))
      .filter((f) => !monoOnly || isNerd(f) || isMonospace(f))
      .slice(0, 300)
  }, [fonts, query, monoOnly])

  const current = font || auto
  return (
    <div className="font-picker">
      <button className="font-current" onClick={() => (open ? setOpen(false) : void load())}>
        <span className="font-name" style={{ fontFamily: current ? `"${current}", monospace` : undefined }}>
          {font ? font : auto ? `Авто: ${auto}` : 'Авто: Nerd Font не найден'}
        </span>
        <span className="font-sample" style={{ fontFamily: current ? `"${current}", monospace` : 'monospace' }}>
          {PREVIEW}
        </span>
      </button>
      {open && (
        <div className="font-menu">
          <input placeholder="Поиск шрифта…" value={query} autoFocus spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
          <label className="ai-check small">
            <input type="checkbox" checked={monoOnly} onChange={(e) => setMonoOnly(e.target.checked)} />
            только моноширинные и Nerd Fonts
          </label>
          <div className="font-list">
            <button
              className={`font-option ${!font ? 'on' : ''}`}
              onClick={async () => {
                await detectAutoFont()
                a.updateSettings({ editorFont: '' })
                setOpen(false)
              }}
            >
              <strong>Авто</strong>
              <small>{auto ? `найден ${auto}` : 'первый найденный Nerd Font'}</small>
            </button>
            {!fonts && <div className="palette-empty">Ищу шрифты…</div>}
            {shown.map((f) => (
              <button
                key={f}
                className={`font-option ${font === f ? 'on' : ''}`}
                style={{ fontFamily: `"${f}", monospace` }}
                onClick={() => {
                  a.updateSettings({ editorFont: f })
                  setOpen(false)
                }}
              >
                <strong>{f}</strong>
                {isNerd(f) && <em>Nerd Font</em>}
              </button>
            ))}
            {fonts && !shown.length && <div className="palette-empty">Ничего не найдено</div>}
          </div>
          <p className="settings-hint">
            Nerd Fonts добавляют иконки для терминала и промптов (starship, oh-my-posh). Скачать:{' '}
            <button className="ai-link" onClick={() => window.ecode.openExternal('https://www.nerdfonts.com/font-downloads')}>
              nerdfonts.com
            </button>
          </p>
        </div>
      )}
    </div>
  )
}
