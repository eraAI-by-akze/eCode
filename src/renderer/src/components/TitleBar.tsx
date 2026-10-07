import { useStore } from '../store'
import * as a from '../actions'
import { basename } from '../lib/path'
import { formatKeys } from '../commands'
import { IconClose, IconMaximize, IconMinimize, IconRestore, IconSearch, IconSplit, Logo } from './Icons'

const api = window.ecode
const isMac = api.platform === 'darwin'

export function TitleBar() {
  const root = useStore((s) => s.root)
  const maximized = useStore((s) => s.maximized)
  const sidebar = useStore((s) => s.sidebar)
  const panelOpen = useStore((s) => s.panelOpen)

  return (
    <header className={`titlebar ${isMac ? 'is-mac' : ''}`} onDoubleClick={isMac ? undefined : () => api.toggleMaximize()}>
      <div className="titlebar-left">
        <Logo />
        <span className="titlebar-brand">eCode</span>
        <nav className="titlebar-menu">
          <button onClick={() => a.openFolder()}>Открыть</button>
          <button onClick={() => a.beginCreate('newFile')}>Новый</button>
          <button onClick={() => a.openQuick('>')}>Команды</button>
        </nav>
      </div>

      <button className="command-center" onClick={() => a.openQuick('')} onDoubleClick={(e) => e.stopPropagation()}>
        <IconSearch size={14} />
        <span>{root ? basename(root) : 'eCode'}</span>
        <kbd>{formatKeys(['mod+p'])}</kbd>
      </button>

      <div className="titlebar-right">
        <button
          className={`tb-toggle ${sidebar ? 'on' : ''}`}
          title="Боковая панель"
          onClick={() => a.toggleSidebar()}
        >
          <IconSplit size={14} style={{ transform: 'rotate(90deg)' }} />
        </button>
        <button className={`tb-toggle ${panelOpen ? 'on' : ''}`} title="Терминал" onClick={() => a.togglePanel()}>
          <IconSplit size={14} />
        </button>
        {!isMac && (
          <div className="window-controls">
            <button onClick={() => api.minimize()} aria-label="Свернуть">
              <IconMinimize size={14} />
            </button>
            <button onClick={() => api.toggleMaximize()} aria-label="Развернуть">
              {maximized ? <IconRestore size={13} /> : <IconMaximize size={12} />}
            </button>
            <button className="close" onClick={() => api.close()} aria-label="Закрыть">
              <IconClose size={14} />
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
