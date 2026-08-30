import { SymbolInfo, ChunkInfo, ImportInfo } from '../../shared/types'
import { getDb } from '../persistence/database'

/**
 * Deterministic retrieval from the SQLite project index.
 * Used by Ctrl+P, symbol outlines, feature resolution and AI context building.
 */

export function fileIdFor(relPath: string): number | null {
  const d = getDb()
  const row = d.prepare('SELECT id FROM files WHERE path = ?').get(relPath) as { id: number } | undefined
  return row ? row.id : null
}

export function allFilePaths(): string[] {
  const d = getDb()
  return (d.prepare('SELECT path FROM files ORDER BY path').all() as { path: string }[]).map((r) => r.path)
}

export function fileMeta(relPath: string): {
  id: number
  language: string
  size: number
  mtime: number
  contentHash: string
} | null {
  const d = getDb()
  const row = d.prepare('SELECT * FROM files WHERE path = ?').get(relPath) as
    | { id: number; language: string; size: number; mtime: number; content_hash: string }
    | undefined
  if (!row) return null
  return { id: row.id, language: row.language, size: row.size, mtime: row.mtime, contentHash: row.content_hash }
}

export function getSymbols(relPath: string): SymbolInfo[] {
  const id = fileIdFor(relPath)
  if (!id) return []
  const d = getDb()
  return d
    .prepare(
      'SELECT name, kind, start_line AS startLine, end_line AS endLine, parent_symbol AS parent FROM symbols WHERE file_id = ? ORDER BY start_line'
    )
    .all(id) as SymbolInfo[]
}

export function getChunks(relPath: string): ChunkInfo[] {
  const id = fileIdFor(relPath)
  if (!id) return []
  const d = getDb()
  return d
    .prepare(
      'SELECT start_line AS startLine, end_line AS endLine, symbol_name AS symbolName, kind FROM code_chunks WHERE file_id = ? ORDER BY start_line'
    )
    .all(id) as ChunkInfo[]
}

export function getImports(relPath: string): ImportInfo[] {
  const id = fileIdFor(relPath)
  if (!id) return []
  const d = getDb()
  const rows = d
    .prepare(
      `SELECT i.raw_target AS rawTarget, f.path AS resolvedRelPath,
              CASE WHEN i.resolved_file_id IS NOT NULL THEN 'import' ELSE 'import' END AS kind
       FROM imports i LEFT JOIN files f ON f.id = i.resolved_file_id
       WHERE i.source_file_id = ?`
    )
    .all(id) as { rawTarget: string; resolvedRelPath: string | null }[]
  return rows.map((r) => ({
    rawTarget: r.rawTarget,
    resolvedRelPath: r.resolvedRelPath ?? undefined,
    kind: 'import' as const
  }))
}

/** Paths of files that (transitively) reference this file via imports. */
export function getReferences(relPath: string): string[] {
  const id = fileIdFor(relPath)
  if (!id) return []
  const d = getDb()
  const direct = d
    .prepare(
      `SELECT f.path FROM imports i JOIN files f ON f.id = i.source_file_id WHERE i.resolved_file_id = ?`
    )
    .all(id) as { path: string }[]
  return direct.map((r) => r.path)
}

export interface SymbolSearchHit {
  relPath: string
  symbol: string
  kind: string
  startLine: number
  endLine: number
}

/** Search symbols by name across the whole project (used by AI candidate retrieval). */
export function searchSymbols(term: string, limit = 50): SymbolSearchHit[] {
  const d = getDb()
  const like = `%${term.toLowerCase()}%`
  const rows = d
    .prepare(
      `SELECT f.path AS relPath, s.name AS symbol, s.kind AS kind,
              s.start_line AS startLine, s.end_line AS endLine
       FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE lower(s.name) LIKE ? OR lower(s.name) LIKE ?
       ORDER BY f.path LIMIT ?`
    )
    .all(like, `${term.split(/[_\s]+/).join('_')}%`, limit) as SymbolSearchHit[]
  return rows
}

export interface PathHit {
  relPath: string
  language: string
}

/** Path/name-based file candidate discovery for features. */
export function findFilesByTerms(
  terms: string[],
  root?: string,
  limit = 60
): PathHit[] {
  const d = getDb()
  const rows = d.prepare('SELECT path, language FROM files ORDER BY path').all() as {
    path: string
    language: string
  }[]
  const lower = terms.map((t) => t.toLowerCase())
  const scored: { relPath: string; language: string; score: number }[] = []
  for (const r of rows) {
    if (root && r.path.startsWith(root + '/')) continue
    const rel = r.path.toLowerCase()
    let score = 0
    for (const t of lower) {
      if (rel.includes(t)) score += 3
    }
    const base = r.path.split('/').pop()?.toLowerCase() ?? ''
    for (const t of lower) {
      const w = t.replace(/[^a-z0-9]/g, '')
      if (w && base.includes(w)) score += 2
    }
    if (score > 0) scored.push({ relPath: r.path, language: r.language, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

/** Full-text contains within indexed files — used when ripgrep is unavailable. */
export function findFilesContaining(needle: string, limit = 40): string[] {
  const d = getDb()
  const rows = d
    .prepare(
      `SELECT f.path, s.name, s.start_line AS startLine, s.end_line AS endLine
       FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE lower(s.name) LIKE ? LIMIT ?`
    )
    .all(`%${needle.toLowerCase()}%`, limit) as { path: string }[]
  return rows.map((r) => r.path)
}