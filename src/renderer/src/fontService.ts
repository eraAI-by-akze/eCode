import { getState, setState } from './store'

/**
 * Editor/terminal font. "Auto" picks the first installed Nerd Font (so prompt
 * themes and file icons in the terminal render), preferring the Mono
 * variants whose icons stay one cell wide.
 */

const api = window.ecode

const FALLBACK = ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', 'Menlo', 'Consolas', 'Liberation Mono']

// Nerd Fonts v3 family names, most popular coding fonts first.
const NERD_BASES = [
  'JetBrainsMono',
  'FiraCode',
  'CaskaydiaCove',
  'CaskaydiaMono',
  'Hack',
  'MesloLGS',
  'MesloLGM',
  'SauceCodePro',
  'Iosevka',
  'IosevkaTerm',
  'GeistMono',
  'UbuntuMono',
  'RobotoMono',
  'DejaVuSansM',
  'VictorMono',
  'Hasklug',
  'Lilex',
  'ZedMono',
  'AtkynsonMono'
]
export const NERD_CANDIDATES = NERD_BASES.flatMap((b) => [
  `${b} Nerd Font Mono`,
  `${b} NFM`,
  `${b} Nerd Font`,
  `${b} NF`
]).concat(['MesloLGS NF'])

const quote = (f: string): string => (/^[\w-]+$/.test(f) && !/\s/.test(f) ? f : `"${f.replace(/"/g, '')}"`)

/** The CSS font-family list for the editor and terminal. */
export function fontStack(): string {
  const { settings, autoFont } = getState()
  const chosen = settings.editorFont || autoFont
  return [...(chosen ? [chosen] : []), ...FALLBACK].map(quote).join(', ') + ', monospace'
}

export function currentFontName(): string {
  const { settings, autoFont } = getState()
  return settings.editorFont || autoFont || FALLBACK[0]
}

// ─────────────────────────── detection ───────────────────────────

let ctx: CanvasRenderingContext2D | null = null
const SAMPLE = 'mmmmmmmmmmlliWW@#01'

function width(font: string): number {
  ctx ??= document.createElement('canvas').getContext('2d')
  if (!ctx) return 0
  ctx.font = font
  return ctx.measureText(SAMPLE).width
}

/** Is this family installed? (Text renders differently from every generic fallback.) */
export function isInstalled(family: string): boolean {
  for (const generic of ['monospace', 'serif', 'sans-serif']) {
    if (width(`72px ${quote(family)}, ${generic}`) !== width(`72px ${generic}`)) return true
  }
  return false
}

export function isMonospace(family: string): boolean {
  ctx ??= document.createElement('canvas').getContext('2d')
  if (!ctx) return false
  ctx.font = `40px ${quote(family)}, monospace`
  return Math.abs(ctx.measureText('iiiii').width - ctx.measureText('WWWWW').width) < 0.5
}

const isNerd = (f: string): boolean => /Nerd Font|\bNF[MP]?\b/.test(f)

function rank(f: string): number {
  const base = NERD_BASES.findIndex((b) => f.startsWith(b))
  const mono = /Nerd Font Mono|NFM/.test(f) ? 0 : 1
  return (base < 0 ? 100 : base) * 2 + mono
}

/** Find the best installed Nerd Font and remember it as the "auto" font. */
export async function detectAutoFont(): Promise<string | null> {
  let found = NERD_CANDIDATES.find(isInstalled) ?? null
  if (!found) {
    // Unusual family names: look through the full list where the runtime offers one.
    const all = (await api.listFonts().catch(() => [])).filter(isNerd).sort((a, b) => rank(a) - rank(b))
    found = all[0] ?? null
  }
  setState({ autoFont: found })
  return found
}

type LocalFont = { family: string }

/** Every installed family (for the picker). Electron needs a user click for queryLocalFonts. */
export async function listInstalledFonts(): Promise<string[]> {
  let families: string[] = []
  const query = (window as unknown as { queryLocalFonts?: () => Promise<LocalFont[]> }).queryLocalFonts
  if (query) {
    try {
      families = (await query()).map((f) => f.family)
    } catch {
      families = []
    }
  }
  if (!families.length) families = await api.listFonts().catch(() => [])
  // Without a system list, probe the known Nerd Fonts and fallbacks.
  if (!families.length) families = [...NERD_CANDIDATES, ...FALLBACK].filter(isInstalled)
  const auto = getState().autoFont
  if (auto && !families.includes(auto)) families.push(auto)
  return [...new Set(families)].sort((a, b) => Number(isNerd(b)) - Number(isNerd(a)) || a.localeCompare(b))
}

/** Wait for the font so Monaco measures the right glyph widths. */
export async function loadFont(family: string, size = 14): Promise<void> {
  try {
    await document.fonts.load(`${size}px ${quote(family)}`)
  } catch {
    // Unknown fonts just fall back.
  }
}

export { isNerd }
