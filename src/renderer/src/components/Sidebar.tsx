import { useStore } from '../store'
import { Explorer } from './Explorer'
import { SearchView } from './SearchView'
import { SettingsView } from './SettingsView'
import { ScmView } from './ScmView'
import { AiView } from './AiView'
import { PluginsView } from './PluginsView'
import { DebugView } from './DebugView'
import { ExtensionsView } from './ExtensionsView'
import { useState } from 'react'

const TITLES = { explorer: 'Проводник', search: 'Поиск', scm: 'Система контроля версий', debug: 'Запуск и отладка', extensions: 'Расширения', ai: 'eraAI', plugins: 'Расширения', settings: 'Настройки' } as const

type HubTab = 'extensions' | 'plugins'

function readTab(): HubTab {
  try {
    return localStorage.getItem('ecode.extTab') === 'plugins' ? 'plugins' : 'extensions'
  } catch {
    return 'extensions'
  }
}

/** VS Code extensions and eCode's own plugins share one view. */
function ExtensionsHub() {
  const [tab, setTab] = useState<HubTab>(readTab)
  const choose = (t: HubTab): void => {
    setTab(t)
    try {
      localStorage.setItem('ecode.extTab', t)
    } catch {
      // ignore
    }
  }
  return (
    <div className="ext-hub">
      <div className="ext-hub-tabs">
        <button className={tab === 'extensions' ? 'active' : ''} onClick={() => choose('extensions')}>
          VS Code
        </button>
        <button className={tab === 'plugins' ? 'active' : ''} onClick={() => choose('plugins')}>
          Плагины eCode
        </button>
      </div>
      <div className="ext-hub-body view-enter" key={tab}>
        {tab === 'extensions' ? <ExtensionsView /> : <PluginsView />}
      </div>
    </div>
  )
}

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
        {view === 'debug' && <DebugView />}
        {view === 'ai' && <AiView />}
        {(view === 'plugins' || view === 'extensions') && <ExtensionsHub />}
        {view === 'settings' && <SettingsView />}
      </div>
    </section>
  )
}
