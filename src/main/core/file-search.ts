import { FileSearchResult } from '../../shared/types'
import { getDb } from '../persistence/database'

/**
 * Deterministic fuzzy file finder (Ctrl+P).
 * In-memory index of project file paths, refreshed by the indexer.
 * No AI.
 */

let cachedPaths: string[] | null = null
let cacheVersion = 0

export function invalidateFileIndex(): void {
  cacheVersion++
}

export function bumpCacheVersion(): void {
  cacheVersion++
}

function projectPaths(): string[] {
  if (cachedPaths && cacheVersion === 0) return cachedPaths
  try {
    const rows = getDb().prepare('SELECT path FROM files ORDER BY path').all() as { path: string }[]
    cachedPaths = rows.map((r) => r.path)
  } catch {
    cachedPaths = []
  }
  cacheVersion = 0
  return cachedPaths
}

/**
 * Classic subsequence fuzzy score.
 * Higher = better. Returns -1 when no subsequence match exists.
 */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (!q) return 0
  if (q.length > t.length) return -1
  let score = 0
  let qi = 0
  let prevMatch = -2
  let consecutive = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // path-segment start bonus (after '/' or '.' or '-' or '_')
      const boundary = ti === 0 || '/.-_ '.includes(t[ti - 1])
      score += boundary ? 8 : 2
      if (ti === prevMatch + 1) {
        consecutive++
        score += consecutive * 3
      } else {
        consecutive = 0
        score -= Math.min(4, ti - prevMatch) // gap penalty
      }
      prevMatch = ti
      qi++
    }
  }
  if (qi < q.length) return -1
  // basename bonus
  const base = target.slice(target.lastIndexOf('/') + 1).toLowerCase()
  if (base.startsWith(q)) score += 12
  // shorter paths preferred slightly
  score += Math.max(0, 60 - target.length) / 10
  return score
}

export function fuzzyFiles(
  query: string,
  limit = 50,
  boostPaths: string[] = []
): FileSearchResult[] {
  if (!query) return []
  const paths = projectPaths()
  const boosts = new Set(boostPaths)
  const scored: { rel: string; score: number }[] = []
  for (const p of paths) {
    const s = fuzzyScore(query, p)
    if (s < 0) continue
    let final = s
    if (boosts.has(p)) final += 25 // recent files mild boost
    if (query.includes('/') && !p.includes(query.toLowerCase())) continue
    scored.push({ rel: p, score: final })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((s) => ({
    path: s.rel,
    relPath: s.rel,
    score: s.score
  }))
}