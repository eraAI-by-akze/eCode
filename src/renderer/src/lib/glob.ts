/** Minimal glob → RegExp: `**` spans folders, `*` stays within one, `?` is one char. */
export function globToRegExp(glob: string): RegExp {
  let src = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      // "**/" also matches zero folders.
      if (glob[i + 2] === '/') {
        src += '(?:.*/)?'
        i += 2
      } else {
        src += '.*'
        i += 1
      }
    } else if (c === '*') src += '[^/]*'
    else if (c === '?') src += '[^/]'
    else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${src}$`, 'i')
}

/** Does a root-relative, slash-separated path match the glob? Patterns without "/" match the file name. */
export function matchGlob(glob: string, rel: string): boolean {
  const target = glob.includes('/') ? rel : rel.slice(rel.lastIndexOf('/') + 1)
  return globToRegExp(glob).test(target)
}
