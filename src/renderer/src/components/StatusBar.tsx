import { useStore } from '../store'
import * as a from '../actions'
import { languageName } from '../editorService'
import { THEMES } from '../themes'
import { basename } from '../lib/path'
import { IconBranch, IconFolder } from './Icons'

export function StatusBar() {
  const root = useStore((s) => s.root)
  const branch = useStore((s) => s.branch)
  const active = useStore((s) => s.active)
  const cursor = useStore((s) => s.cursor)
  const language = useStore((s) => s.language)
  const eol = useStore((s) => s.eol)
  const tabSize = useStore((s) => s.settings.tabSize)
  const theme = useStore((s) => s.settings.theme)
  const dirtyCount = useStore((s) => s.tabs.filter((t) => t.dirty).length)

  return (
    <footer className="statusbar">
      <div className="sb-left">
        <span className="sb-accent" />
        {root ? (
          <button className="sb-item" onClick={() => a.focusSidebar('explorer')} title={root}>
            <IconFolder size={13} />
            {basename(root)}
          </button>
        ) : (
          <button className="sb-item" onClick={() => a.openFolder()}>
            <IconFolder size={13} />
            Открыть папку
          </button>
        )}
        {branch && (
          <span className="sb-item">
            <IconBranch size={13} />
            {branch}
          </span>
        )}
        {dirtyCount > 0 && <span className="sb-item sb-dirty">● {dirtyCount} не сохранено</span>}
      </div>
      <div className="sb-right">
        {active && (
          <>
            <button className="sb-item" onClick={() => a.openQuick(':')}>
              Стр {cursor.line}, Кол {cursor.column}
              {cursor.selected > 0 && ` (выделено ${cursor.selected})`}
            </button>
            <button className="sb-item" onClick={() => a.updateSettings({ tabSize: tabSize === 2 ? 4 : 2 })}>
              Пробелы: {tabSize}
            </button>
            <span className="sb-item">UTF-8</span>
            <span className="sb-item">{eol}</span>
            <button className="sb-item" onClick={() => a.pickLanguage()}>
              {languageName(language)}
            </button>
          </>
        )}
        <button className="sb-item" onClick={() => a.pickTheme()}>
          {THEMES[theme]?.name}
        </button>
      </div>
    </footer>
  )
}
