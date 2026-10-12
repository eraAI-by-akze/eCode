import * as a from './actions'
import * as ed from './editorService'
import * as scm from './scm'
import * as term from './terminalService'
import * as era from './eraService'
import * as tasks from './taskService'
import { getState } from './store'
import { extname, isUntitled } from './lib/path'

export interface Command {
  id: string
  label: string
  /** e.g. "mod+shift+p" — mod is Cmd on macOS, Ctrl elsewhere. */
  keys?: string[]
  run: () => void
  when?: () => boolean
  /** Also fires while the terminal has focus (otherwise the key goes to the shell). */
  global?: boolean
}

const hasFile = (): boolean => !!getState().active
const hasRoot = (): boolean => !!getState().root
const hasRepo = (): boolean => !!getState().git
const hasRealFile = (): boolean => {
  const p = getState().active
  return !!p && !isUntitled(p) && !p.startsWith('diff:')
}

const quote = (p: string): string =>
  window.ecode.platform === 'win32' ? `"${p}"` : `"${p.replace(/(["\\$`])/g, '\\$1')}"`

const RUNNERS: Record<string, (q: string) => string> = {
  py: (q) => `${window.ecode.platform === 'win32' ? 'python' : 'python3'} ${q}`,
  js: (q) => `node ${q}`,
  mjs: (q) => `node ${q}`,
  cjs: (q) => `node ${q}`,
  ts: (q) => `npx --yes tsx ${q}`,
  sh: (q) => `bash ${q}`,
  rb: (q) => `ruby ${q}`,
  go: (q) => `go run ${q}`,
  ps1: (q) => `pwsh -File ${q}`
}

async function runActiveFile(): Promise<void> {
  const p = getState().active
  if (!p) return
  const fromPlugin = await tasks.runnerFor(p).catch((err: Error) => {
    a.toast(err.message, 'error')
    return undefined
  })
  if (fromPlugin === undefined) return
  if (fromPlugin) {
    await a.save(p)
    const { command, cwd } = fromPlugin
    await term.runInTerminal(window.ecode.platform === 'win32' ? `cd "${cwd}"; ${command}` : `cd "${cwd}" && ${command}`)
    return
  }
  const runner = RUNNERS[extname(p)]
  if (!runner) {
    a.toast('Не знаю, как запустить этот тип файла')
    return
  }
  await a.save(p)
  await term.runInTerminal(runner(quote(p)))
}

