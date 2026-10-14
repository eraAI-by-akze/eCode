/**
 * JSON with comments and trailing commas (launch.json, VS Code themes,
 * language-configuration.json, snippets).
 */
export function parseJsonc<T = unknown>(text: string): T {
  const n = text.length
  // Index of the next significant character at or after i (skips blanks and comments).
  const skip = (i: number): number => {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++
      if (text[i] === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++
      } else if (text[i] === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2)
        i = end < 0 ? n : end + 2
      } else return i
    }
  }
  let out = ''
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  while (i < n) {
    const c = text[i]
    if (c === '"') {
      // Strings are copied verbatim, escapes included.
      let j = i + 1
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      i = skip(i)
    } else if (c === ',') {
      const next = skip(i + 1)
      if (text[next] !== '}' && text[next] !== ']') out += c
      i++
    } else {
      out += c
      i++
    }
  }
  return JSON.parse(out) as T
}
