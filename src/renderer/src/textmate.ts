import { INITIAL, Registry, parseRawGrammar, type IGrammar, type IRawGrammar, type StateStack } from 'vscode-textmate'
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma'
import onigBase64 from 'virtual:onig-wasm'
import { monaco } from './monaco'

/**
 * TextMate grammars from VS Code extensions, tokenized with vscode-textmate +
 * Oniguruma (the same engine VS Code uses) and fed to Monaco. Each token gets
 * the most specific scope the current theme colours, so both eCode's themes
 * and imported VS Code themes apply.
 */

const api = window.ecode

export interface GrammarSource {
  scopeName: string
  path: string
  language?: string
  embeddedLanguages?: Record<string, string>
  injectTo?: string[]
}

const sources = new Map<string, GrammarSource>()
const injections = new Map<string, string[]>()
const providers = new Map<string, monaco.IDisposable>()
let registry: Registry | null = null
let onigReady: Promise<void> | null = null
/** Scope prefixes the active theme has rules for (see setThemeScopes). */
let themed = new Set<string>()

function initOnig(): Promise<void> {
  onigReady ??= (async () => {
    const bin = atob(onigBase64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    await loadWASM(bytes.buffer)
  })()
  return onigReady
}

async function readGrammar(src: GrammarSource): Promise<IRawGrammar | null> {
  const r = await api.readFile(src.path).catch(() => null)
  if (!r?.content) return null
  try {
    // .json and .tmLanguage (plist) both work; the file name tells the parser which.
    return parseRawGrammar(r.content, src.path)
  } catch (err) {
    console.warn('grammar', src.path, err)
    return null
  }
}

function getRegistry(): Registry {
  registry ??= new Registry({
    onigLib: initOnig().then(() => ({ createOnigScanner, createOnigString })),
    loadGrammar: async (scopeName) => {
      const src = sources.get(scopeName)
      return src ? readGrammar(src) : null
    },
    getInjections: (scopeName) => injections.get(scopeName)
  })
  return registry
}

class TMState implements monaco.languages.IState {
  constructor(public readonly stack: StateStack) {}
  clone(): TMState {
    return this
  }
  equals(other: monaco.languages.IState): boolean {
    return other instanceof TMState && (other.stack === this.stack || other.stack.equals(this.stack))
  }
}

/** The innermost scope the theme has a rule for (prefix match), else the innermost one. */
function pickScope(scopes: string[]): string {
  for (let i = scopes.length - 1; i > 0; i--) {
    const s = scopes[i]
    let p = s
    for (;;) {
      if (themed.has(p)) return s
      const dot = p.lastIndexOf('.')
      if (dot < 0) break
      p = p.slice(0, dot)
    }
  }
  return scopes[scopes.length - 1] ?? ''
}

function tokensProvider(grammar: IGrammar): monaco.languages.TokensProvider {
  return {
    getInitialState: () => new TMState(INITIAL),
    tokenize(line, state) {
      const r = grammar.tokenizeLine(line, (state as TMState).stack, 500)
      return {
        tokens: r.tokens.map((t) => ({ startIndex: t.startIndex, scopes: pickScope(t.scopes) })),
        endState: new TMState(r.ruleStack)
      }
    }
  }
}

export function addGrammar(src: GrammarSource): void {
  sources.set(src.scopeName, src)
  for (const target of src.injectTo ?? []) {
    const list = injections.get(target) ?? []
    if (!list.includes(src.scopeName)) injections.set(target, [...list, src.scopeName])
  }
}

/** Make `language` tokenize with its TextMate grammar (replacing Monaco's Monarch one). */
export async function activateLanguage(language: string): Promise<boolean> {
  const src = [...sources.values()].find((s) => s.language === language)
  if (!src) return false
  const embedded: Record<string, number> = {}
  let id = 2
  for (const scope of Object.keys(src.embeddedLanguages ?? {})) embedded[scope] = id++
  const grammar = await getRegistry().loadGrammarWithConfiguration(src.scopeName, 1, { embeddedLanguages: embedded })
  if (!grammar) return false
  providers.get(language)?.dispose()
  providers.set(language, monaco.languages.setTokensProvider(language, tokensProvider(grammar)))
  return true
}

export function hasGrammar(language: string): boolean {
  return [...sources.values()].some((s) => s.language === language)
}

/** Forget everything (extensions were reloaded). */
export function resetGrammars(): void {
  for (const d of providers.values()) d.dispose()
  providers.clear()
  sources.clear()
  injections.clear()
  registry?.dispose()
  registry = null
}

/** Tell the tokenizer which scopes the theme colours; retokenizes open files. */
export function setThemeScopes(rules: { token: string }[]): void {
  const next = new Set(rules.map((r) => r.token).filter(Boolean))
  const changed = next.size !== themed.size || [...next].some((t) => !themed.has(t))
  themed = next
  if (!changed || !providers.size) return
  // Token cache holds the old picks: re-register providers so Monaco retokenizes.
  for (const lang of [...providers.keys()]) void activateLanguage(lang)
}
