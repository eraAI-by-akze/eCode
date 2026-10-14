import { readFileSync } from 'fs'
import { createRequire } from 'module'
import type { Plugin } from 'vite'

/**
 * `import onig from 'virtual:onig-wasm'` → the Oniguruma WebAssembly as base64.
 * Inlined because packaged Electron loads the UI from file://, where fetch()
 * can't read files.
 */
export function onigWasm(): Plugin {
  const id = 'virtual:onig-wasm'
  return {
    name: 'ecode-onig-wasm',
    resolveId: (source) => (source === id ? '\0' + id : null),
    load(source) {
      if (source !== '\0' + id) return null
      const path = createRequire(import.meta.url).resolve('vscode-oniguruma/release/onig.wasm')
      return `export default ${JSON.stringify(readFileSync(path).toString('base64'))}`
    }
  }
}
