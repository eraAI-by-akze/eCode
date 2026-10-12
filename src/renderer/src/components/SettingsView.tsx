import { useStore } from '../store'
import * as a from '../actions'
import { THEME_LIST } from '../themes'

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`toggle ${value ? 'on' : ''}`} role="switch" aria-checked={value} onClick={() => onChange(!value)}>
      <span />
    </button>
  )
}

export function SettingsView() {
  const s = useStore((st) => st.settings)

  return (
    <div className="settings-view">
      <div className="section-label">Тема оформления</div>
      <div className="theme-cards">
        {THEME_LIST.map((t) => (
          <button
            key={t.id}
            className={`theme-card ${s.theme === t.id ? 'active' : ''}`}
            onClick={() => a.updateSettings({ theme: t.id })}
          >
            <div
              className="theme-preview"
              style={{
                background: `radial-gradient(circle at 20% 10%, ${t.vars['--bg-glow-1']}, transparent 60%), radial-gradient(circle at 90% 90%, ${t.vars['--bg-glow-2']}, transparent 60%), ${t.vars['--bg']}`
              }}
            >
              <div className="tp-side" style={{ background: t.vars['--surface'], borderColor: t.vars['--border'] }} />
              <div className="tp-main" style={{ background: t.vars['--editor-bg'], borderColor: t.vars['--border'] }}>
                <span style={{ background: t.vars['--accent'], width: '46%' }} />
                <span style={{ background: t.vars['--text-muted'], width: '70%' }} />
                <span style={{ background: t.vars['--accent-2'], width: '38%' }} />
                <span style={{ background: t.vars['--text-faint'], width: '58%' }} />
              </div>
              <div className="tp-status" style={{ background: t.vars['--accent-gradient'] }} />
            </div>
            <div className="theme-meta">
              <strong>{t.name}</strong>
              <small>{t.tagline}</small>
            </div>
          </button>
        ))}
      </div>

      <div className="section-label">Редактор</div>
      <div className="setting-row">
        <label>Размер шрифта</label>
        <div className="stepper">
          <button onClick={() => a.zoom(-1)}>−</button>
          <span>{s.fontSize}</span>
          <button onClick={() => a.zoom(1)}>+</button>
        </div>
      </div>
      <div className="setting-row">
        <label>Размер табуляции</label>
        <div className="segmented">
          {[2, 4, 8].map((n) => (
            <button key={n} className={s.tabSize === n ? 'on' : ''} onClick={() => a.updateSettings({ tabSize: n })}>
              {n}
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <label>Перенос строк</label>
        <Toggle value={s.wordWrap} onChange={(v) => a.updateSettings({ wordWrap: v })} />
      </div>
      <div className="setting-row">
        <label>Мини-карта</label>
        <Toggle value={s.minimap} onChange={(v) => a.updateSettings({ minimap: v })} />
      </div>
      <div className="setting-row">
        <label>Лигатуры шрифта</label>
        <Toggle value={s.fontLigatures} onChange={(v) => a.updateSettings({ fontLigatures: v })} />
      </div>

      <p className="settings-hint">
        Настройки сохраняются автоматически. Шрифт: JetBrains Mono / Fira Code, если они установлены в системе.
      </p>
    </div>
  )
}
