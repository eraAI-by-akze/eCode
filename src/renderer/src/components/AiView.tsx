import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { EraBackend } from '@shared/types'
import { useStore, setState, type AiMessage, type AiToolCard } from '../store'
import * as era from '../eraService'
import { formatKeys } from '../commands'
import { IconCheck, IconChevron, IconClose, IconPlus, IconRefresh, IconSettings, IconSparkle } from './Icons'

const api = window.ecode

// ─────────────────────────── markdown-lite ───────────────────────────

function inline(text: string, keyBase: string): ReactNode[] {
  // `code` and **bold**; everything else stays plain text (React escapes it).
  const out: ReactNode[] = []
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    out.push(
      tok.startsWith('`') ? <code key={`${keyBase}-${i++}`}>{tok.slice(1, -1)}</code> : <strong key={`${keyBase}-${i++}`}>{tok.slice(2, -2)}</strong>
    )
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="ai-code">
      <div className="ai-code-head">
        <span>{lang || 'код'}</span>
        <button
          onClick={() => {
            navigator.clipboard.writeText(code)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          {copied ? 'Скопировано' : 'Копировать'}
        </button>
      </div>
      <pre>{code}</pre>
    </div>
  )
}

function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const parts = text.split(/```/)
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n')
      const lang = nl >= 0 ? part.slice(0, nl).trim() : ''
      blocks.push(<CodeBlock key={i} lang={lang} code={(nl >= 0 ? part.slice(nl + 1) : part).replace(/\n$/, '')} />)
      return
    }
    part
      .split(/\n{2,}/)
      .filter((p) => p.trim())
      .forEach((para, j) => {
        const lines = para.split('\n')
        const isList = lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l))
        if (isList) {
          blocks.push(
            <ul key={`${i}-${j}`}>
              {lines.map((l, k) => (
                <li key={k}>{inline(l.replace(/^\s*([-*]|\d+\.)\s/, ''), `${i}-${j}-${k}`)}</li>
              ))}
            </ul>
          )
        } else {
          blocks.push(
            <p key={`${i}-${j}`}>
              {lines.map((l, k) => (
                <span key={k}>
                  {k > 0 && <br />}
                  {inline(l.replace(/^#{1,6}\s+/, ''), `${i}-${j}-${k}`)}
                </span>
              ))}
            </p>
          )
        }
      })
  })
  return <div className="ai-md">{blocks}</div>
}

// ─────────────────────────── tool cards ───────────────────────────

const TOOL_ICON: Record<string, string> = {
  read_file: '📖',
  list_files: '🗂',
  search: '🔎',
  replace_lines: '✏️',
  insert_lines: '➕',
  replace_text: '✏️',
  write_file: '📝'
}

function ToolCard({ card }: { card: AiToolCard }) {
  const [open, setOpen] = useState(false)
  const p = card.preview
  return (
    <div className={`ai-tool status-${card.status}`}>
      <div className="ai-tool-head" onClick={() => setOpen(!open)}>
        <span className="ai-tool-icon">{TOOL_ICON[card.name] ?? '⚙️'}</span>
        <span className="ai-tool-summary">{card.summary}</span>
        {card.status === 'running' && <span className="spinner tiny" />}
        {card.status === 'applied' && <span className="ai-tag ok">применено</span>}
        {card.status === 'rejected' && <span className="ai-tag">отклонено</span>}
        {card.status === 'error' && <span className="ai-tag err">ошибка</span>}
        {card.result && <IconChevron size={12} className={`chev ${open ? 'open' : ''}`} />}
      </div>
      {p && (card.status === 'pending' || open) && (
        <div className="ai-diff">
          {p.oldLines.map((l, i) => (
            <div key={`o${i}`} className="del">
              <span>{p.startLine + i}</span>−{l}
            </div>
          ))}
          {p.newLines.map((l, i) => (
            <div key={`n${i}`} className="add">
              <span>{p.startLine + i}</span>+{l}
            </div>
          ))}
          {!p.oldLines.length && !p.newLines.length && <div className="del">(удаление строк)</div>}
        </div>
      )}
      {card.status === 'pending' && (
        <div className="ai-approve">
          <button className="btn-primary" onClick={() => era.approve(card.callId, true)}>
            <IconCheck size={13} /> Принять
          </button>
          <button className="btn-ghost" onClick={() => era.approve(card.callId, false)}>
            <IconClose size={13} /> Отклонить
          </button>
        </div>
      )}
      {open && card.result && !p && <pre className="ai-tool-result">{card.result}</pre>}
      {open && card.result && p && card.status !== 'pending' && <div className="ai-tool-note">{card.result}</div>}
    </div>
  )
}

function Message({ msg, busy }: { msg: AiMessage; busy: boolean }) {
  if (msg.role === 'user') {
    return (
      <div className="ai-msg user">
        <div className="ai-bubble">{msg.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')}</div>
      </div>
    )
  }
  const empty = !msg.parts.length && !msg.error
  return (
    <div className="ai-msg assistant">
      <div className="ai-avatar">
        <IconSparkle size={12} />
      </div>
      <div className="ai-body">
        {msg.parts.map((p, i) => (p.kind === 'text' ? <Markdown key={i} text={p.text} /> : <ToolCard key={p.card.callId} card={p.card} />))}
        {empty && busy && <div className="ai-thinking">думаю…</div>}
        {msg.error && <div className="ai-error">{msg.error}</div>}
        {busy && !empty && <span className="ai-caret" />}
      </div>
    </div>
  )
}

// ─────────────────────────── setup ───────────────────────────

const BACKENDS: EraBackend[] = ['ollama', 'openai', 'gguf', 'mock']

function Setup({ onClose }: { onClose?: () => void }) {
  const s = useStore((st) => st.settings.era)
  const ai = useStore((st) => st.ai)
  const [models, setModels] = useState<string[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const busy = ai.state === 'starting' || ai.state === 'loading'

  const loadModels = async (): Promise<void> => {
    setModelsError(null)
    try {
      setModels(await api.eraListModels(s.url))
    } catch (err) {
      setModels([])
      setModelsError(String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ''))
    }
  }
  useEffect(() => {
    if (s.backend === 'ollama' || s.backend === 'openai') void loadModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.backend, s.url])

  return (
    <div className="ai-setup">
      <div className="ai-setup-title">
        <span>Модель</span>
        {onClose && (
          <button title="Скрыть" onClick={onClose}>
            <IconClose size={13} />
          </button>
        )}
      </div>
      <div className="segmented ai-seg">
        {BACKENDS.map((b) => (
          <button key={b} className={s.backend === b ? 'on' : ''} onClick={() => era.updateEra({ backend: b })}>
            {era.BACKEND_LABEL[b]}
          </button>
        ))}
      </div>

      {(s.backend === 'ollama' || s.backend === 'openai') && (
        <>
          <label className="ai-field">
            <span>Адрес сервера</span>
            <input value={s.url} spellCheck={false} onChange={(e) => era.updateEra({ url: e.target.value })} />
          </label>
          <label className="ai-field">
            <span>
              Модель
              <button className="ai-link" onClick={() => loadModels()} title="Обновить список">
                <IconRefresh size={11} />
              </button>
            </span>
            <input list="era-models" value={s.model} spellCheck={false} onChange={(e) => era.updateEra({ model: e.target.value })} />
            <datalist id="era-models">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          {models.length > 0 && (
            <div className="ai-chips">
              {models.slice(0, 8).map((m) => (
                <button key={m} className={m === s.model ? 'on' : ''} onClick={() => era.updateEra({ model: m })}>
                  {m}
                </button>
              ))}
            </div>
          )}
          {modelsError && s.backend === 'ollama' && (
            <p className="ai-hint">
              Ollama не отвечает. Установите её с ollama.com и скачайте модель, например:{' '}
              <code>ollama pull qwen2.5-coder:7b</code>
            </p>
          )}
          {s.backend === 'openai' && (
            <label className="ai-field">
              <span>API-ключ (если нужен)</span>
              <input type="password" value={s.apiKey} onChange={(e) => era.updateEra({ apiKey: e.target.value })} />
            </label>
          )}
        </>
      )}

      {s.backend === 'gguf' && (
        <>
          <label className="ai-field">
            <span>Файл модели</span>
            <div className="ai-row">
              <input value={s.ggufPath} placeholder="/path/to/model.gguf" spellCheck={false} onChange={(e) => era.updateEra({ ggufPath: e.target.value })} />
              <button
                className="btn-ghost"
                onClick={async () => {
                  const p = await api.eraPickModelFile()
                  if (p) era.updateEra({ ggufPath: p })
                }}
              >
                Выбрать…
              </button>
            </div>
          </label>
          <p className="ai-hint">
            Модель загружается прямо в eraCore через llama-cpp-python.{' '}
            <button className="ai-link" onClick={() => era.installLlamaCpp()}>
              Установить llama-cpp-python
            </button>
          </p>
        </>
      )}

      {s.backend === 'mock' && <p className="ai-hint">Заглушка eraCore без модели: проверка, что всё подключено.</p>}

      <div className="ai-grid">
        <label className="ai-field">
          <span>Температура</span>
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={s.temperature}
            onChange={(e) => era.updateEra({ temperature: Number(e.target.value) })}
          />
        </label>
        <label className="ai-field">
          <span>Макс. токенов</span>
          <input
            type="number"
            min={64}
            step={256}
            value={s.maxTokens}
            onChange={(e) => era.updateEra({ maxTokens: Number(e.target.value) })}
          />
        </label>
      </div>
      <label className="ai-field">
        <span>Python {ai.python && <em>· найден {ai.python}</em>}</span>
        <input
          value={s.pythonPath}
          placeholder="авто (python3 / python / py)"
          spellCheck={false}
          onChange={(e) => era.updateEra({ pythonPath: e.target.value })}
        />
      </label>
      <label className="ai-check">
        <input type="checkbox" checked={s.autoApply} onChange={(e) => era.updateEra({ autoApply: e.target.checked })} />
        Применять правки без подтверждения
      </label>

      {ai.state === 'missing' && (
        <div className="ai-banner">
          <strong>eraCore не установлен</strong> для {ai.pythonPath ?? 'Python'} {ai.python}.
          <div className="ai-row">
            <button className="btn-primary" onClick={() => era.installEraCore()}>
              pip install eracore
            </button>
            <button className="btn-ghost" onClick={() => era.deploy()}>
              Проверить снова
            </button>
          </div>
        </div>
      )}
      {ai.state === 'error' && ai.message && <div className="ai-error">{ai.message}</div>}

      <button className="btn-primary ai-deploy" disabled={busy} onClick={() => era.deploy()}>
        {busy ? <span className="spinner light" /> : <IconSparkle size={14} />}
        {busy ? ai.message ?? 'Развёртывание…' : ai.state === 'ready' ? 'Перезапустить модель' : 'Развернуть модель'}
      </button>
    </div>
  )
}

// ─────────────────────────── view ───────────────────────────

const SUGGESTIONS = [
  'Объясни, что делает открытый файл',
  'Найди и исправь ошибки в открытом файле',
  'Добавь docstring/JSDoc к функциям в открытом файле',
  'Какие файлы есть в проекте и за что они отвечают?'
]

export function AiView() {
  const ai = useStore((s) => s.ai)
  const settings = useStore((s) => s.settings.era)
  const messages = useStore((s) => s.aiMessages)
  const busy = useStore((s) => s.aiBusy)
  const draft = useStore((s) => s.aiDraft)
  const root = useStore((s) => s.root)
  const [showSetup, setShowSetup] = useState(false)
  const [withSelection, setWithSelection] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  // Bring the model up the first time the panel is opened.
  useEffect(() => {
    if (useStore.getState().ai.state === 'idle') void era.deploy()
    inputRef.current?.focus()
  }, [])

  const ready = ai.state === 'ready'
  const setupVisible = showSetup || !ready
  const submit = (): void => {
    if (!draft.trim() || busy) return
    void era.send(draft, { includeSelection: withSelection })
  }

  return (
    <div className="ai-view">
      <div className="ai-header">
        <span className={`ai-dot ${ai.state}`} />
        <div className="ai-model" title={ai.eracore ? `eraCore ${ai.eracore} · Python ${ai.python}` : undefined}>
          <strong>{era.modelLabel(settings)}</strong>
          <small>
            {era.BACKEND_LABEL[settings.backend]}
            {ai.eracore ? ` · eraCore ${ai.eracore}` : ''}
          </small>
        </div>
        <div className="header-actions">
          <button title="Новый чат" onClick={() => era.clearChat()}>
            <IconPlus size={15} />
          </button>
          <button title="Настройки модели" onClick={() => setShowSetup(!showSetup)}>
            <IconSettings size={15} />
          </button>
        </div>
      </div>

      {setupVisible && <Setup onClose={ready ? () => setShowSetup(false) : undefined} />}

      <div className="ai-messages" ref={listRef}>
        {messages.length === 0 && ready && (
          <div className="ai-empty">
            <IconSparkle size={22} />
            <p>Модель готова. Спросите про код или попросите что-нибудь изменить: eraAI прочитает файлы и предложит правки.</p>
            {!root && <p className="ai-hint">Откройте папку проекта, чтобы eraAI мог читать и править файлы.</p>}
            <div className="ai-suggest">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => era.send(s, { includeSelection: withSelection })}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <Message key={m.id} msg={m} busy={busy === m.id} />
        ))}
      </div>

      <div className="ai-input">
        <textarea
          ref={inputRef}
          value={draft}
          rows={Math.min(8, Math.max(2, draft.split('\n').length))}
          placeholder={ready ? 'Спросите eraAI… (Enter — отправить, Shift+Enter — новая строка)' : 'Сначала разверните модель'}
          spellCheck={false}
          onChange={(e) => setState({ aiDraft: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="ai-input-bar">
          <label className="ai-check small" title="Передать модели выделенный в редакторе фрагмент">
            <input type="checkbox" checked={withSelection} onChange={(e) => setWithSelection(e.target.checked)} />
            контекст: файл и выделение
          </label>
          {busy ? (
            <button className="btn-ghost ai-send" onClick={() => era.stop()}>
              Стоп
            </button>
          ) : (
            <button className="btn-primary ai-send" disabled={!draft.trim()} onClick={submit} title={formatKeys(['enter'])}>
              Отправить
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
