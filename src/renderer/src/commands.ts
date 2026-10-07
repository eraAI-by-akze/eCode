import * as a from './actions'
import * as ed from './editorService'
import { getState } from './store'

export interface Command {
  id: string
  label: string
  /** e.g. "mod+shift+p" — mod is Cmd on macOS, Ctrl elsewhere. */
  keys?: string[]
  run: () => void
  when?: () => boolean
}

const hasFile = (): boolean => !!getState().active
const hasRoot = (): boolean => !!getState().root

export const COMMANDS: Command[] = [
  { id: 'quickOpen', label: 'Перейти к файлу…', keys: ['mod+p'], run: () => a.openQuick('') },
  { id: 'palette', label: 'Палитра команд', keys: ['mod+shift+p', 'f1'], run: () => a.openQuick('>') },
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
  { id: 'nextTab', label: 'Следующая вкладка', keys: ['ctrl+tab'], run: () => a.cycleTab(1) },
  { id: 'prevTab', label: 'Предыдущая вкладка', keys: ['ctrl+shift+tab'], run: () => a.cycleTab(-1) },
  { id: 'explorer', label: 'Показать проводник', keys: ['mod+shift+e'], run: () => a.focusSidebar('explorer') },
  { id: 'search', label: 'Поиск по файлам', keys: ['mod+shift+f'], run: () => a.focusSidebar('search') },
  { id: 'settings', label: 'Настройки', keys: ['mod+,'], run: () => a.focusSidebar('settings') },
  { id: 'toggleSidebar', label: 'Показать/скрыть боковую панель', keys: ['mod+b'], run: () => a.toggleSidebar() },
  { id: 'togglePanel', label: 'Показать/скрыть терминал', keys: ['mod+j', 'ctrl+`'], run: () => a.togglePanel() },
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
  { id: 'zoomIn', label: 'Увеличить шрифт', keys: ['mod+=', 'mod+shift+='], run: () => a.zoom(1) },
  { id: 'zoomOut', label: 'Уменьшить шрифт', keys: ['mod+-'], run: () => a.zoom(-1) },
  { id: 'zoomReset', label: 'Сбросить размер шрифта', keys: ['mod+0'], run: () => a.zoom(0) },
  { id: 'devtools', label: 'Инструменты разработчика', keys: ['mod+shift+i'], run: () => window.ecode.toggleDevTools() }
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
  parts.push(key)
  return parts.join('+')
}

const byKeys = new Map<string, Command>()
for (const c of COMMANDS) {
  for (const k of c.keys ?? []) {
    // On macOS "ctrl+g" etc. stay literal ctrl; elsewhere ctrl is the mod key.
    const normalized = !isMac ? k.replace(/^ctrl\+/, 'mod+') : k
    byKeys.set(normalized, c)
  }
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
