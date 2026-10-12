import { useStore } from '../store'
import { Explorer } from './Explorer'
import { SearchView } from './SearchView'
import { SettingsView } from './SettingsView'
import { ScmView } from './ScmView'
import { AiView } from './AiView'
import { PluginsView } from './PluginsView'

const TITLES = { explorer: 'Проводник', search: 'Поиск', scm: 'Система контроля версий', ai: 'eraAI', plugins: 'Плагины', settings: 'Настройки' } as const

export function Sidebar() {
  const view = useStore((s) => s.sidebar)
  if (!view) return null
  return (
    <section className="sidebar glass">
      <div className="sidebar-title">{TITLES[view]}</div>
      {/* Keyed by view so each switch replays the enter animation. */}
      <div className="sidebar-body view-enter" key={view}>
        {view === 'explorer' && <Explorer />}
        {view === 'search' && <SearchView />}
        {view === 'scm' && <ScmView />}
        {view === 'ai' && <AiView />}
        {view === 'plugins' && <PluginsView />}
        {view === 'settings' && <SettingsView />}
      </div>
    </section>
  )
}
