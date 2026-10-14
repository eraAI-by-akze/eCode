import { resolve } from 'path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { onigWasm } from './vite.shared'

/** Tauri sets the CSP itself (tauri.conf.json) and adds what IPC needs; drop the Electron meta tag. */
function stripCspMeta(): Plugin {
  return {
    name: 'ecode-strip-csp-meta',
    transformIndexHtml: (html) => html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>\s*/i, '')
  }
}

// Same renderer as the Electron build (src/renderer), served to the Tauri webview.
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  clearScreen: false,
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  plugins: [react(), stripCspMeta(), onigWasm()],
  worker: { format: 'es' },
  server: { port: 5174, strictPort: true },
  build: {
    outDir: resolve(__dirname, 'out/tauri'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 10000,
    // Safari/WebKitGTK and WebView2 all handle ES2021.
    target: ['es2021', 'safari15', 'chrome105']
  }
})
