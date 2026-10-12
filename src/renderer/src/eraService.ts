import type { EraSettings } from '@shared/types'
import * as ed from './editorService'
import { getState, setState, type AiMessage, type AiPart, type AiToolCard, type AiToolStatus } from './store'
import { focusSidebar, toast, updateSettings } from './actions'
import { prepareTool, ToolError } from './aiTools'
import { runInTerminal } from './terminalService'
import { basename, relative } from './lib/path'

const api = window.ecode

let listening = false
let configured: ((ok: boolean) => void) | null = null
/** callId → resolver for edits waiting on "Принять / Отклонить". */
const approvals = new Map<string, (ok: boolean) => void>()
let nextId = 1

const era = (): EraSettings => getState().settings.era

export const BACKEND_LABEL: Record<EraSettings['backend'], string> = {
  ollama: 'Ollama',
  openai: 'OpenAI API',
  gguf: 'GGUF',
  mock: 'Mock'
}

export function modelLabel(s: EraSettings = era()): string {
  if (s.backend === 'gguf') return s.ggufPath ? basename(s.ggufPath) : 'GGUF не выбран'
  if (s.backend === 'mock') return 'mock (без модели)'
  return s.model || '—'
}

export function updateEra(patch: Partial<EraSettings>): void {
  updateSettings({ era: { ...era(), ...patch } })
}

// ─────────────────────────── messages ───────────────────────────

function patchMessage(id: string, fn: (m: AiMessage) => AiMessage): void {
  setState((s) => ({ aiMessages: s.aiMessages.map((m) => (m.id === id ? fn(m) : m)) }))
}

function appendText(id: string, text: string): void {
  patchMessage(id, (m) => {
    const parts = [...m.parts]
    const last = parts[parts.length - 1]
    if (last?.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: last.text + text }
    else parts.push({ kind: 'text', text })
    return { ...m, parts }
  })
}

function addCard(id: string, card: AiToolCard): void {
  patchMessage(id, (m) => ({ ...m, parts: [...m.parts, { kind: 'tool', card }] }))
}

function patchCard(id: string, callId: string, patch: Partial<AiToolCard>): void {
  patchMessage(id, (m) => ({
    ...m,
    parts: m.parts.map((p): AiPart => (p.kind === 'tool' && p.card.callId === callId ? { kind: 'tool', card: { ...p.card, ...patch } } : p))
  }))
}

/** What the model sees from earlier turns: user text and the assistant's prose plus a note of its actions. */
function historyForModel(): { role: string; content: string }[] {
  return getState().aiMessages.map((m) => {
    const text = m.parts.map((p) => (p.kind === 'text' ? p.text : `[${p.card.summary} — ${statusWord(p.card.status)}]`)).join('\n')
    return { role: m.role, content: text.trim() }
  })
}

function statusWord(s: AiToolStatus): string {
  return { running: 'выполняется', pending: 'ожидает', applied: 'применено', rejected: 'отклонено', done: 'готово', error: 'ошибка' }[s]
}

// ─────────────────────────── bridge events ───────────────────────────

function listen(): void {
  if (listening) return
  listening = true
  api.onEraEvent((msg) => {
    switch (msg.type) {
      case 'configured': {
        const ok = !!msg.ok
        setState((s) => ({
          ai: ok ? { ...s.ai, state: 'ready', message: undefined } : { ...s.ai, state: 'error', message: String(msg.error ?? 'Ошибка загрузки модели') }
        }))
        configured?.(ok)
        configured = null
        break
      }
      case 'token':
        appendText(String(msg.id), String(msg.text ?? ''))
        break
      case 'tool_call':
        void handleToolCall(String(msg.id), String(msg.call_id), String(msg.name), (msg.args as Record<string, unknown>) ?? {})
        break
      case 'error':
        if (msg.id) patchMessage(String(msg.id), (m) => ({ ...m, error: String(msg.message) }))
        else toast(`eraAI: ${msg.message}`, 'error')
        break
      case 'done':
        if (getState().aiBusy === msg.id) setState({ aiBusy: null })
        break
      case 'exit': {
        const busy = getState().aiBusy
        if (busy) patchMessage(busy, (m) => ({ ...m, error: 'Процесс eraCore завершился' }))
        setState({ aiBusy: null, ai: { state: 'error', message: `Мост eraCore остановился${msg.log ? `:\n${msg.log}` : ''}` } })
        rejectAllPending()
        break
      }
    }
  })
}

async function handleToolCall(id: string, callId: string, name: string, args: Record<string, unknown>): Promise<void> {
  const card: AiToolCard = { callId, name, args, status: 'running', summary: `${TOOL_TITLES[name] ?? name}…` }
  addCard(id, card)
  const reply = (ok: boolean, result: string): void => api.eraSend({ type: 'tool_result', call_id: callId, ok, result })
  try {
    const run = await prepareTool(name, args)
    if (!run.apply) {
      patchCard(id, callId, { status: 'done', summary: run.summary, result: run.result })
      reply(true, run.result ?? '')
      return
    }
    patchCard(id, callId, { summary: run.summary, preview: run.preview, status: era().autoApply ? 'running' : 'pending' })
    const approved = era().autoApply || (await new Promise<boolean>((res) => approvals.set(callId, res)))
    approvals.delete(callId)
    if (!approved) {
      patchCard(id, callId, { status: 'rejected' })
      reply(false, 'Пользователь отклонил это изменение. Спроси, что сделать иначе, или предложи другой вариант.')
      return
    }
    const result = await run.apply()
    patchCard(id, callId, { status: 'applied', result })
    reply(true, result)
  } catch (err) {
    const message = err instanceof ToolError ? err.message : String((err as Error)?.message ?? err)
    const title = TOOL_TITLES[name] ?? name
    const path = typeof args.path === 'string' ? ` ${args.path}` : ''
    patchCard(id, callId, { status: 'error', summary: `${title}${path}: ${message}`, result: message })
    reply(false, message)
  }
}

