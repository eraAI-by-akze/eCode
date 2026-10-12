import { useEffect, useState } from 'react'
import type { PluginEntry } from '@shared/types'
import { useStore } from '../store'
import * as a from '../actions'
import * as plugins from '../pluginService'
import * as tasks from '../taskService'
import { runInTerminal } from '../terminalService'
import { basename } from '../lib/path'
import { IconCheck, IconFolderOpen, IconHammer, IconPlus, IconRefresh, IconWarning } from './Icons'

const api = window.ecode

function Tool({ command, install }: { command: string; install?: string }) {
  const path = useStore((s) => s.tools[command])
  const found = !!path
  const isUrl = !!install && /^https?:/.test(install)
  return (
    <div className={`plugin-tool ${found ? 'ok' : 'missing'}`} title={path ?? undefined}>
      {found ? <IconCheck size={12} /> : <IconWarning size={12} />}
      <code>{command}</code>
      <span>{found ? 'найден' : 'не найден'}</span>
      {!found && install && (
        <button
          className="ai-link"
          onClick={() => (isUrl ? api.openExternal(install) : void runInTerminal(install).then(() => setTimeout(plugins.refreshTools, 15000)))}
          title={install}
        >
          {isUrl ? 'Скачать' : 'Установить'}
        </button>
      )}
    </div>
  )
}

function PluginCard({ entry }: { entry: PluginEntry }) {
  const disabled = useStore((s) => s.settings.disabledPlugins)
  const [open, setOpen] = useState(entry.builtin === false)
  const m = entry.manifest
  if (!m) {
    return (
      <div className="plugin-card broken">
        <strong>{basename(entry.dir)}</strong>
        <div className="ai-error">plugin.json: {entry.error}</div>
      </div>
    )
  }
  const enabled = !disabled.includes(m.id)
  const toggle = (): void =>
    a.updateSettings({ disabledPlugins: enabled ? [...disabled, m.id] : disabled.filter((d) => d !== m.id) })
  return (
    <div className={`plugin-card ${enabled ? '' : 'off'}`}>
      <div className="plugin-head" onClick={() => setOpen(!open)}>
        <div className="plugin-title">
          <strong>{m.name}</strong>
          <small>
            {m.version ?? ''} {entry.builtin ? '· встроенный' : '· пользовательский'}
          </small>
        </div>
        <button
          className={`toggle ${enabled ? 'on' : ''}`}
          role="switch"
          aria-checked={enabled}
          onClick={(e) => {
            e.stopPropagation()
            toggle()
          }}
        >
          <span />
        </button>
      </div>
      {m.description && <p className="plugin-desc">{m.description}</p>}
      {open && (
        <div className="plugin-body">
          {(m.requires?.length || m.languageServers?.length) && (
            <div className="plugin-section">
              {m.requires?.map((r) => <Tool key={r.command} command={r.command} install={r.install} />)}
              {m.languageServers?.map((s) => (
                <Tool key={s.id} command={s.command} install={s.install} />
              ))}
            </div>
          )}
          {!!m.tasks?.length && (
            <div className="plugin-section">
              <div className="section-label">Задачи</div>
              <div className="plugin-tasks">
                {m.tasks.map((t) => (
                  <button
                    key={t.id}
                    className="plugin-task"
                    disabled={!enabled}
                    title={t.command}
                    onClick={() => void tasks.runTask({ item: t, plugin: m, dir: entry.dir })}
                  >
                    <IconHammer size={12} />
                    {t.label}
                    {t.group && <em>{tasks.GROUP_LABEL[t.group]}</em>}
                  </button>
                ))}
              </div>
            </div>
          )}
          {!entry.builtin && (
            <button className="ai-link" onClick={() => void a.openFile(`${entry.dir}${api.pathSep}plugin.json`)}>
              Открыть plugin.json
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function PluginsView() {
  const list = useStore((s) => s.plugins)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void plugins.refreshTools()
  }, [])

  const reload = async (): Promise<void> => {
    setBusy(true)
    await plugins.loadPlugins()
    await a.restartLanguageServers(true)
    setBusy(false)
    a.toast('Плагины перезагружены')
  }

  return (
    <div className="plugins-view">
      <div className="sidebar-section-header">
        <span className="folder-name">{list.length} плагин(ов)</span>
        <div className="header-actions">
          <button
            title="Новый плагин"
            onClick={() =>
              a.prompt('Имя плагина', 'Будет создан ~/.ecode/plugins/<имя>/plugin.json', async (name) => {
                const file = await plugins.scaffoldPlugin(name)
                await plugins.loadPlugins()
                await a.openFile(file)
              })
            }
          >
            <IconPlus size={15} />
          </button>
          <button title="Папка плагинов" onClick={async () => api.revealInFolder(await api.pluginsDir())}>
            <IconFolderOpen size={15} />
          </button>
          <button title="Перезагрузить" onClick={() => void reload()} disabled={busy}>
            <IconRefresh size={15} className={busy ? 'spin' : ''} />
          </button>
        </div>
      </div>
      <div className="plugins-list">
        {list.map((p) => (
          <PluginCard key={p.dir} entry={p} />
        ))}
        <p className="settings-hint">
          Плагин — папка с <code>plugin.json</code> в <code>~/.ecode/plugins</code>: языковые серверы, задачи сборки и проверки
          с разбором ошибок, запуск файлов. Нажмите «+», чтобы создать шаблон.
        </p>
      </div>
    </div>
  )
}
