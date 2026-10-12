export interface FuzzyMatch {
  score: number
  /** Matched character indices in the scored string. */
  indices: number[]
}

const isBoundary = (prev: string | undefined, ch: string): boolean =>
  prev === undefined ||
  prev === '/' ||
  prev === '\\' ||
  prev === '.' ||
  prev === '_' ||
  prev === '-' ||
  prev === ' ' ||
  (prev === prev.toLowerCase() && ch !== ch.toLowerCase())

/** Subsequence match with bonuses for consecutive and word-start hits. */
export function fuzzy(query: string, target: string): FuzzyMatch | null {
  if (!query) return { score: 0, indices: [] }
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  const indices: number[] = []
  let score = 0
  let ti = 0
  let streak = 0
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]
    if (ch === ' ') continue
    const found = t.indexOf(ch, ti)
    if (found === -1) return null
    const consecutive = indices.length > 0 && indices[indices.length - 1] === found - 1
    streak = consecutive ? streak + 1 : 0
    score += 1 + streak * 3 + (isBoundary(target[found - 1], target[found]) ? 4 : 0)
    score -= Math.min(found - ti, 6) * 0.2
    indices.push(found)
    ti = found + 1
  }
  score -= target.length * 0.01
  return { score, indices }
}

/** Score a path, favouring matches that land entirely in the file name. */
export function fuzzyPath(query: string, rel: string): (FuzzyMatch & { inName: boolean }) | null {
  const slash = rel.lastIndexOf('/')
  const name = rel.slice(slash + 1)
  const nameMatch = fuzzy(query, name)
  if (nameMatch) return { score: nameMatch.score + 12, indices: nameMatch.indices, inName: true }
  const full = fuzzy(query, rel)
  return full ? { ...full, inName: false } : null
}
