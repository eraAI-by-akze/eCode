import { useStore } from '../store'
import { Explorer } from './Explorer'
import { SearchView } from './SearchView'
import { SettingsView } from './SettingsView'
import { ScmView } from './ScmView'

const TITLES = { explorer: 'Проводник', search: 'Поиск', scm: 'Система контроля версий', settings: 'Настройки' } as const

export function Sidebar() {
  const view = useStore((s) => s.sidebar)
  if (!view) return null
  return (
    <section className="sidebar glass">
      <div className="sidebar-title">{TITLES[view]}</div>
      <div className="sidebar-body">
        {view === 'explorer' && <Explorer />}
        {view === 'search' && <SearchView />}
        {view === 'scm' && <ScmView />}
        {view === 'settings' && <SettingsView />}
      </div>
    </section>
  )
}
