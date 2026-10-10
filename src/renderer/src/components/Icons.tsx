import type { ReactNode, SVGProps } from 'react'
import { extname } from '../lib/path'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function make(paths: ReactNode, fill = false) {
  return function Icon({ size = 16, ...rest }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={fill ? 'currentColor' : 'none'}
        stroke={fill ? 'none' : 'currentColor'}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        {...rest}
      >
        {paths}
      </svg>
    )
  }
}

export const IconFiles = make(
  <>
    <path d="M15 3H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7z" />
    <path d="M15 3v4h4" />
    <path d="M3 8v11a2 2 0 0 0 2 2h9" />
  </>
)
export const IconSearch = make(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </>
)
export const IconTerminal = make(
  <>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="m7 9 3 3-3 3M13 15h4" />
  </>
)
export const IconSettings = make(
  <>
    <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </>
)
export const IconPalette = make(
  <>
    <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.9 1.8-1.9 0-.5-.2-.9-.5-1.3-.3-.3-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z" />
    <circle cx="7.5" cy="11.5" r="1" fill="currentColor" />
    <circle cx="10" cy="7.5" r="1" fill="currentColor" />
    <circle cx="15" cy="7.5" r="1" fill="currentColor" />
  </>
)
export const IconChevron = make(<path d="m9 6 6 6-6 6" />)
export const IconClose = make(<path d="M6 6l12 12M18 6 6 18" />)
export const IconPlus = make(<path d="M12 5v14M5 12h14" />)
export const IconFilePlus = make(
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M12 12v6M9 15h6" />
  </>
)
export const IconFolderPlus = make(
  <>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M12 10v6M9 13h6" />
  </>
)
export const IconRefresh = make(
  <>
    <path d="M20 11a8 8 0 0 0-14.8-4M4 4v4h4" />
    <path d="M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4" />
  </>
)
export const IconCollapse = make(<path d="m7 15 5-5 5 5M7 20l5-5 5 5M4 4h16" />)
export const IconFolderOpen = make(
  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1H8.5a2 2 0 0 0-1.9 1.4L4 19M4 19l2.4-6.6A2 2 0 0 1 8.3 11H21l-2.6 6.6A2 2 0 0 1 16.5 19z" />
)
export const IconFolder = make(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />)
export const IconBranch = make(
  <>
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="8" r="2" />
    <path d="M6 7v10M18 10c0 4-6 3-11.5 7" />
  </>
)
export const IconCase = make(<path d="M3 17 7 7l4 10M4.5 13.5h5M14 12.5a2.5 2.5 0 1 1 0 4.5V10m0 5a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0" />)
export const IconWord = make(<path d="M4 7v10M20 7v10M8 15l1.5-6 1.5 6M13 9h2.5a1.5 1.5 0 0 1 0 3H13zm0 3h3a1.5 1.5 0 0 1 0 3h-3z" />)
export const IconRegex = make(<path d="M17 4v8M13.5 6l7 4M20.5 6l-7 4M5 18h4v-4H5z" />)
export const IconTrash = make(<path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />)
export const IconSparkle = make(
  <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />,
  true
)
export const IconMinimize = make(<path d="M5 12h14" />)
export const IconMaximize = make(<rect x="5" y="5" width="14" height="14" rx="2" />)
export const IconRestore = make(
  <>
    <rect x="5" y="8" width="11" height="11" rx="2" />
    <path d="M8 5h9a2 2 0 0 1 2 2v9" />
  </>
)
export const IconSplit = make(<path d="M4 4h16v16H4zM4 15h16" />)

