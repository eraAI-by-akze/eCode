import type { editor } from 'monaco-editor'
import type { ThemeId } from '@shared/types'

export interface AppTheme {
  id: ThemeId
  name: string
  tagline: string
  dark: boolean
  /** Applied to :root as CSS custom properties. */
  vars: Record<string, string>
  monaco: editor.IStandaloneThemeData
}

const darkRules = (p: {
  comment: string
  keyword: string
  string: string
  number: string
  type: string
  fn: string
  tag: string
  attr: string
  fg: string
  muted: string
}): editor.ITokenThemeRule[] => [
  { token: '', foreground: p.fg },
  { token: 'comment', foreground: p.comment, fontStyle: 'italic' },
  { token: 'keyword', foreground: p.keyword },
  { token: 'keyword.flow', foreground: p.keyword },
  { token: 'storage', foreground: p.keyword },
  { token: 'string', foreground: p.string },
  { token: 'string.escape', foreground: p.number },
  { token: 'regexp', foreground: p.number },
  { token: 'number', foreground: p.number },
  { token: 'constant', foreground: p.number },
  { token: 'type', foreground: p.type },
  { token: 'type.identifier', foreground: p.type },
  { token: 'identifier', foreground: p.fg },
  { token: 'variable', foreground: p.fg },
  { token: 'variable.predefined', foreground: p.fn },
  { token: 'predefined', foreground: p.fn },
  { token: 'function', foreground: p.fn },
  { token: 'delimiter', foreground: p.muted },
  { token: 'operator', foreground: p.keyword },
  { token: 'tag', foreground: p.tag },
  { token: 'metatag', foreground: p.tag },
  { token: 'attribute.name', foreground: p.attr },
  { token: 'attribute.value', foreground: p.string },
  { token: 'key', foreground: p.attr },
  { token: 'string.key.json', foreground: p.attr },
  { token: 'string.value.json', foreground: p.string },
  { token: 'emphasis', fontStyle: 'italic' },
  { token: 'strong', fontStyle: 'bold' },
  { token: 'keyword.md', foreground: p.keyword },
  { token: 'variable.source', foreground: p.fn }
]

