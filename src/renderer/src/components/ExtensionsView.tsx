import { useEffect, useState } from 'react'
import { useStore, type InstalledExtension } from '../store'
import * as ext from '../extensionService'
import * as a from '../actions'
import { THEMES } from '../themes'
import { IconCheck, IconFolderOpen, IconPlus, IconRefresh, IconSearch, IconTrash, IconWarning } from './Icons'

const api = window.ecode

/** Extension icon from disk (data: URL) with a letter fallback. */
function ExtIcon({ path, url, name }: { path?: string; url?: string; name: string }) {
  const [src, setSrc] = useState<string | null>(url ?? null)
  useEffect(() => {
    if (url || !path) return
    let alive = true
    void api.readDataUrl(path).then((d) => alive && setSrc(d))
    return () => {
      alive = false
    }
  }, [path, url])
  if (src) return <img className="ext-icon" src={src} alt="" draggable={false} onError={() => setSrc(null)} />
  return <div className="ext-icon letter">{(name[0] ?? '?').toUpperCase()}</div>
}

function formatCount(n?: number): string {
  if (!n) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} млн`
  if (n >= 1000) return `${Math.round(n / 1000)} тыс.`
  return String(n)
}

function InstalledCard({ e }: { e: InstalledExtension }) {
  const theme = useStore((s) => s.settings.theme)
  const iconTheme = useStore((s) => s.settings.iconTheme)
  const iconThemes = useStore((s) => s.iconThemes)
  useStore((s) => s.themesVersion)
  const colorThemes = Object.values(THEMES).filter((t) => t.id.startsWith(`ext:${e.id}/`))
  const icons = iconThemes.filter((t) => t.id.startsWith(`${e.id}/`))
  return (
    <div className={`ext-card ${e.enabled ? '' : 'off'} ${e.unsupported ? 'unsupported' : ''}`}>
      <ExtIcon path={e.icon} name={e.displayName} />
      <div className="ext-main">
        <div className="ext-title">
          <strong>{e.displayName}</strong>
          <span className="ext-version">{e.version}</span>
        </div>
        <div className="ext-publisher">{e.publisher}</div>
        {e.description && <div className="ext-desc">{e.description}</div>}
        <div className="ext-chips">
          {e.features.map((f) => (
            <span key={f} className="ext-chip">
              {f}
            </span>
          ))}
          {e.unsupported ? (
            <span className="ext-chip bad" title="eCode не выполняет JavaScript расширений VS Code">
              <IconWarning size={11} /> не поддерживается
            </span>
          ) : (
            e.hasCode && (
              <span className="ext-chip warn" title="Темы, синтаксис и сниппеты работают; команды и функции из JavaScript расширения — нет">
                частично
              </span>
            )
          )}
        </div>
        {e.enabled && (colorThemes.length > 0 || icons.length > 0) && (
          <div className="ext-actions">
            {colorThemes.map((t) => (
              <button key={t.id} className={`ext-apply ${theme === t.id ? 'on' : ''}`} onClick={() => a.updateSettings({ theme: t.id })}>
                {theme === t.id && <IconCheck size={11} />} {t.name}
              </button>
            ))}
            {icons.map((t) => (
              <button
                key={t.id}
                className={`ext-apply ${iconTheme === t.id ? 'on' : ''}`}
                onClick={() => a.updateSettings({ iconTheme: iconTheme === t.id ? '' : t.id })}
              >
                {iconTheme === t.id && <IconCheck size={11} />} Значки: {t.label}
              </button>
            ))}
          </div>
        )}
        {e.error && <div className="ai-error">{e.error}</div>}
      </div>
      <div className="ext-side">
        <button
          className={`toggle ${e.enabled ? 'on' : ''}`}
          role="switch"
          aria-checked={e.enabled}
          title={e.enabled ? 'Выключить' : 'Включить'}
          onClick={() => ext.setExtensionEnabled(e, !e.enabled)}
        >
          <span />
        </button>
        <button className="ext-remove" title="Удалить" onClick={() => void ext.uninstall(e)}>
          <IconTrash size={14} />
        </button>
      </div>
    </div>
  )
}

function GalleryCard({ g }: { g: ext.GalleryExtension }) {
  useStore((s) => s.extensions)
  const installed = ext.isInstalled(g.namespace, g.name)
  const [busy, setBusy] = useState(false)
  return (
    <div className="ext-card gallery">
      <ExtIcon url={g.icon} name={g.displayName} />
      <div className="ext-main">
        <div className="ext-title">
          <strong>{g.displayName}</strong>
          <span className="ext-version">{g.version}</span>
        </div>
        <div className="ext-publisher">
          {g.namespace}
          {g.downloads ? ` · ↓ ${formatCount(g.downloads)}` : ''}
          {g.rating ? ` · ★ ${g.rating.toFixed(1)}` : ''}
        </div>
        {g.description && <div className="ext-desc">{g.description}</div>}
      </div>
      <div className="ext-side">
        {installed && installed.version === g.version ? (
          <span className="ext-installed">
            <IconCheck size={12} /> есть
          </span>
        ) : (
          <button
            className="btn-primary small"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await ext.installFromGallery(`${g.namespace}.${g.name}`)
              } catch (err) {
                a.toast(`Не удалось установить: ${(err as Error).message}`, 'error')
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? <span className="spinner tiny light" /> : installed ? 'Обновить' : 'Установить'}
          </button>
        )}
      </div>
    </div>
  )
}

export function ExtensionsView() {
  const extensions = useStore((s) => s.extensions)
  const galleryUrl = useStore((s) => s.settings.extensionGallery)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ext.GalleryExtension[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let alive = true
    const t = setTimeout(
      () => {
        setLoading(true)
        setError(null)
        ext
          .searchGallery(query.trim())
          .then((r) => alive && setResults(r))
          .catch((err: Error) => alive && (setResults(null), setError(err.message)))
          .finally(() => alive && setLoading(false))
      },
      query ? 350 : 0
    )
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query, galleryUrl])

  const q = query.trim().toLowerCase()
  const installed = q ? extensions.filter((e) => `${e.displayName} ${e.id} ${e.description}`.toLowerCase().includes(q)) : extensions
  const host = galleryUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '')

  return (
    <div className="extensions-view">
      <div className="ext-search">
        <IconSearch size={14} />
        <input autoFocus placeholder="Поиск расширений" title={`Каталог: ${host}`} value={query} onChange={(e) => setQuery(e.target.value)} />
        {loading && <span className="spinner tiny" />}
      </div>
      <div className="ext-toolbar">
        <button className="btn-ghost small" onClick={() => void ext.pickAndInstallVsix()}>
          <IconPlus size={12} /> Из файла .vsix
        </button>
        <div className="header-actions">
          <button title="Папка расширений" onClick={async () => api.revealInFolder(await api.extensionsDir())}>
            <IconFolderOpen size={15} />
          </button>
          <button title="Перечитать" onClick={() => void ext.loadExtensions()}>
            <IconRefresh size={15} />
          </button>
        </div>
      </div>

      <div className="section-label">Установленные · {installed.length}</div>
      {installed.map((e) => (
        <InstalledCard key={e.dir} e={e} />
      ))}
      {!extensions.length && (
        <p className="settings-hint">
          Темы, значки файлов, подсветка синтаксиса и сниппеты из VS Code / VSCodium. Найдите расширение ниже или перетащите файл .vsix в окно.
        </p>
      )}

      <div className="section-label">{q ? 'Найдено в Open VSX' : 'Популярные в Open VSX'}</div>
      {error && (
        <div className="ext-offline">
          <IconWarning size={13} /> Каталог недоступен: {error}
        </div>
      )}
      {results?.map((g) => (
        <GalleryCard key={`${g.namespace}.${g.name}`} g={g} />
      ))}
      {results && !results.length && <div className="dbg-hint">Ничего не найдено</div>}
    </div>
  )
}
