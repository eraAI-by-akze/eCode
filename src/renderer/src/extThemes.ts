import type { editor } from 'monaco-editor'
import { monaco } from './monaco'
import { DARK_ANSI, LIGHT_ANSI, THEMES, THEME_LIST, TM_SCOPES, monacoThemeId, type AppTheme } from './themes'
import { parseJsonc } from './lib/jsonc'
import { dirname } from './lib/path'

/**
 * VS Code colour themes → eCode themes: workbench colours become the UI's CSS
 * variables, tokenColors become Monaco rules (TextMate scopes plus the Monarch
 * tokens of Monaco's built-in languages).
 */

const api = window.ecode

interface TokenColor {
  scope?: string | string[]
  settings?: { foreground?: string; background?: string; fontStyle?: string }
}

export interface VSCodeTheme {
  name?: string
  type?: string
  include?: string
  colors?: Record<string, string>
  tokenColors?: TokenColor[] | string
  semanticTokenColors?: Record<string, string | { foreground?: string; fontStyle?: string; bold?: boolean; italic?: boolean }>
}

/** Read a theme file, following `include` chains (base first). */
export async function loadVSCodeTheme(path: string, depth = 0): Promise<VSCodeTheme> {
  const r = await api.readFile(path)
  if (r.content === undefined) throw new Error(r.error ?? `Нет файла ${path}`)
  const theme = parseJsonc<VSCodeTheme>(r.content)
  let tokenColors: TokenColor[] = []
  if (Array.isArray(theme.tokenColors)) tokenColors = theme.tokenColors
  else if (typeof theme.tokenColors === 'string' && theme.tokenColors.endsWith('.json')) {
    tokenColors = (await loadVSCodeTheme(join(dirname(path), theme.tokenColors), depth + 1)).tokenColors as TokenColor[]
  }
  if (theme.include && depth < 6) {
    const base = await loadVSCodeTheme(join(dirname(path), theme.include), depth + 1).catch(() => ({}) as VSCodeTheme)
    return {
      ...base,
      ...theme,
      colors: { ...(base.colors ?? {}), ...(theme.colors ?? {}) },
      tokenColors: [...((base.tokenColors as TokenColor[]) ?? []), ...tokenColors],
      semanticTokenColors: { ...(base.semanticTokenColors ?? {}), ...(theme.semanticTokenColors ?? {}) }
    }
  }
  return { ...theme, tokenColors }
}

function join(dir: string, rel: string): string {
  const sep = api.pathSep
  const parts = `${dir}${sep}${rel}`.split(/[/\\]/)
  const out: string[] = []
  for (const p of parts) {
    if (p === '..') out.pop()
    else if (p !== '.') out.push(p)
  }
  return out.join(sep)
}

// ─────────────────────────── colours ───────────────────────────

type RGBA = [number, number, number, number]

function parse(c: string | undefined): RGBA | null {
  if (!c) return null
  const m = /^#([0-9a-f]{3,8})$/i.exec(c.trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('')
  if (h.length !== 6 && h.length !== 8) return null
  const n = (i: number): number => parseInt(h.slice(i, i + 2), 16)
  return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1]
}

const hex2 = (n: number): string => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')
const toHex = ([r, g, b]: RGBA): string => `#${hex2(r)}${hex2(g)}${hex2(b)}`
const rgba = ([r, g, b, a]: RGBA): string => `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`

function mix(a: RGBA, b: RGBA, t: number): RGBA {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 1]
}

/** Flatten a translucent colour onto a background. */
function over(c: RGBA, bg: RGBA): RGBA {
  return c[3] >= 1 ? c : mix(bg, [c[0], c[1], c[2], 1], c[3])
}

const luminance = ([r, g, b]: RGBA): number => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

// ─────────────────────────── conversion ───────────────────────────

function selectors(scope: TokenColor['scope']): string[] {
  const list = Array.isArray(scope) ? scope : typeof scope === 'string' ? scope.split(',') : []
  // Monaco can't express descendant selectors ("markup.underline punctuation");
  // dropping them beats applying them to every punctuation mark.
  return list.map((s) => s.split(' - ')[0].trim()).filter((s) => s && !/\s/.test(s))
}

function fontStyle(s: string | undefined): string | undefined {
  if (s === undefined) return undefined
  return s
    .split(/\s+/)
    .filter((x) => ['italic', 'bold', 'underline', 'strikethrough'].includes(x))
    .join(' ')
}

