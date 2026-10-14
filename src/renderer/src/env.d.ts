/// <reference types="vite/client" />

declare module 'virtual:onig-wasm' {
  /** onig.wasm, base64-encoded (see vite.shared.ts). */
  const base64: string
  export default base64
}
