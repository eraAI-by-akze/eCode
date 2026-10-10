import { useState } from 'react'
import type { GitFile } from '@shared/types'
import { useStore, setState } from '../store'
import * as a from '../actions'
import * as scm from '../scm'
import { basename, dirname } from '../lib/path'
import { formatKeys } from '../commands'
import {
  FileIcon,
  IconArrowDown,
  IconArrowUp,
  IconBranch,
  IconCheck,
  IconChevron,
  IconGoToFile,
  IconMinus,
  IconPlus,
  IconRefresh,
  IconSync,
  IconUndo
} from './Icons'

const api = window.ecode

type Group = 'conflicts' | 'staged' | 'changes'

function FileRow({ file, group }: { file: GitFile; group: Group }) {
  const code = group === 'staged' ? file.x : group === 'conflicts' ? 'U' : file.y
  const deco = scm.decorationOfCode(code)
  const dir = dirname(file.rel)
  return (
    <div
      className={`scm-file deco-${deco}`}
      onClick={() => scm.openDiff(file, group === 'staged')}
      title={file.rel}
      onContextMenu={async (e) => {
        e.preventDefault()
        const id = await api.contextMenu([
          { id: 'diff', label: 'Открыть изменения' },
          { id: 'open', label: 'Открыть файл' },
          { type: 'separator' },
          group === 'staged' ? { id: 'unstage', label: 'Убрать из индекса' } : { id: 'stage', label: 'Индексировать' },
          ...(group !== 'staged' ? [{ id: 'discard', label: 'Отменить изменения' }] : []),
          { type: 'separator' },
          { id: 'reveal', label: 'Показать в проводнике' }
        ])
        if (id === 'diff') scm.openDiff(file, group === 'staged')
        if (id === 'open') scm.openChangedFile(file)
        if (id === 'stage') scm.stage([file.path])
        if (id === 'unstage') scm.unstage([file.path])
        if (id === 'discard') scm.discard([file])
        if (id === 'reveal') a.revealInTree(file.path)
      }}
    >
      <FileIcon name={basename(file.rel)} size={15} />
      <span className="scm-name">{basename(file.rel)}</span>
      <span className="scm-dir">{dir === file.rel ? '' : dir}</span>
      <div className="scm-actions" onClick={(e) => e.stopPropagation()}>
        <button title="Открыть файл" onClick={() => scm.openChangedFile(file)}>
          <IconGoToFile size={14} />
        </button>
        {group !== 'staged' && (
          <button title="Отменить изменения" onClick={() => scm.discard([file])}>
            <IconUndo size={14} />
          </button>
        )}
        {group === 'staged' ? (
          <button title="Убрать из индекса" onClick={() => scm.unstage([file.path])}>
            <IconMinus size={14} />
          </button>
        ) : (
          <button title="Индексировать" onClick={() => scm.stage([file.path])}>
            <IconPlus size={14} />
          </button>
        )}
      </div>
      <span className="scm-letter">{scm.letter(code)}</span>
    </div>
  )
}

function Section({ title, group, files }: { title: string; group: Group; files: GitFile[] }) {
  const [open, setOpen] = useState(true)
  if (!files.length) return null
  return (
    <div className="scm-section">
      <div className="scm-section-header" onClick={() => setOpen(!open)}>
        <IconChevron size={13} className={`chev ${open ? 'open' : ''}`} />
        <span>{title}</span>
        <div className="scm-actions" onClick={(e) => e.stopPropagation()}>
          {group === 'staged' ? (
            <button title="Убрать всё из индекса" onClick={() => scm.unstage(files.map((f) => f.path))}>
              <IconMinus size={14} />
            </button>
          ) : (
            <>
              {group === 'changes' && (
                <button title="Отменить все изменения" onClick={() => scm.discard(files)}>
                  <IconUndo size={14} />
                </button>
              )}
              <button title="Индексировать все" onClick={() => scm.stage(files.map((f) => f.path))}>
                <IconPlus size={14} />
              </button>
            </>
          )}
        </div>
        <span className="badge">{files.length}</span>
      </div>
      {open && files.map((f) => <FileRow key={f.path + group} file={f} group={group} />)}
    </div>
  )
}

export function ScmView() {
  const root = useStore((s) => s.root)
  const git = useStore((s) => s.git)
  const busy = useStore((s) => s.gitBusy)
  const message = useStore((s) => s.commitMessage)

  if (!root) {
    return (
      <div className="sidebar-empty">
        <p>Откройте папку, чтобы работать с git</p>
        <button className="btn-primary" onClick={() => a.openFolder()}>
          Открыть папку
        </button>
      </div>
    )
  }
  if (!git) {
    return (
      <div className="sidebar-empty">
        <p>Эта папка не является git-репозиторием.</p>
        <button className="btn-primary" onClick={() => scm.initRepo()}>
          Инициализировать репозиторий
        </button>
      </div>
    )
  }

  const conflicts = git.files.filter(scm.isConflict)
  const staged = git.files.filter(scm.isStaged)
  const changes = git.files.filter(scm.isChanged)
  const canCommit = !busy && !!message.trim() && (staged.length > 0 || changes.length > 0)

  return (
    <div className="scm-view">
      <div className="sidebar-section-header">
        <button className="scm-branch" title="Сменить ветку" onClick={() => scm.pickBranch()}>
          <IconBranch size={13} />
          <span>{git.branch ?? '—'}</span>
        </button>
        <div className="header-actions">
          <button title="Получить (pull)" onClick={() => scm.sync('pull')} disabled={!!busy}>
            <IconArrowDown size={15} />
          </button>
          <button title="Отправить (push)" onClick={() => scm.sync('push')} disabled={!!busy}>
            <IconArrowUp size={15} />
          </button>
          <button title="Fetch" onClick={() => scm.sync('fetch')} disabled={!!busy}>
            <IconSync size={15} />
          </button>
          <button title="Обновить" onClick={() => scm.refreshGit()}>
            <IconRefresh size={15} />
          </button>
        </div>
      </div>

      <div className="commit-box">
        <textarea
          value={message}
          placeholder={`Сообщение коммита (${formatKeys(['mod+enter'])} — коммит)`}
          spellCheck={false}
          rows={Math.min(6, Math.max(2, message.split('\n').length))}
          onChange={(e) => setState({ commitMessage: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              scm.commit()
            }
          }}
        />
        <button className="btn-primary commit-btn" disabled={!canCommit} onClick={() => scm.commit()}>
          {busy ? <span className="spinner light" /> : <IconCheck size={15} />}
          {busy === 'push' ? 'Отправка…' : busy === 'pull' ? 'Получение…' : 'Коммит'}
        </button>
        {(git.ahead > 0 || git.behind > 0) && (
          <button className="sync-btn" onClick={() => scm.sync(git.behind > 0 ? 'pull' : 'push')} disabled={!!busy}>
            <IconSync size={14} />
            Синхронизировать {git.behind > 0 && `↓${git.behind}`} {git.ahead > 0 && `↑${git.ahead}`}
          </button>
        )}
      </div>

      <div className="scm-list">
        <Section title="Конфликты слияния" group="conflicts" files={conflicts} />
        <Section title="Проиндексированные" group="staged" files={staged} />
        <Section title="Изменения" group="changes" files={changes} />
        {!git.files.length && <div className="scm-clean">Рабочая копия чистая ✓</div>}
      </div>
    </div>
  )
}
