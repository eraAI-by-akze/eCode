import { dialog, ipcMain, net, BrowserWindow } from 'electron'
import { promises as fsp, mkdirSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, extname, join, normalize, relative, sep, isAbsolute } from 'path'
import { unzipSync } from 'fflate'
import type { ExtensionFolder } from '../shared/types'

/** VS Code / VSCodium extensions (.vsix = zip with an extension/ folder). */

export function extensionsDir(): string {
  const dir = join(homedir(), '.ecode', 'extensions')
  mkdirSync(dir, { recursive: true })
  return dir
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse((await fsp.readFile(path, 'utf8')).replace(/^﻿/, ''))
  } catch {
    return undefined
  }
}

async function readFolder(dir: string): Promise<ExtensionFolder> {
  const manifest = await readJson(join(dir, 'package.json'))
  if (!manifest) return { dir, error: 'нет package.json' }
  const nls = {
    ...((await readJson(join(dir, 'package.nls.json'))) ?? {}),
    ...((await readJson(join(dir, 'package.nls.ru.json'))) ?? {})
  } as Record<string, string>
  return { dir, manifest, nls }
}

async function list(): Promise<ExtensionFolder[]> {
  const base = extensionsDir()
  const names = await fsp.readdir(base, { withFileTypes: true }).catch(() => [])
  return Promise.all(names.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => readFolder(join(base, d.name))))
}

/** Native binaries and scripts lose their exec bit in our unzip; restore it by content. */
function isExecutable(data: Uint8Array): boolean {
  const m = (i: number): number => data[i] ?? 0
  return (
    (m(0) === 0x7f && m(1) === 0x45 && m(2) === 0x4c && m(3) === 0x46) || // ELF
    (m(0) === 0xcf && m(1) === 0xfa && m(2) === 0xed && m(3) === 0xfe) || // Mach-O 64
    (m(0) === 0xca && m(1) === 0xfe && m(2) === 0xba && m(3) === 0xbe) || // Mach-O fat
    (m(0) === 0x23 && m(1) === 0x21) // #!
  )
}

async function install(vsix: string): Promise<ExtensionFolder> {
  const files = unzipSync(new Uint8Array(await fsp.readFile(vsix)), { filter: (f) => f.name.startsWith('extension/') })
  const pkgRaw = files['extension/package.json']
  if (!pkgRaw) throw new Error('Это не расширение VS Code: в .vsix нет extension/package.json')
  const pkg = JSON.parse(new TextDecoder().decode(pkgRaw).replace(/^﻿/, '')) as { publisher?: string; name?: string; version?: string }
  if (!pkg.name) throw new Error('В package.json нет имени расширения')
  const id = `${pkg.publisher ?? 'unknown'}.${pkg.name}`.toLowerCase()
  const base = extensionsDir()
  const target = join(base, `${id}-${pkg.version ?? '0.0.0'}`)
  // Replace any installed version of the same extension.
  for (const name of await fsp.readdir(base).catch(() => [] as string[])) {
    if (name.toLowerCase().startsWith(`${id}-`)) await fsp.rm(join(base, name), { recursive: true, force: true })
  }
  const staging = `${target}.part`
  await fsp.rm(staging, { recursive: true, force: true })
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('/')) continue
    const rel = normalize(name.slice('extension/'.length))
    // Zip-slip guard: everything must stay inside the extension folder.
    if (!rel || isAbsolute(rel) || rel.split(sep).includes('..')) continue
    const out = join(staging, rel)
    await fsp.mkdir(dirname(out), { recursive: true })
    await fsp.writeFile(out, data, { mode: process.platform !== 'win32' && isExecutable(data) ? 0o755 : 0o644 })
  }
  await fsp.rename(staging, target)
  return readFolder(target)
}

async function uninstall(dir: string): Promise<void> {
  const rel = relative(extensionsDir(), dir)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Папка вне каталога расширений')
  await fsp.rm(dir, { recursive: true, force: true })
}

async function get(url: string): Promise<Response> {
  if (!/^https?:\/\//i.test(url)) throw new Error('Разрешены только http(s)-адреса')
  // net.fetch goes through Chromium's network stack, so system proxies apply.
  const res = await net.fetch(url, { headers: { Accept: 'application/json, */*', 'User-Agent': 'eCode' } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`)
  return res
}

async function download(url: string): Promise<string> {
  const res = await get(url)
  const path = join(tmpdir(), `ecode-${Date.now()}-${Math.random().toString(36).slice(2)}.vsix`)
  await fsp.writeFile(path, Buffer.from(await res.arrayBuffer()))
  return path
}

const MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
}

async function readDataUrl(path: string): Promise<string | null> {
  const mime = MIME[extname(path).toLowerCase()]
  if (!mime) return null
  try {
    const st = await fsp.stat(path)
    if (st.size > 2 * 1024 * 1024) return null
    return `data:${mime};base64,${(await fsp.readFile(path)).toString('base64')}`
  } catch {
    return null
  }
}

export function registerExtensionHandlers(): void {
  ipcMain.handle('ext:dir', () => extensionsDir())
  ipcMain.handle('ext:list', () => list())
  ipcMain.handle('ext:install', (_e, vsix: string) => install(vsix))
  ipcMain.handle('ext:uninstall', (_e, dir: string) => uninstall(dir))
  ipcMain.handle('net:download', (_e, url: string) => download(url))
  ipcMain.handle('net:get', async (_e, url: string) => (await get(url)).text())
  ipcMain.handle('fs:dataUrl', (_e, path: string) => readDataUrl(path))
  ipcMain.handle('ext:pick', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = { title: 'Установить расширение', filters: [{ name: 'VS Code extension', extensions: ['vsix'] }], properties: ['openFile' as const] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : r.filePaths[0] ?? null
  })
}
