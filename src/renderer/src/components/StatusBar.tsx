import { useStore } from '../store'
import * as a from '../actions'
import * as scm from '../scm'
import { languageName } from '../editorService'
import { SERVER_NAMES, serverForLanguage } from '../lspClient'
import { THEMES } from '../themes'
import { basename } from '../lib/path'
import { IconBranch, IconCheck, IconError, IconFolder, IconSync, IconWarning } from './Icons'

export function StatusBar() {
  const root = useStore((s) => s.root)
  const git = useStore((s) => s.git)
  const gitBusy = useStore((s) => s.gitBusy)
  const active = useStore((s) => s.active)
  const cursor = useStore((s) => s.cursor)
  const language = useStore((s) => s.language)
  const eol = useStore((s) => s.eol)
  const tabSize = useStore((s) => s.settings.tabSize)
  const theme = useStore((s) => s.settings.theme)
  const dirtyCount = useStore((s) => s.tabs.filter((t) => t.dirty).length)
  const lsp = useStore((s) => s.lsp)
  const counts = useStore((s) => {
    let errors = 0
    let warnings = 0
    for (const list of Object.values(s.diagnostics)) {
      for (const d of list) {
        if (d.severity === 'error') errors++
        else if (d.severity === 'warning') warnings++
      }
    }
    return `${errors}:${warnings}`
  })
  const [errors, warnings] = counts.split(':').map(Number)
  const isDiff = !!active?.startsWith('diff:')
  const server = active && !isDiff ? serverForLanguage(language) : undefined
  const serverStatus = server ? lsp[server] : undefined

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
        {git && (
          <button className="sb-item" onClick={() => scm.pickBranch()} title="Сменить ветку">
            <IconBranch size={13} />
            {git.branch ?? '—'}
            {git.files.length > 0 && '*'}
          </button>
        )}
        {git && (git.ahead > 0 || git.behind > 0 || gitBusy) && (
          <button
            className="sb-item"
            title="Синхронизировать"
            onClick={() => scm.sync(git.behind > 0 ? 'pull' : 'push')}
          >
            <IconSync size={13} className={gitBusy ? 'spin' : ''} />
            {git.behind > 0 && `${git.behind}↓`} {git.ahead > 0 && `${git.ahead}↑`}
          </button>
        )}
        {root && (
          <button className="sb-item" onClick={() => a.showPanel('problems')} title="Проблемы">
            <IconError size={13} />
            {errors}
            <IconWarning size={13} />
            {warnings}
          </button>
        )}
        {dirtyCount > 0 && <span className="sb-item sb-dirty">● {dirtyCount} не сохранено</span>}
      </div>
      <div className="sb-right">
        {active && !isDiff && (
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
        {server && serverStatus && (
          <button
            className={`sb-item lsp-${serverStatus.state}`}
            title={serverStatus.message ?? `${SERVER_NAMES[server]}: работает`}
            onClick={() => a.restartLanguageServers()}
          >
            {serverStatus.state === 'starting' || serverStatus.message ? (
              <span className="spinner tiny" />
            ) : serverStatus.state === 'ready' ? (
              <IconCheck size={13} />
            ) : (
              <IconWarning size={13} />
            )}
            {SERVER_NAMES[server] === languageName(language) ? 'LSP' : SERVER_NAMES[server]}
          </button>
        )}
        <button className="sb-item" onClick={() => a.pickTheme()}>
          {THEMES[theme]?.name}
        </button>
      </div>
    </footer>
  )
}