export const IconGit = make(
  <>
    <circle cx="6" cy="6" r="2.2" />
    <circle cx="6" cy="18" r="2.2" />
    <circle cx="18" cy="9" r="2.2" />
    <path d="M6 8.2v7.6M18 11.2c0 3.5-4 3.8-10.2 5.6" />
  </>
)
export const IconMinus = make(<path d="M5 12h14" />)
export const IconUndo = make(<path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" />)
export const IconCheck = make(<path d="m5 12.5 4.5 4.5L19 7.5" />)
export const IconArrowUp = make(<path d="M12 19V5M6 11l6-6 6 6" />)
export const IconArrowDown = make(<path d="M12 5v14M6 13l6 6 6-6" />)
export const IconSync = make(
  <>
    <path d="M20 12a8 8 0 0 1-13.7 5.6M4 12a8 8 0 0 1 13.7-5.6" />
    <path d="M18 2.5v4h-4M6 21.5v-4h4" />
  </>
)
export const IconGoToFile = make(
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M9 14h6M12.5 11.5 15 14l-2.5 2.5" />
  </>
)
export const IconError = make(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="m9 9 6 6M15 9l-6 6" />
  </>
)
export const IconWarning = make(
  <>
    <path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4M12 17h.01" />
  </>
)
export const IconInfo = make(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16v-5M12 8h.01" />
  </>
)
export const IconPlay = make(<path d="M7 4.5v15l12-7.5z" />)
export const IconColumns = make(<path d="M4 4h16v16H4zM12 4v16" />)

// ─────────────────────────── file icons ───────────────────────────

const FILE_COLORS: Record<string, [string, string]> = {
  ts: ['#3b82f6', 'TS'],
  tsx: ['#38bdf8', 'TX'],
  js: ['#facc15', 'JS'],
  jsx: ['#fde047', 'JX'],
  mjs: ['#facc15', 'JS'],
  cjs: ['#facc15', 'JS'],
  json: ['#f59e0b', '{}'],
  py: ['#60a5fa', 'PY'],
  ipynb: ['#f97316', 'NB'],
  rs: ['#fb923c', 'RS'],
  go: ['#22d3ee', 'GO'],
  java: ['#ef4444', 'JV'],
  kt: ['#a78bfa', 'KT'],
  c: ['#93c5fd', 'C'],
  h: ['#a5b4fc', 'H'],
  cpp: ['#60a5fa', 'C+'],
  cs: ['#a78bfa', 'C#'],
  php: ['#818cf8', 'PH'],
  rb: ['#f43f5e', 'RB'],
  swift: ['#fb923c', 'SW'],
  html: ['#f97316', '<>'],
  vue: ['#34d399', 'V'],
  svelte: ['#fb7185', 'S'],
  css: ['#a78bfa', '#'],
  scss: ['#f472b6', '#'],
  less: ['#818cf8', '#'],
  md: ['#94a3b8', 'M↓'],
  mdx: ['#94a3b8', 'MX'],
  yml: ['#f87171', 'YM'],
  yaml: ['#f87171', 'YM'],
  toml: ['#a8a29e', 'TO'],
  xml: ['#fb923c', '<>'],
  svg: ['#fbbf24', 'SV'],
  png: ['#34d399', 'IM'],
  jpg: ['#34d399', 'IM'],
  jpeg: ['#34d399', 'IM'],
  gif: ['#34d399', 'IM'],
  sh: ['#4ade80', '$'],
  bash: ['#4ade80', '$'],
  zsh: ['#4ade80', '$'],
  ps1: ['#60a5fa', '$'],
  sql: ['#fbbf24', 'SQ'],
  lock: ['#78716c', 'LK'],
  env: ['#facc15', 'EN'],
  txt: ['#94a3b8', 'TX'],
  dockerfile: ['#38bdf8', 'DK'],
  gitignore: ['#f97316', 'GI']
}

export function fileMeta(name: string): [string, string] {
  const lower = name.toLowerCase()
  if (lower === 'dockerfile') return FILE_COLORS.dockerfile
  if (lower === '.gitignore') return FILE_COLORS.gitignore
  if (lower.startsWith('.env')) return FILE_COLORS.env
  if (lower === 'package.json') return ['#4ade80', 'NP']
  return FILE_COLORS[extname(name)] ?? ['#8b8aa0', '']
}

export function FileIcon({ name, size = 16 }: { name: string; size?: number }) {
  const [color, label] = fileMeta(name)
  return (
    <span className="file-icon" style={{ width: size, height: size, color }}>
      {label ? (
        <span className="file-icon-label" style={{ fontSize: label.length > 1 ? size * 0.5 : size * 0.62 }}>
          {label}
        </span>
      ) : (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5" />
        </svg>
      )}
    </span>
  )
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <span className="logo" style={{ width: size, height: size, fontSize: size * 0.62 }}>
      e
    </span>
  )
}