export function toAppTheme(id: string, label: string, uiTheme: string, theme: VSCodeTheme, extName: string): AppTheme {
  const colors = theme.colors ?? {}
  const dark = uiTheme !== 'vs' && uiTheme !== 'hc-light'
  const c = (...keys: string[]): RGBA | null => {
    for (const k of keys) {
      const v = parse(colors[k])
      if (v && v[3] > 0) return v
    }
    return null
  }
  const editorBg = c('editor.background') ?? (dark ? [30, 30, 30, 1] : [255, 255, 255, 1])
  const fg = over(c('foreground', 'editor.foreground') ?? (dark ? [212, 212, 212, 1] : [51, 51, 51, 1]), editorBg)
  const side = over(c('sideBar.background', 'editorGroupHeader.tabsBackground') ?? editorBg, editorBg)
  const bg = over(c('activityBar.background', 'titleBar.activeBackground') ?? side, editorBg)
  const accent = over(c('activityBarBadge.background', 'button.background', 'textLink.foreground', 'focusBorder') ?? [79, 140, 255, 1], editorBg)
  const accent2 = over(c('textLink.foreground', 'editorCursor.foreground') ?? accent, editorBg)
  const border = c('sideBar.border', 'panel.border', 'editorGroup.border', 'contrastBorder')
  const lineNo = c('editorLineNumber.foreground')

  const vars: Record<string, string> = {
    '--bg': toHex(bg),
    '--logo-color': dark ? '#ffffff' : '#0b0a12',
    '--bg-glow-1': 'transparent',
    '--bg-glow-2': 'transparent',
    '--surface': toHex(side),
    '--surface-2': toHex(over(c('input.background', 'dropdown.background') ?? mix(side, fg, 0.06), side)),
    '--surface-solid': toHex(side),
    '--editor-bg': toHex(editorBg),
    '--elevated': toHex(over(c('editorWidget.background', 'menu.background', 'quickInput.background') ?? side, side)),
    '--border': border ? rgba(border) : rgba([fg[0], fg[1], fg[2], 0.09]),
    '--border-strong': rgba([fg[0], fg[1], fg[2], 0.18]),
    '--text': toHex(fg),
    '--text-muted': toHex(over(c('descriptionForeground') ?? mix(fg, side, 0.35), side)),
    '--text-faint': toHex(lineNo ? over(lineNo, side) : mix(fg, side, 0.6)),
    '--hover': c('list.hoverBackground') ? rgba(c('list.hoverBackground')!) : rgba([fg[0], fg[1], fg[2], 0.06]),
    '--active': c('list.activeSelectionBackground') ? rgba(c('list.activeSelectionBackground')!) : rgba([accent[0], accent[1], accent[2], 0.2]),
    '--accent': toHex(accent),
    '--accent-2': toHex(accent2),
    '--accent-gradient': `linear-gradient(135deg, ${toHex(accent)} 0%, ${toHex(accent2)} 100%)`,
    '--accent-contrast': toHex(over(c('button.foreground', 'activityBarBadge.foreground') ?? (luminance(accent) > 0.6 ? [0, 0, 0, 1] : [255, 255, 255, 1]), accent)),
    '--danger': toHex(over(c('editorError.foreground', 'errorForeground') ?? [241, 76, 76, 1], editorBg)),
    '--warning': toHex(over(c('editorWarning.foreground') ?? [204, 167, 0, 1], editorBg)),
    '--success': toHex(over(c('gitDecoration.addedResourceForeground', 'terminal.ansiGreen') ?? [137, 209, 133, 1], editorBg)),
    '--blur': '0px',
    '--shadow': dark ? '0 16px 48px rgba(0, 0, 0, 0.45)' : '0 16px 48px rgba(0, 0, 0, 0.12)'
  }

  // Token rules: TextMate scopes as written, then the Monarch tokens they correspond to.
  const rules: editor.ITokenThemeRule[] = [{ token: '', foreground: toHex(fg).slice(1) }]
  const tm: { sel: string; fg?: string; style?: string }[] = []
  for (const tc of (theme.tokenColors as TokenColor[]) ?? []) {
    const fgc = parse(tc.settings?.foreground)
    const style = fontStyle(tc.settings?.fontStyle)
    if (!fgc && style === undefined) continue
    const fgHex = fgc ? toHex(over(fgc, editorBg)).slice(1) : undefined
    if (!tc.scope) {
      if (fgHex) rules[0] = { token: '', foreground: fgHex }
      continue
    }
    for (const sel of selectors(tc.scope)) {
      tm.push({ sel, fg: fgHex, style })
      rules.push({ token: sel, ...(fgHex ? { foreground: fgHex } : {}), ...(style !== undefined ? { fontStyle: style } : {}) })
    }
  }
  const resolve = (scope: string): { fg?: string; style?: string } | null => {
    // Longest matching selector wins; a later rule with the same length overrides.
    let len = -1
    let fgOut: string | undefined
    let styleOut: string | undefined
    for (const r of tm) {
      if ((scope === r.sel || scope.startsWith(r.sel + '.')) && r.sel.length >= len) {
        len = r.sel.length
        fgOut = r.fg ?? fgOut
        styleOut = r.style ?? styleOut
      }
    }
    return len < 0 ? null : { fg: fgOut, style: styleOut }
  }
  const monarch: [string, string[]][] = [
    ...TM_SCOPES.map(([m, scopes]) => [m, scopes.map((s) => (s === 'keyword' ? 'keyword.control' : s))] as [string, string[]]),
    ['type.identifier', ['entity.name.type', 'support.type']],
    ['keyword.flow', ['keyword.control']],
    ['metatag', ['entity.name.tag']],
    ['attribute.value', ['string']],
    ['key', ['support.type.property-name']],
    ['string.key.json', ['support.type.property-name.json', 'support.type.property-name']],
    ['string.value.json', ['string.quoted.double.json', 'string']],
    ['function', ['entity.name.function']],
    ['annotation', ['meta.decorator', 'entity.name.function.decorator']]
  ]
  for (const [token, scopes] of monarch) {
    if (rules.some((r) => r.token === token)) continue
    for (const s of scopes) {
      const hit = resolve(s)
      if (hit?.fg || hit?.style) {
        rules.push({ token, ...(hit.fg ? { foreground: hit.fg } : {}), ...(hit.style !== undefined ? { fontStyle: hit.style } : {}) })
        break
      }
    }
  }
  // Semantic tokens from language servers use plain type names ("function", "parameter").
  for (const [key, v] of Object.entries(theme.semanticTokenColors ?? {})) {
    if (/[.:*]/.test(key)) continue
    const col = parse(typeof v === 'string' ? v : v.foreground)
    const style = typeof v === 'string' ? undefined : fontStyle(v.fontStyle) ?? ([v.bold && 'bold', v.italic && 'italic'].filter(Boolean).join(' ') || undefined)
    if (col || style) rules.push({ token: key, ...(col ? { foreground: toHex(over(col, editorBg)).slice(1) } : {}), ...(style ? { fontStyle: style } : {}) })
  }

  const monacoColors: Record<string, string> = {}
  for (const [k, v] of Object.entries(colors)) if (typeof v === 'string' && parse(v)) monacoColors[k] = v
  monacoColors['editor.background'] ??= toHex(editorBg)

  const ansi = dark ? DARK_ANSI : LIGHT_ANSI
  const term = (k: string, d: string): string => (parse(colors[`terminal.${k}`]) ? colors[`terminal.${k}`].slice(0, 7) : d)
  const cap = (k: string): string => `ansi${k[0].toUpperCase()}${k.slice(1)}`

  return {
    id,
    name: label,
    tagline: `${extName} · тема VS Code`,
    dark,
    vars,
    monaco: {
      base: uiTheme === 'hc-black' ? 'hc-black' : uiTheme === 'hc-light' ? 'hc-light' : dark ? 'vs-dark' : 'vs',
      inherit: true,
      rules,
      colors: monacoColors
    },
    terminal: {
      ...(Object.fromEntries(Object.entries(ansi).map(([k, v]) => [k, term(cap(k), v)])) as typeof ansi),
      foreground: term('foreground', toHex(fg)),
      cursor: parse(colors['terminalCursor.foreground']) ? colors['terminalCursor.foreground'].slice(0, 7) : toHex(accent2),
      selectionBackground: colors['terminal.selectionBackground'] ?? colors['editor.selectionBackground'] ?? '#ffffff33'
    }
  }
}

export function registerTheme(theme: AppTheme): void {
  const i = THEME_LIST.findIndex((t) => t.id === theme.id)
  if (i >= 0) THEME_LIST[i] = theme
  else THEME_LIST.push(theme)
  THEMES[theme.id] = theme
  monaco.editor.defineTheme(monacoThemeId(theme.id), theme.monaco)
}

export function unregisterExtensionThemes(): void {
  for (let i = THEME_LIST.length - 1; i >= 0; i--) {
    const t = THEME_LIST[i]
    if (t.id.startsWith('ext:')) {
      THEME_LIST.splice(i, 1)
      delete THEMES[t.id]
    }
  }
}
