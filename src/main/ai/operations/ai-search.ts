import { schemas } from './schemas'
import { OpRuntime, structuredGenerate, JSON_SYSTEM, systemPrompt, userPrompt, filterValidPaths } from './helpers'
import { AISearchResponse, AISearchResult, AISearchExpandResult } from '../../../shared/types'
import { structureOverview, readFileBounded, makeSectionBuilder, budgetFromContextWindow } from '../context'
import { textSearch } from '../../core/text-search'
import { searchSymbols, findFilesByTerms, getSymbols } from '../../core/retrieval'
import { getProjectRoot } from '../../project'
import { getArtifact, putArtifact } from '../../persistence/database'
import { sha256 } from '../../../shared/utils'

export const PROMPT_VERSION = 1

/**
 * AI Search pipeline — works WITHOUT embeddings:
 *   User Query → AI Query Expansion → Deterministic Candidate Retrieval
 *   → Ranking → AI Final Reasoning → Validated Results
 */

export async function aiSearchExpandOp(
  runtime: OpRuntime,
  input: { query: string }
): Promise<AISearchExpandResult> {
  const overview = await structureOverview()
  runtime.status('Expanding query…')
  const result = await structuredGenerate<AISearchExpandResult>(
    runtime,
    [
      systemPrompt(
        `${JSON_SYSTEM}\n\nExpand a natural-language query into search terms that can locate the implementation deterministically in a codebase.\n` +
          `- concepts: 2-6 short conceptual phrases\n` +
          `- likelySymbols: 2-8 plausible symbol/function names\n` +
          `- likelyFileTerms: 2-8 filename/path terms (e.g. "auth", "listing", "policy")`
      ),
      userPrompt(`PROJECT METADATA\n${overview.slice(0, 1500)}\n\nUSER QUERY\n${input.query}`)
    ],
    schemas.aiSearchExpand,
    { jsonSchema: schemas.aiSearchExpand }
  )
  return {
    concepts: (result.concepts ?? []).slice(0, 6),
    likelySymbols: (result.likelySymbols ?? []).slice(0, 8),
    likelyFileTerms: (result.likelyFileTerms ?? []).slice(0, 8)
  }
}

// ---------------------------------------------------------------------------
// Deterministic candidate retrieval & ranking
// ---------------------------------------------------------------------------

interface Candidate {
  path: string
  score: number
  reasons: string[]
  symbols?: { name: string; startLine: number; endLine: number }[]
}

export async function retrieveCandidates(
  _runtime: OpRuntime,
  expanded: AISearchExpandResult,
  query: string
): Promise<Candidate[]> {
  const root = getProjectRoot()
  if (!root) return []
  const map = new Map<string, Candidate>()
  const bump = (path: string, score: number, reason: string): void => {
    const cur = map.get(path)
    if (cur) {
      cur.score += score
      cur.reasons.push(reason)
    } else {
      map.set(path, { path, score, reasons: [reason] })
    }
  }

  // 1. ripgrep on concepts + query terms
  const terms = [...expanded.concepts, ...expanded.likelyFileTerms, query].filter((t) => t.length > 1).slice(0, 6)
  for (const term of terms.slice(0, 4)) {
    const hits = await textSearch(root, { query: term, maxResults: 40 }).catch(() => [])
    for (const h of hits.slice(0, 20)) {
      const rel = h.relPath
      bump(rel, 4, `text: "${term}"`)
    }
  }

  // 2. filename/path matching on likely file terms + concept words
  for (const term of expanded.likelyFileTerms) {
    const hits = findFilesByTerms([term], undefined, 30)
    for (const h of hits) bump(h.relPath, 3, `path: "${term}"`)
  }

  // 3. symbol index matches
  for (const sym of expanded.likelySymbols) {
    const hits = searchSymbols(sym, 20)
    for (const h of hits) {
      bump(h.relPath, 2.5, `symbol: ${h.symbol}`)
      const c = map.get(h.relPath)
      if (c) {
        c.symbols ??= []
        c.symbols.push({ name: h.symbol, startLine: h.startLine, endLine: h.endLine })
      }
    }
  }

  // 4. per-candidate boost from query-term overlap in path
  const qWords = query.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, '')).filter((w) => w.length > 2)
  for (const [path, c] of map) {
    const low = path.toLowerCase()
    for (const w of qWords) if (low.includes(w)) c.score += 1.5
  }

  const ranked = [...map.values()].sort((a, b) => b.score - a.score).slice(0, 15)
  return ranked
}

// ---------------------------------------------------------------------------
// AI final reasoning
// ---------------------------------------------------------------------------

