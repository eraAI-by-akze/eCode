import { useStore, type SidebarView } from '../store'
import * as a from '../actions'
import { formatKeys } from '../commands'
import { IconFiles, IconGit, IconPalette, IconPuzzle, IconSearch, IconSettings, IconSparkle, IconTerminal } from './Icons'

const ITEMS: { view: SidebarView; title: string; keys: string; Icon: typeof IconFiles }[] = [
  { view: 'explorer', title: 'Проводник', keys: 'mod+shift+e', Icon: IconFiles },
  { view: 'search', title: 'Поиск', keys: 'mod+shift+f', Icon: IconSearch },
  { view: 'scm', title: 'Git', keys: 'ctrl+shift+g', Icon: IconGit },
  { view: 'ai', title: 'eraAI', keys: 'mod+shift+a', Icon: IconSparkle },
  { view: 'plugins', title: 'Плагины', keys: 'mod+shift+x', Icon: IconPuzzle }
]

// Matches .activitybar padding (4px), item height (40px) and gap (4px).
const ITEM_STEP = 44
const ITEM_TOP = 4

export function ActivityBar() {
  const sidebar = useStore((s) => s.sidebar)
  const panelOpen = useStore((s) => s.panelOpen)
  const changes = useStore((s) => s.git?.files.length ?? 0)
  const aiState = useStore((s) => s.ai.state)
  const aiBusy = useStore((s) => !!s.aiBusy)
  const index = ITEMS.findIndex((i) => i.view === sidebar)

  return (
    <aside className="activitybar">
      {/* One indicator that glides between items instead of jumping. */}
      <span
        className={`ab-indicator ${index < 0 ? 'hidden' : ''}`}
        style={{ transform: `translateY(${ITEM_TOP + Math.max(0, index) * ITEM_STEP + 10}px)` }}
      />
      {ITEMS.map(({ view, title, keys, Icon }) => (
        <button
          key={view}
          className={`ab-item ${sidebar === view ? 'active slid' : ''}`}
          title={`${title} (${formatKeys([keys])})`}
          onClick={() => a.showSidebar(view)}
        >
          <Icon size={22} />
          {view === 'scm' && changes > 0 && <span className="ab-badge">{changes > 99 ? '99+' : changes}</span>}
          {view === 'ai' && aiState === 'ready' && <span className={`ab-live ${aiBusy ? 'busy' : ''}`} />}
        </button>
      ))}
      <button
        className={`ab-item ${panelOpen ? 'toggled' : ''}`}
        title={`Терминал (${formatKeys(['mod+j'])})`}
        onClick={() => a.togglePanel()}
      >
        <IconTerminal size={22} />
      </button>
      <div className="ab-spacer" />
      <button className="ab-item" title="Тема" onClick={() => a.pickTheme()}>
        <IconPalette size={22} />
      </button>
      <button
        className={`ab-item ${sidebar === 'settings' ? 'active' : ''}`}
        title={`Настройки (${formatKeys(['mod+,'])})`}
        onClick={() => a.showSidebar('settings')}
      >
        <IconSettings size={22} />
      </button>
    </aside>
  )
}
