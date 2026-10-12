import { useStore } from '../store'
import * as a from '../actions'
import { basename } from '../lib/path'
import { formatKeys } from '../commands'
import * as tasks from '../taskService'
import { IconChevron, IconClose, IconHammer, IconMaximize, IconMinimize, IconRestore, IconSearch, IconSplit, Logo } from './Icons'

const api = window.ecode
const isMac = api.platform === 'darwin'

export function TitleBar() {
  const root = useStore((s) => s.root)
  const maximized = useStore((s) => s.maximized)
  const sidebar = useStore((s) => s.sidebar)
  const panelOpen = useStore((s) => s.panelOpen)
  // The mark spins while something works in the background (a build, eraAI).
  const busy = useStore((s) => !!s.task || !!s.aiBusy)
  const task = useStore((s) => s.task)
  const last = useStore((s) => s.lastTask)

  return (
    <header
      className={`titlebar ${isMac ? 'is-mac' : ''}`}
      // Tauri drags (and double-click maximizes) via this attribute; Electron uses -webkit-app-region.
      data-tauri-drag-region
      onDoubleClick={isMac || api.runtime === 'tauri' ? undefined : () => api.toggleMaximize()}
    >
      <div className="titlebar-left" data-tauri-drag-region>
        <Logo size={22} className={`titlebar-logo ${busy ? 'busy' : ''}`} data-tauri-drag-region title="eCode" />
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

      <div className="titlebar-right" data-tauri-drag-region>
        {root && (
          <div
            className={`tb-build ${task ? 'running' : last ? (last.code === 0 ? 'ok' : 'fail') : ''}`}
            // Re-keyed per result so the flash replays after every build.
            key={task ? 'run' : `done-${last?.ms ?? 0}`}
          >
            {task ? (
              <button className="tb-build-main" title={`${task.label} — остановить (Shift+F5)`} onClick={() => tasks.stopTask()}>
                <span className="spinner tiny" />
                <span>Стоп</span>
              </button>
            ) : (
              <button className="tb-build-main" title={`Собрать (${formatKeys(['f5'])})`} onClick={() => void tasks.quickBuild()}>
                <IconHammer size={14} />
                <span>Собрать</span>
              </button>
            )}
            <button className="tb-build-more" title="Выбрать задачу…" onClick={() => void tasks.runGroup('any')}>
              <IconChevron size={11} style={{ transform: 'rotate(90deg)' }} />
            </button>
          </div>
        )}
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
