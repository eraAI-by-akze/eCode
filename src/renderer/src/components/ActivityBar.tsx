import { useStore, type SidebarView } from '../store'
import * as a from '../actions'
import { formatKeys } from '../commands'
import { IconFiles, IconGit, IconPalette, IconSearch, IconSettings, IconSparkle, IconTerminal } from './Icons'

const ITEMS: { view: SidebarView; title: string; keys: string; Icon: typeof IconFiles }[] = [
  { view: 'explorer', title: 'Проводник', keys: 'mod+shift+e', Icon: IconFiles },
  { view: 'search', title: 'Поиск', keys: 'mod+shift+f', Icon: IconSearch },
  { view: 'scm', title: 'Git', keys: 'ctrl+shift+g', Icon: IconGit },
  { view: 'ai', title: 'eraAI', keys: 'mod+shift+a', Icon: IconSparkle }
]

export function ActivityBar() {
  const sidebar = useStore((s) => s.sidebar)
  const panelOpen = useStore((s) => s.panelOpen)
  const changes = useStore((s) => s.git?.files.length ?? 0)
  const aiState = useStore((s) => s.ai.state)
  const aiBusy = useStore((s) => !!s.aiBusy)

  return (
    <aside className="activitybar">
      {ITEMS.map(({ view, title, keys, Icon }) => (
        <button
          key={view}
          className={`ab-item ${sidebar === view ? 'active' : ''}`}
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