export const COMMANDS: Command[] = [
  { id: 'quickOpen', label: 'Перейти к файлу…', keys: ['mod+p'], run: () => a.openQuick(''), global: true },
  { id: 'palette', label: 'Палитра команд', keys: ['mod+shift+p', 'f1'], run: () => a.openQuick('>'), global: true },
  { id: 'goToLine', label: 'Перейти к строке…', keys: ['ctrl+g'], run: () => a.openQuick(':'), when: hasFile },
  { id: 'openFolder', label: 'Открыть папку…', keys: ['mod+o'], run: () => a.openFolder() },
  { id: 'openFile', label: 'Открыть файл…', run: () => a.openFileDialog() },
  { id: 'openRecent', label: 'Открыть недавнюю папку…', keys: ['mod+r'], run: () => a.pickRecent() },
  { id: 'closeFolder', label: 'Закрыть папку', run: () => a.closeFolder(), when: hasRoot },
  { id: 'newFile', label: 'Новый файл', keys: ['mod+n'], run: () => a.beginCreate('newFile') },
  { id: 'newFolder', label: 'Новая папка', run: () => a.beginCreate('newFolder'), when: hasRoot },
  { id: 'save', label: 'Сохранить', keys: ['mod+s'], run: () => a.save(), when: hasFile },
  { id: 'saveAs', label: 'Сохранить как…', keys: ['mod+shift+s'], run: () => a.saveAs(), when: hasFile },
  { id: 'saveAll', label: 'Сохранить все', keys: ['mod+alt+s'], run: () => a.saveAll() },
  {
    id: 'closeTab',
    label: 'Закрыть вкладку',
    keys: ['mod+w'],
    run: () => {
      const p = getState().active
      if (p) a.closeTab(p)
    },
    when: hasFile
  },
  { id: 'closeAll', label: 'Закрыть все вкладки', run: () => a.closeAll() },
  { id: 'nextTab', label: 'Следующая вкладка', keys: ['ctrl+tab'], run: () => a.cycleTab(1), global: true },
  { id: 'prevTab', label: 'Предыдущая вкладка', keys: ['ctrl+shift+tab'], run: () => a.cycleTab(-1), global: true },
  { id: 'explorer', label: 'Показать проводник', keys: ['mod+shift+e'], run: () => a.focusSidebar('explorer'), global: true },
  { id: 'search', label: 'Поиск по файлам', keys: ['mod+shift+f'], run: () => a.focusSidebar('search'), global: true },
  { id: 'scm', label: 'Git: показать изменения', keys: ['ctrl+shift+g'], run: () => a.focusSidebar('scm'), global: true },
  { id: 'settings', label: 'Настройки', keys: ['mod+,'], run: () => a.focusSidebar('settings'), global: true },
  { id: 'toggleSidebar', label: 'Показать/скрыть боковую панель', keys: ['mod+b'], run: () => a.toggleSidebar(), global: true },
  { id: 'togglePanel', label: 'Показать/скрыть панель', keys: ['mod+j', 'ctrl+`'], run: () => a.togglePanel(), global: true },
  {
    id: 'newTerminal',
    label: 'Новый терминал',
    keys: ['ctrl+shift+`'],
    run: () => {
      a.showPanel('terminal')
      void term.createTerminal()
    },
    global: true
  },
  {
    id: 'killTerminal',
    label: 'Закрыть активный терминал',
    run: () => {
      const id = getState().activeTerminal
      if (id !== null) term.closeTerminal(id)
    },
    when: () => getState().activeTerminal !== null
  },
  { id: 'problems', label: 'Показать проблемы', keys: ['mod+shift+m'], run: () => a.showPanel('problems'), global: true },
  { id: 'runFile', label: 'Запустить текущий файл в терминале', keys: ['ctrl+f5'], run: () => void runActiveFile(), when: hasRealFile },
  { id: 'gitCommit', label: 'Git: коммит', run: () => scm.commit(), when: hasRepo },
  { id: 'gitPush', label: 'Git: отправить (push)', run: () => scm.sync('push'), when: hasRepo },
  { id: 'gitPull', label: 'Git: получить (pull)', run: () => scm.sync('pull'), when: hasRepo },
  { id: 'gitFetch', label: 'Git: fetch', run: () => scm.sync('fetch'), when: hasRepo },
  { id: 'gitBranch', label: 'Git: сменить ветку…', run: () => scm.pickBranch(), when: hasRepo },
  { id: 'gitInit', label: 'Git: инициализировать репозиторий', run: () => scm.initRepo(), when: () => hasRoot() && !hasRepo() },
  { id: 'tasks.run', label: 'Задачи: выполнить…', run: () => void tasks.runGroup('any'), when: hasRoot },
  { id: 'tasks.quickBuild', label: 'Собрать (последняя задача сборки)', keys: ['f5'], run: () => void tasks.quickBuild(), when: hasRoot, global: true },
  { id: 'tasks.build', label: 'Задачи: собрать проект…', keys: ['mod+shift+b'], run: () => void tasks.runGroup('build'), when: hasRoot, global: true },
  { id: 'tasks.check', label: 'Задачи: проверить проект на ошибки', run: () => void tasks.runGroup('check'), when: hasRoot },
  { id: 'tasks.test', label: 'Задачи: запустить тесты', run: () => void tasks.runGroup('test'), when: hasRoot },
  { id: 'tasks.format', label: 'Задачи: форматировать проект', run: () => void tasks.runGroup('format'), when: hasRoot },
  { id: 'tasks.stop', label: 'Задачи: остановить', keys: ['shift+f5'], run: () => tasks.stopTask(), when: () => !!getState().task, global: true },
  { id: 'tasks.clear', label: 'Задачи: очистить найденные ошибки', run: () => tasks.clearTaskProblems() },
  { id: 'output', label: 'Показать вывод задач', run: () => a.showPanel('output') },
  { id: 'plugins', label: 'Плагины', keys: ['mod+shift+x'], run: () => a.focusSidebar('plugins'), global: true },
  { id: 'errorLens', label: 'Ошибки в строке (Error Lens): вкл/выкл', run: () => a.updateSettings({ errorLens: !getState().settings.errorLens }) },
  { id: 'aiChat', label: 'eraAI: открыть чат', keys: ['mod+shift+a'], run: () => a.focusSidebar('ai'), global: true },
  { id: 'aiDeploy', label: 'eraAI: развернуть модель', run: () => void era.deploy() },
  { id: 'aiExplain', label: 'eraAI: объяснить выделенное', run: () => era.askAboutSelection('explain'), when: hasRealFile },
  { id: 'aiFix', label: 'eraAI: исправить выделенное', run: () => era.askAboutSelection('fix'), when: hasRealFile },
  { id: 'aiDocs', label: 'eraAI: добавить документацию', run: () => era.askAboutSelection('docs'), when: hasRealFile },
  { id: 'aiStop', label: 'eraAI: остановить генерацию', run: () => era.stop(), when: () => !!getState().aiBusy },
  { id: 'restartLsp', label: 'Перезапустить языковые серверы', run: () => a.restartLanguageServers(), when: hasRoot },
  { id: 'goToDefinition', label: 'Перейти к определению', run: () => ed.runEditorAction('editor.action.revealDefinition'), when: hasRealFile },
  { id: 'renameSymbol', label: 'Переименовать символ', run: () => ed.runEditorAction('editor.action.rename'), when: hasRealFile },
  { id: 'theme', label: 'Сменить тему…', run: () => a.pickTheme() },
  { id: 'language', label: 'Сменить язык файла…', run: () => a.pickLanguage(), when: hasFile },
  {
    id: 'revealActive',
    label: 'Показать активный файл в проводнике',
    run: () => {
      const p = getState().active
      if (p) a.revealInTree(p)
    },
    when: hasFile
  },
  { id: 'refresh', label: 'Обновить проводник', run: () => a.refreshTree(), when: hasRoot },
  { id: 'collapse', label: 'Свернуть все папки', run: () => a.collapseAll(), when: hasRoot },
  { id: 'format', label: 'Форматировать документ', keys: ['shift+alt+f'], run: () => ed.runEditorAction('editor.action.formatDocument'), when: hasFile },
  { id: 'find', label: 'Найти в файле', run: () => ed.runEditorAction('actions.find'), when: hasFile },
  { id: 'replace', label: 'Заменить в файле', run: () => ed.runEditorAction('editor.action.startFindReplaceAction'), when: hasFile },
  { id: 'comment', label: 'Закомментировать строку', run: () => ed.runEditorAction('editor.action.commentLine'), when: hasFile },
  { id: 'symbol', label: 'Перейти к символу в файле…', keys: ['mod+shift+o'], run: () => ed.runEditorAction('editor.action.quickOutline'), when: hasFile },
  {
    id: 'wordWrap',
    label: 'Перенос строк: вкл/выкл',
    keys: ['alt+z'],
    run: () => a.updateSettings({ wordWrap: !getState().settings.wordWrap })
  },
  { id: 'minimap', label: 'Мини-карта: вкл/выкл', run: () => a.updateSettings({ minimap: !getState().settings.minimap }) },
  { id: 'zoomIn', label: 'Увеличить шрифт', keys: ['mod+=', 'mod+shift+='], run: () => a.zoom(1), global: true },
  { id: 'zoomOut', label: 'Уменьшить шрифт', keys: ['mod+-'], run: () => a.zoom(-1), global: true },
  { id: 'zoomReset', label: 'Сбросить размер шрифта', keys: ['mod+0'], run: () => a.zoom(0), global: true },
  { id: 'devtools', label: 'Инструменты разработчика', keys: ['mod+shift+i'], run: () => window.ecode.toggleDevTools(), global: true }
]