export async function aiSearchFinalOp(
  runtime: OpRuntime,
  input: { query: string; expanded: AISearchExpandResult }
): Promise<AISearchResponse> {
  const root = getProjectRoot()
  if (!root) throw new Error('no project open')

  runtime.status('Finding relevant files…')
  const candidates = await retrieveCandidates(runtime, input.expanded, input.query)
  if (candidates.length === 0) {
    return { summary: `No candidates found for "${input.query}".`, results: [] }
  }

  // build bounded context from ranked candidate chunks
  runtime.status('Reasoning over candidates…')
  const budget = budgetFromContextWindow(runtime.gateway.getConfig().contextWindow)
  const b = makeSectionBuilder(budget)
  b.addSection('USER QUERY', input.query)
  b.addSection('EXPANDED CONCEPTS', input.expanded.concepts.join(', '))

  let ctx = ''
  for (const c of candidates.slice(0, 10)) {
    const data = await readFileBounded(c.path, { maxChars: 4000 })
    if (!data) continue
    const syms = c.symbols
    const symText = syms?.length
      ? syms.map((s) => `${s.name} (${s.startLine}-${s.endLine})`).join(', ')
      : ''
    ctx += `\n--- ${c.path}${c.reasons.length ? '  [hits: ' + c.reasons.slice(0, 3).join('; ') + ']' : ''} ---\n`
    if (symText) ctx += `symbols: ${symText}\n`
    ctx += data.text.slice(0, 4000)
  }
  b.addSection('CANDIDATE CODE (validated snippets)', ctx.slice(0, budget.usableInput * 4))

  const result = await structuredGenerate<{
    summary: string
    results: { path?: string; file?: string; relPath?: string; startLine?: number; endLine?: number; reason?: string }[]
  }>(
    runtime,
    [
      systemPrompt(
        `${JSON_SYSTEM}\n\nDetermine where the described concept/feature/responsibility is likely implemented.\n` +
          `Use ONLY file paths from the candidates. For each result give a short reason and, when clear evidence exists, the exact line range. Empty results are acceptable when evidence is weak (then summary explains that). Max 8 results.`
      ),
      userPrompt(b.sections.map((s) => `### ${s.title}\n${s.text}`).join('\n\n'))
    ],
    schemas.aiSearchFinal,
    {
      jsonSchema: schemas.aiSearchFinal,
      normalize: (v) => {
        const obj = (v ?? {}) as Record<string, unknown>
        const raw = Array.isArray(obj.results) ? obj.results : []
        const results = raw.map((r: unknown) => {
          if (typeof r === 'string') return { path: r, reason: '', startLine: undefined, endLine: undefined }
          if (r && typeof r === 'object') {
            const ro = r as Record<string, unknown>
            const path = ro.path ?? ro.file ?? ro.relPath ?? ro.fileName ?? ''
            return {
              path,
              reason: typeof ro.reason === 'string' ? ro.reason : '',
              startLine: ro.startLine,
              endLine: ro.endLine
            }
          }
          return { path: '', reason: '', startLine: undefined, endLine: undefined }
        })
        return {
          summary: typeof obj.summary === 'string' ? obj.summary : '',
          results
        }
      }
    }
  )

  const accepted = await validateResults(
    runtime,
    (result.results ?? []).map((r) => ({ path: r.path ?? '', startLine: r.startLine, endLine: r.endLine, reason: r.reason ?? '' }))
  )
  return {
    summary: (result.summary ?? '').slice(0, 400),
    results: accepted
  }

}

async function validateResults(
  runtime: OpRuntime,
  results: { path: string; startLine?: number; endLine?: number; reason: string }[]
): Promise<AISearchResult[]> {
  const nonEmpty = results.filter((r) => r.path && r.path !== '.' && !r.path.startsWith('..'))
  if (nonEmpty.length === 0) return []
  const valid = await filterValidPaths(runtime, nonEmpty.map((r) => r.path))
  if (valid.length === 0) return []
  const lcCache = new Map<string, number>()
  const out: AISearchResult[] = []
  for (const r of nonEmpty) {
    if (!valid.includes(r.path)) continue
    let lineCount = lcCache.get(r.path)
    if (lineCount === undefined) {
      const data = await readFileBounded(r.path, {})
      lineCount = data?.lineCount ?? 0
      lcCache.set(r.path, lineCount)
    }
    let startLine: number | undefined
    let endLine: number | undefined
    if (r.startLine !== undefined && r.endLine !== undefined && lineCount > 0) {
      startLine = Math.max(1, Math.min(lineCount, Math.floor(r.startLine)))
      endLine = Math.max(startLine, Math.min(lineCount, Math.floor(r.endLine)))
    } else if (r.startLine !== undefined && lineCount > 0) {
      startLine = Math.max(1, Math.min(lineCount, Math.floor(r.startLine)))
      endLine = Math.min(lineCount, startLine + 20)
    }
    out.push({
      path: r.path,
      relPath: r.path,
      startLine,
      endLine,
      reason: String(r.reason ?? '').slice(0, 200)
    })
  }
  return out.slice(0, 8)
}

void getSymbols
void getArtifact
void putArtifact
void sha256