const TOOL_TITLES: Record<string, string> = {
  read_file: 'Чтение',
  list_files: 'Список файлов',
  search: 'Поиск',
  replace_lines: 'Замена строк',
  insert_lines: 'Вставка',
  replace_text: 'Правка',
  write_file: 'Запись'
}

function rejectAllPending(): void {
  for (const res of approvals.values()) res(false)
  approvals.clear()
}

export function approve(callId: string, ok: boolean): void {
  approvals.get(callId)?.(ok)
}

// ─────────────────────────── lifecycle ───────────────────────────

/** Start (or restart) the bridge and load the configured model. */
export async function deploy(): Promise<boolean> {
  listen()
  const s = era()
  if (s.backend === 'gguf' && !s.ggufPath) {
    setState({ ai: { state: 'error', message: 'Выберите файл модели .gguf' } })
    return false
  }
  setState({ ai: { state: 'starting', message: 'Запуск Python…' } })
  let hello
  try {
    hello = await api.eraStart(s.pythonPath)
  } catch (err) {
    setState({ ai: { state: 'error', message: cleanError(err) } })
    return false
  }
  if (!hello.eracore) {
    setState({
      ai: { state: 'missing', python: hello.python, pythonPath: hello.pythonPath, message: hello.error ?? 'Пакет eraCore не найден' }
    })
    return false
  }
  setState({
    ai: {
      state: 'loading',
      eracore: hello.eracore,
      python: hello.python,
      pythonPath: hello.pythonPath,
      message: s.backend === 'gguf' ? 'Загрузка модели в память…' : 'Подключение к модели…'
    }
  })
  const done = new Promise<boolean>((res) => (configured = res))
  api.eraSend({
    type: 'configure',
    backend: {
      kind: s.backend,
      url: s.url,
      model: s.model,
      path: s.ggufPath,
      apiKey: s.apiKey,
      temperature: s.temperature,
      maxTokens: s.maxTokens
    }
  })
  return done
}

export async function shutdown(): Promise<void> {
  rejectAllPending()
  await api.eraStop()
  setState({ ai: { state: 'idle' }, aiBusy: null })
}

function cleanError(err: unknown): string {
  return String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
}

function pip(pkg: string): void {
  const py = getState().ai.pythonPath || era().pythonPath || (api.platform === 'win32' ? 'py' : 'python3')
  void runInTerminal(`${py} -m pip install -U ${pkg}`)
  toast('Установка запущена в терминале. Когда закончится, нажмите «Развернуть».')
}

export const installEraCore = (): void => pip('eracore')
export const installLlamaCpp = (): void => pip('llama-cpp-python')

// ─────────────────────────── chat ───────────────────────────

function buildContext(includeSelection: boolean): Record<string, unknown> {
  const { root, active, tabs, cursor } = getState()
  const real = (p: string | null): p is string => !!p && !p.startsWith('untitled:') && !p.startsWith('diff:')
  const sel = includeSelection ? ed.getSelectionInfo() : null
  return {
    root,
    rootName: root ? basename(root) : null,
    activeFile: real(active) ? relative(root, active) : null,
    cursorLine: real(active) ? cursor.line : null,
    selection: sel && real(active) ? sel : null,
    openFiles: tabs.map((t) => t.path).filter(real).map((p) => relative(root, p))
  }
}

export async function send(prompt: string, opts: { includeSelection?: boolean } = {}): Promise<void> {
  const text = prompt.trim()
  if (!text || getState().aiBusy) return
  if (getState().ai.state !== 'ready' && !(await deploy())) {
    toast('Сначала разверните модель в панели eraAI', 'error')
    return
  }
  const history = [...historyForModel(), { role: 'user', content: text }]
  const userMsg: AiMessage = { id: `u${nextId++}`, role: 'user', parts: [{ kind: 'text', text }] }
  const id = `a${nextId++}`
  setState((s) => ({
    aiMessages: [...s.aiMessages, userMsg, { id, role: 'assistant', parts: [] }],
    aiBusy: id,
    aiDraft: ''
  }))
  api.eraSend({ type: 'chat', id, history, context: buildContext(opts.includeSelection ?? true) })
}

export function stop(): void {
  const id = getState().aiBusy
  if (!id) return
  rejectAllPending()
  api.eraSend({ type: 'cancel', id })
}

export function clearChat(): void {
  stop()
  setState({ aiMessages: [] })
}

/** Editor commands: send the selection (or the whole file) with an instruction. */
export function askAboutSelection(kind: 'explain' | 'fix' | 'docs'): void {
  const sel = ed.getSelectionInfo()
  const what = sel ? `выделенный фрагмент (строки ${sel.startLine}–${sel.endLine})` : 'открытый файл'
  const prompts = {
    explain: `Объясни ${what}: что он делает и на что обратить внимание.`,
    fix: `Найди ошибки в ${what === 'открытый файл' ? 'открытом файле' : 'выделенном фрагменте'} и исправь их прямо в файле.`,
    docs: `Добавь документацию (docstring/JSDoc) к функциям и классам: ${what}. Логику не меняй.`
  }
  focusSidebar('ai')
  void send(prompts[kind], { includeSelection: true })
}