export const THEMES: Record<ThemeId, AppTheme> = {
  'era-glass': {
    id: 'era-glass',
    name: 'Era Glass',
    tagline: 'Тёмное стекло, фиолетово-бирюзовое свечение eraAI',
    dark: true,
    vars: {
      '--bg': '#0b0a12',
      '--bg-glow-1': 'rgba(124, 92, 255, 0.28)',
      '--bg-glow-2': 'rgba(34, 211, 238, 0.16)',
      '--surface': 'rgba(22, 19, 36, 0.62)',
      '--surface-2': 'rgba(30, 26, 48, 0.72)',
      '--surface-solid': '#15131f',
      '--editor-bg': 'rgba(13, 11, 22, 0.55)',
      '--elevated': 'rgba(28, 24, 44, 0.92)',
      '--border': 'rgba(255, 255, 255, 0.07)',
      '--border-strong': 'rgba(255, 255, 255, 0.14)',
      '--text': '#e9e7f5',
      '--text-muted': '#8f8ba8',
      '--text-faint': '#5d5975',
      '--hover': 'rgba(255, 255, 255, 0.05)',
      '--active': 'rgba(139, 92, 246, 0.18)',
      '--accent': '#9b7bff',
      '--accent-2': '#22d3ee',
      '--accent-gradient': 'linear-gradient(135deg, #8b5cf6 0%, #22d3ee 100%)',
      '--accent-contrast': '#ffffff',
      '--danger': '#ff6b8b',
      '--warning': '#fbbf24',
      '--success': '#34d399',
      '--blur': '22px',
      '--shadow': '0 20px 60px rgba(0, 0, 0, 0.55)'
    },
    monaco: {
      base: 'vs-dark',
      inherit: true,
      rules: darkRules({
        fg: 'e9e7f5',
        muted: '9a96b5',
        comment: '6b6789',
        keyword: 'c4a1ff',
        string: '7ee7c7',
        number: 'ffb86b',
        type: '67e8f9',
        fn: '93c5fd',
        tag: 'f0a6ff',
        attr: '9fb3ff'
      }),
      colors: {
        focusBorder: '#00000000',
        'editor.background': '#00000000',
        'editor.foreground': '#e9e7f5',
        'editorLineNumber.foreground': '#4b4766',
        'editorLineNumber.activeForeground': '#c4b5fd',
        'editor.lineHighlightBackground': '#ffffff08',
        'editor.lineHighlightBorder': '#00000000',
        'editor.selectionBackground': '#8b5cf655',
        'editor.inactiveSelectionBackground': '#8b5cf62a',
        'editor.selectionHighlightBackground': '#22d3ee22',
        'editor.wordHighlightBackground': '#22d3ee1e',
        'editor.findMatchBackground': '#f59e0b66',
        'editor.findMatchHighlightBackground': '#f59e0b2e',
        'editorCursor.foreground': '#22d3ee',
        'editorIndentGuide.background1': '#ffffff0c',
        'editorIndentGuide.activeBackground1': '#ffffff26',
        'editorBracketMatch.background': '#8b5cf633',
        'editorBracketMatch.border': '#8b5cf6aa',
        'editorWidget.background': '#1c182c',
        'editorWidget.border': '#ffffff1a',
        'editorSuggestWidget.background': '#1c182c',
        'editorSuggestWidget.selectedBackground': '#8b5cf640',
        'editorHoverWidget.background': '#1c182c',
        'input.background': '#120f1e',
        'minimap.background': '#00000000',
        'scrollbarSlider.background': '#ffffff14',
        'scrollbarSlider.hoverBackground': '#ffffff24',
        'scrollbarSlider.activeBackground': '#8b5cf666',
        'editorGutter.background': '#00000000',
        'editorOverviewRuler.border': '#00000000'
      }
    }
  },

  graphite: {
    id: 'graphite',
    name: 'Graphite',
    tagline: 'Матовый графит, тёплый янтарь, ноль отвлечений',
    dark: true,
    vars: {
      '--bg': '#121212',
      '--bg-glow-1': 'rgba(245, 165, 36, 0.06)',
      '--bg-glow-2': 'rgba(255, 107, 53, 0.04)',
      '--surface': '#171717',
      '--surface-2': '#1d1d1d',
      '--surface-solid': '#171717',
      '--editor-bg': '#141414',
      '--elevated': '#222222',
      '--border': '#262626',
      '--border-strong': '#333333',
      '--text': '#e7e5e4',
      '--text-muted': '#a3a09c',
      '--text-faint': '#6b6864',
      '--hover': 'rgba(255, 255, 255, 0.04)',
      '--active': 'rgba(245, 165, 36, 0.12)',
      '--accent': '#f5a524',
      '--accent-2': '#ff6b35',
      '--accent-gradient': 'linear-gradient(135deg, #f5a524 0%, #ff6b35 100%)',
      '--accent-contrast': '#1a1206',
      '--danger': '#f87171',
      '--warning': '#fbbf24',
      '--success': '#86efac',
      '--blur': '0px',
      '--shadow': '0 16px 48px rgba(0, 0, 0, 0.6)'
    },
    monaco: {
      base: 'vs-dark',
      inherit: true,
      rules: darkRules({
        fg: 'e7e5e4',
        muted: 'a8a29e',
        comment: '6b6864',
        keyword: 'f5a524',
        string: 'a3d977',
        number: 'ff8a5c',
        type: 'f2d58a',
        fn: '9cc9ff',
        tag: 'ff8a5c',
        attr: 'f2d58a'
      }),
      colors: {
        focusBorder: '#00000000',
        'editor.background': '#141414',
        'editor.foreground': '#e7e5e4',
        'editorLineNumber.foreground': '#454340',
        'editorLineNumber.activeForeground': '#f5a524',
        'editor.lineHighlightBackground': '#ffffff06',
        'editor.lineHighlightBorder': '#00000000',
        'editor.selectionBackground': '#f5a52440',
        'editor.inactiveSelectionBackground': '#f5a5241f',
        'editor.selectionHighlightBackground': '#f5a5241a',
        'editor.wordHighlightBackground': '#ffffff12',
        'editor.findMatchBackground': '#ff6b3566',
        'editor.findMatchHighlightBackground': '#ff6b352a',
        'editorCursor.foreground': '#f5a524',
        'editorIndentGuide.background1': '#ffffff0a',
        'editorIndentGuide.activeBackground1': '#ffffff22',
        'editorBracketMatch.background': '#f5a52426',
        'editorBracketMatch.border': '#f5a52499',
        'editorWidget.background': '#1f1f1f',
        'editorWidget.border': '#333333',
        'editorSuggestWidget.background': '#1f1f1f',
        'editorSuggestWidget.selectedBackground': '#f5a52430',
        'editorHoverWidget.background': '#1f1f1f',
        'input.background': '#141414',
        'minimap.background': '#141414',
        'scrollbarSlider.background': '#ffffff12',
        'scrollbarSlider.hoverBackground': '#ffffff20',
        'scrollbarSlider.activeBackground': '#f5a52455',
        'editorOverviewRuler.border': '#00000000'
      }
    }
  },

  'aurora-light': {
    id: 'aurora-light',
    name: 'Aurora Light',
    tagline: 'Светлое матовое стекло с мягким северным сиянием',
    dark: false,
    vars: {
      '--bg': '#f4f3fa',
      '--bg-glow-1': 'rgba(129, 140, 248, 0.30)',
      '--bg-glow-2': 'rgba(236, 72, 153, 0.18)',
      '--surface': 'rgba(255, 255, 255, 0.62)',
      '--surface-2': 'rgba(255, 255, 255, 0.78)',
      '--surface-solid': '#ffffff',
      '--editor-bg': 'rgba(255, 255, 255, 0.72)',
      '--elevated': 'rgba(255, 255, 255, 0.96)',
      '--border': 'rgba(30, 27, 60, 0.08)',
      '--border-strong': 'rgba(30, 27, 60, 0.16)',
      '--text': '#1e1b33',
      '--text-muted': '#666184',
      '--text-faint': '#9a96b3',
      '--hover': 'rgba(30, 27, 60, 0.05)',
      '--active': 'rgba(109, 93, 252, 0.12)',
      '--accent': '#6d5dfc',
      '--accent-2': '#ec4899',
      '--accent-gradient': 'linear-gradient(135deg, #6d5dfc 0%, #ec4899 100%)',
      '--accent-contrast': '#ffffff',
      '--danger': '#e11d48',
      '--warning': '#d97706',
      '--success': '#059669',
      '--blur': '24px',
      '--shadow': '0 20px 50px rgba(60, 50, 120, 0.18)'
    },
    monaco: {
      base: 'vs',
      inherit: true,
      rules: [
        { token: '', foreground: '1e1b33' },
        { token: 'comment', foreground: '9a96b3', fontStyle: 'italic' },
        { token: 'keyword', foreground: '7c3aed' },
        { token: 'operator', foreground: '7c3aed' },
        { token: 'string', foreground: '0f8a6a' },
        { token: 'string.escape', foreground: 'c2410c' },
        { token: 'regexp', foreground: 'c2410c' },
        { token: 'number', foreground: 'c2410c' },
        { token: 'constant', foreground: 'c2410c' },
        { token: 'type', foreground: '0369a1' },
        { token: 'type.identifier', foreground: '0369a1' },
        { token: 'predefined', foreground: '2563eb' },
        { token: 'variable.predefined', foreground: '2563eb' },
        { token: 'delimiter', foreground: '6b6789' },
        { token: 'tag', foreground: 'db2777' },
        { token: 'metatag', foreground: 'db2777' },
        { token: 'attribute.name', foreground: '6d28d9' },
        { token: 'attribute.value', foreground: '0f8a6a' },
        { token: 'string.key.json', foreground: '6d28d9' },
        { token: 'string.value.json', foreground: '0f8a6a' }
      ],
      colors: {
        focusBorder: '#00000000',
        'editor.background': '#00000000',
        'editor.foreground': '#1e1b33',
        'editorLineNumber.foreground': '#c0bdd6',
        'editorLineNumber.activeForeground': '#6d5dfc',
        'editor.lineHighlightBackground': '#6d5dfc0a',
        'editor.lineHighlightBorder': '#00000000',
        'editor.selectionBackground': '#6d5dfc33',
        'editor.inactiveSelectionBackground': '#6d5dfc1a',
        'editor.selectionHighlightBackground': '#ec489918',
        'editor.wordHighlightBackground': '#6d5dfc14',
        'editor.findMatchBackground': '#f59e0b66',
        'editor.findMatchHighlightBackground': '#f59e0b2a',
        'editorCursor.foreground': '#6d5dfc',
        'editorIndentGuide.background1': '#1e1b330d',
        'editorIndentGuide.activeBackground1': '#1e1b3326',
        'editorBracketMatch.background': '#6d5dfc1f',
        'editorBracketMatch.border': '#6d5dfc88',
        'editorWidget.background': '#ffffff',
        'editorWidget.border': '#1e1b3320',
        'editorSuggestWidget.background': '#ffffff',
        'editorSuggestWidget.selectedBackground': '#6d5dfc1f',
        'editorHoverWidget.background': '#ffffff',
        'minimap.background': '#00000000',
        'scrollbarSlider.background': '#1e1b3314',
        'scrollbarSlider.hoverBackground': '#1e1b3322',
        'scrollbarSlider.activeBackground': '#6d5dfc55',
        'editorGutter.background': '#00000000',
        'editorOverviewRuler.border': '#00000000'
      }
    }
  }
}

export const THEME_LIST = Object.values(THEMES)

export function applyThemeVars(theme: AppTheme): void {
  const root = document.documentElement
  for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v)
  root.dataset.theme = theme.id
  root.style.colorScheme = theme.dark ? 'dark' : 'light'
}