const isMac = window.ecode.platform === 'darwin'

/** Normalise a keyboard event into the "mod+shift+key" form used above. */
export function eventToKeys(e: KeyboardEvent): string {
  const parts: string[] = []
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('mod')
  if (isMac && e.ctrlKey) parts.push('ctrl')
  if (!isMac && e.metaKey) parts.push('meta')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  let key = e.key.toLowerCase()
  // With Alt/Shift on some layouts e.key changes; fall back to the physical key.
  if (e.code.startsWith('Key')) key = e.code.slice(3).toLowerCase()
  else if (e.code.startsWith('Digit')) key = e.code.slice(5)
  else if (e.code === 'Backquote') key = '`'
  else if (e.code === 'Equal') key = '='
  else if (e.code === 'Minus') key = '-'
  else if (e.code === 'Comma') key = ','
  else if (e.code === 'Enter') key = 'enter'
  parts.push(key)
  return parts.join('+')
}

const MOD_ORDER = ['mod', 'ctrl', 'meta', 'alt', 'shift']

/** Put modifiers in the same order eventToKeys() emits them. */
function normalizeKeys(k: string): string {
  const parts = k.split('+')
  const key = parts.pop()!
  // On macOS "ctrl+g" etc. stay literal ctrl; elsewhere ctrl is the mod key.
  const mods = new Set(parts.map((p) => (!isMac && p === 'ctrl' ? 'mod' : p)))
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+')
}

const byKeys = new Map<string, Command>()
for (const c of COMMANDS) {
  for (const k of c.keys ?? []) byKeys.set(normalizeKeys(k), c)
}

export function commandForEvent(e: KeyboardEvent): Command | undefined {
  return byKeys.get(eventToKeys(e))
}

export function formatKeys(keys?: string[]): string {
  if (!keys?.length) return ''
  return keys[0]
    .split('+')
    .map((p) => {
      switch (p) {
        case 'mod':
          return isMac ? '⌘' : 'Ctrl'
        case 'shift':
          return isMac ? '⇧' : 'Shift'
        case 'alt':
          return isMac ? '⌥' : 'Alt'
        case 'ctrl':
          return isMac ? '⌃' : 'Ctrl'
        case 'tab':
          return 'Tab'
        default:
          return p.toUpperCase()
      }
    })
    .join(isMac ? '' : '+')
}

export function runCommand(id: string): void {
  const c = COMMANDS.find((x) => x.id === id)
  if (c && (!c.when || c.when())) c.run()
}
