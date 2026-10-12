const SEP_RE = /[\\/]/

export const sep = (): string => window.ecode.pathSep

export function basename(p: string): string {
  const parts = p.split(SEP_RE).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (i <= 0) return p.slice(0, i + 1) || p
  // Keep "C:\" intact on Windows.
  if (i === 2 && p[1] === ':') return p.slice(0, 3)
  return p.slice(0, i)
}

export function extname(p: string): string {
  const b = basename(p)
  const i = b.lastIndexOf('.')
  return i > 0 ? b.slice(i + 1).toLowerCase() : ''
}

/** Root-relative path with forward slashes, or the input if outside root. */
export function relative(root: string | null, p: string): string {
  if (!root) return p
  if (p === root) return ''
  const prefix = root.endsWith('/') || root.endsWith('\\') ? root : root + sep()
  return p.startsWith(prefix) ? p.slice(prefix.length).split('\\').join('/') : p
}

export function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + sep())
}

export function isUntitled(p: string): boolean {
  return p.startsWith('untitled:')
}

/** Join a base folder and a (possibly relative) path, resolving "." and "..". */
export function resolvePath(base: string, p: string): string {
  const win = window.ecode.platform === 'win32'
  const isAbs = p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')
  const parts = (isAbs ? p : `${base}/${p}`).split(/[\\/]+/)
  const out: string[] = []
  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return win ? out.join('\\') : '/' + out.join('/')
}
