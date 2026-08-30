import { schemas } from './schemas'
import { OpRuntime, structuredGenerate, JSON_SYSTEM, systemPrompt, userPrompt, filterValidPaths } from './helpers'
import {
  ProjectOverview,
  ProjectFeature,
  SessionSummary,
  FeatureFile,
  FeatureFileLocation
} from '../../../shared/types'
import { sha256 } from '../../../shared/utils'
import { getArtifact, getLatestArtifact, putArtifact } from '../../persistence/database'
import {
  buildProjectManifest,
  structureOverview,
  discoverRunCommands,
  makeSectionBuilder,
  budgetFromContextWindow,
  readFileBounded
} from '../context'
import { findFilesByTerms, searchSymbols } from '../../core/retrieval'
import { getProjectRoot } from '../../project'
import { textSearch } from '../../core/text-search'
import { listRecentSessions, renderEventsForSummary, eventsForSession } from '../../core/session-manager'
import { fileOverviewOp } from './file-overview'
import { PROMPT_VERSION as FILE_OV_VERSION } from './file-overview'

export const PROMPT_VERSION = 1

// ---------------------------------------------------------------------------
// Project summary + commands (one pass, two artifacts)
// ---------------------------------------------------------------------------

export async function projectOverviewOp(
  runtime: OpRuntime,
  input: { force?: boolean }
): Promise<ProjectOverview> {
  const root = getProjectRoot()
  if (!root) throw new Error('no project open')
  const rootName = root.split('/').filter(Boolean).pop() ?? root
  const model = runtime.gateway.getActiveModel() ?? 'unknown'

  const commands = await discoverRunCommands()
  const overview = await structureOverview()
  const inputHash = await sha256(overview)

  const cached = getArtifact('project-overview', '', inputHash, model, PROMPT_VERSION)
  if (cached && !input.force) {
    return {
      ...JSON.parse(cached.resultJson),
      cached: true,
      generatedAt: cached.generatedAt,
      model
    } as ProjectOverview
  }

  runtime.status('Analyzing project…')
  const result = await structuredGenerate<{ summary: string }>(
    runtime,
    [
      systemPrompt(
        `${JSON_SYSTEM}\n\nProduce a Project Summary: 1-4 sentences describing what this repository appears to be. Base every claim on the provided manifest. Do not invent features not supported by evidence.`
      ),
      userPrompt(`${overview}`)
    ],
    schemas.summary,
    { jsonSchema: schemas.summary }
  )
  void buildProjectManifest
  void rootName

  const features = await featureDetectionOp(runtime, { force: input.force })

  const sessions = listRecentSessions(8)
  const recentWork: SessionSummary[] = []
  for (const s of sessions) {
    if (s.summary) recentWork.push(s.summary)
  }
  if (recentWork.length === 0) {
    // generate summaries for the most recent session deterministically cached
    const latest = sessions[0]
    if (latest && latest.eventCount > 0) {
      const sum = await sessionSummaryOp(runtime, { sessionId: latest.id })
      recentWork.push(sum)
    }
  }

  const overviewResult: ProjectOverview = {
    root,
    summary: result.summary,
    commands,
    features,
    recentWork: recentWork.slice(0, 5),
    cached: false,
    generatedAt: Date.now(),
    model
  }
  putArtifact({
    kind: 'project-overview',
    filePath: '',
    inputHash,
    model,
    promptVersion: PROMPT_VERSION,
    resultJson: JSON.stringify(overviewResult),
    generatedAt: Date.now()
  })
  return overviewResult
}

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

export async function featureDetectionOp(
  runtime: OpRuntime,
  input: { force?: boolean }
): Promise<ProjectFeature[]> {
  const root = getProjectRoot()
  if (!root) return []
  const cachedLatest = getLatestArtifact('project-features')
  if (cachedLatest && cachedLatest.generatedAt > Date.now() - 1000 * 60 * 60 && !input.force) {
    const parsed = JSON.parse(cachedLatest.resultJson) as { features: ProjectFeature[] }
    return parsed.features ?? []
  }
  const overview = await structureOverview()
  const inputHash = await sha256(overview)

  const cached = getArtifact('project-features', '', inputHash, runtime.gateway.getActiveModel() ?? '', PROMPT_VERSION)
  if (cached && !input.force) {
    return (JSON.parse(cached.resultJson) as { features: ProjectFeature[] }).features ?? []
  }

  runtime.status('Detecting project features…')
  const result = await structuredGenerate<{
    features: { name: string; summary: string; searchHints: string[] }[]
  }>(
    runtime,
    [
      systemPrompt(
        `${JSON_SYSTEM}\n\nIdentify the major conceptual FEATURES of this repository (e.g. Authentication, Property Search, Payments, Ordering). Features are responsibilities, NOT folders. Return 3-10 features. searchHints: 2-5 short filename/path/symbol terms that would locate code for this feature.`
      ),
      userPrompt(overview)
    ],
    schemas.features,
    { jsonSchema: schemas.features }
  )
  const features: ProjectFeature[] = (result.features ?? []).map((f) => ({
    name: f.name,
    summary: f.summary,
    searchHints: (f.searchHints ?? []).slice(0, 6),
    resolved: false
  }))
  putArtifact({
    kind: 'project-features',
    filePath: '',
    inputHash,
    model: runtime.gateway.getActiveModel() ?? 'unknown',
    promptVersion: PROMPT_VERSION,
    resultJson: JSON.stringify({ features }),
    generatedAt: Date.now()
  })
  return features
}

// ---------------------------------------------------------------------------
// Feature resolution (deterministic candidate discovery → AI selection)
// ---------------------------------------------------------------------------

export async function featureResolutionOp(
  runtime: OpRuntime,
  input: { featureName: string; hints: string[] }
): Promise<ProjectFeature> {
  const root = getProjectRoot()
  if (!root) throw new Error('no project open')
  const name = input.featureName
  const hints = input.hints

  // Stage 1: deterministic candidate discovery
  runtime.status(`Finding files for ${name}…`)
  const termCandidates = findFilesByTerms([...hints, name], undefined, 40)
  const symbolCandidates: string[] = []
  for (const h of hints.slice(0, 4)) {
    for (const hit of searchSymbols(h, 8)) {
      if (!symbolCandidates.includes(hit.relPath)) symbolCandidates.push(hit.relPath)
    }
  }
  // rg-based content candidates (bounded)
  const rgResults = await textSearch(root, { query: hints[0] ?? name, maxResults: 30 }).catch(() => [])
  const rgPaths = [...new Set(rgResults.map((r) => pathToRel(r.relPath, root)))].slice(0, 15)

  const candidatePaths = [...new Set([
    ...termCandidates.map((c) => c.relPath),
    ...symbolCandidates,
    ...rgPaths
  ])].slice(0, 25)

  if (candidatePaths.length === 0) {
    return { name, summary: 'No candidate files found deterministically.', searchHints: hints, files: [], resolved: true }
  }

  // Stage 2: bounded context of candidate outlines, ask AI to map feature → files
  runtime.status(`Resolving ${name}…`)
  const budget = budgetFromContextWindow(runtime.gateway.getConfig().contextWindow)
  const b = makeSectionBuilder(budget)
  b.addSection('FEATURE', `${name}\n${'search hints: ' + hints.join(', ')}`)
  let candidateText = ''
  for (const p of candidatePaths.slice(0, 18)) {
    const data = await readFileBounded(p, { maxChars: 3500 })
    if (!data) continue
    const { renderOutline } = await import('../context')
    candidateText += `\n--- ${p} ---\n${renderOutline(p)}\n${data.text.slice(0, 3500)}`
  }
  b.addSection('CANDIDATE FILES (validate paths; do not invent others)', candidateText.slice(0, budget.usableInput * 4))

  const result = await structuredGenerate<{
    feature: string
    files: {
      path: string
      reason: string
      importance: 'primary' | 'secondary'
      locations: { label: string; startLine: number; endLine: number }[]
    }[]
  }>(
    runtime,
    [
      systemPrompt(
        `${JSON_SYSTEM}\n\nMap the feature to its likely implementation files. Only use provided candidate paths. importance: "primary" for the main implementation, "secondary" for supporting files. locations: 1-4 concrete line ranges within each file where the feature is implemented (use the outline line numbers).`
      ),
      userPrompt(b.sections.map((s) => `### ${s.title}\n${s.text}`).join('\n\n'))
    ],
    schemas.featureResolution,
    {
      jsonSchema: schemas.featureResolution,
      normalize: (v) => {
        const obj = (v ?? {}) as Record<string, unknown>
        const rawFiles = Array.isArray(obj.files) ? obj.files : []
        const files = rawFiles.map((f: unknown) => {
          if (!f || typeof f !== 'object') return {}
          const fo = f as Record<string, unknown>
          const pathVal = fo.path ?? fo.file ?? ''
          const importance = fo.importance ?? 'secondary'
          let locations: unknown[] = []
          if (Array.isArray(fo.locations)) locations = fo.locations
          // coerce string forms like "login 5-10" into objects
          const locObjects = locations.map((l: unknown) => {
            if (l && typeof l === 'object') {
              const lo = l as Record<string, unknown>
              if (typeof lo.label === 'string' && typeof lo.startLine === 'number' && typeof lo.endLine === 'number') return lo
              return { label: lo.label, startLine: lo.startLine, endLine: lo.endLine }
            }
            if (typeof l === 'string') {
              const m = /^(.*?)\s+(\d+)\s*-\s*(\d+)$/.exec(l.trim())
              if (m) return { label: m[1], startLine: Number(m[2]), endLine: Number(m[3]) }
              return { label: l, startLine: 0, endLine: 0 }
            }
            return { label: '', startLine: 0, endLine: 0 }
          })
          return {
            path: pathVal,
            reason: typeof fo.reason === 'string' ? fo.reason : '',
            importance,
            locations: locObjects
          }
        })
        return {
          feature: obj.feature ?? name,
          files
        }
      }
    }
  )

  const valid = await validateFeatureFiles(runtime, result.files ?? [], candidatePaths)
  const resolved: ProjectFeature = {
    name,
    summary: '',
    searchHints: hints,
    files: valid,
    resolved: true
  }
  // cache per feature under kind 'feature-resolution'
  putArtifact({
    kind: 'feature-resolution',
    filePath: name,
    inputHash: await sha256(candidatePaths.join(',')),
    model: runtime.gateway.getActiveModel() ?? 'unknown',
    promptVersion: PROMPT_VERSION,
    resultJson: JSON.stringify(resolved),
    generatedAt: Date.now()
  })
  return resolved
}

async function validateFeatureFiles(
  runtime: OpRuntime,
  files: { path: string; reason: string; importance: string; locations: { label: string; startLine: number; endLine: number }[] }[],
  allowed: string[]
): Promise<FeatureFile[]> {
  const validPaths = await filterValidPaths(runtime, files.map((f) => f.path))
  const allowedSet = new Set(allowed)
  const out: FeatureFile[] = []
  for (const f of files) {
    if (!validPaths.includes(f.path)) continue
    if (!allowedSet.has(f.path) && f.path.startsWith('src/') === false && !allowedSet.has(f.path)) {
      // still allow if it passed path validation but wasn't proposed — practical leniency:
    }
    const { promises: fs } = await import('fs')
    const lineCount = await countLines(runtime, f.path)
    const locations: FeatureFileLocation[] = []
    for (const loc of (f.locations ?? []).slice(0, 4)) {
      const start = Math.max(1, Math.min(lineCount, Math.floor(loc.startLine)))
      const end = Math.max(start, Math.min(lineCount, Math.floor(loc.endLine)))
      locations.push({ label: String(loc.label ?? '').slice(0, 60) || 'location', startLine: start, endLine: end })
    }
    out.push({
      path: f.path,
      reason: String(f.reason ?? '').slice(0, 200),
      importance: f.importance === 'primary' ? 'primary' : 'secondary',
      locations
    })
    void fs
  }
  return out.slice(0, 12)
}

async function countLines(_runtime: OpRuntime, relPath: string): Promise<number> {
  const data = await readFileBounded(relPath, {})
  if (!data) return 0
  return data.lineCount
}

function pathToRel(p: string, root: string): string {
  const rel = p.replace(root + '/', '')
  return rel.split('\\').join('/')
}

// ---------------------------------------------------------------------------
// Session summary
// ---------------------------------------------------------------------------

export async function sessionSummaryOp(
  runtime: OpRuntime,
  input: { sessionId?: string; force?: boolean }
): Promise<SessionSummary> {
  const sessions = listRecentSessions(12)
  if (sessions.length === 0) {
    return { title: 'No sessions yet', summary: 'No editor activity recorded yet.', files: [] }
  }
  const session = sessions.find((s) => s.id === input.sessionId) ?? sessions[0]
  if (session.summary && !input.force) return session.summary

  const eventsText = renderEventsForSummary(session.id, 120)
  if (!eventsText.trim()) {
    return { title: 'Session', summary: 'No recorded activity.', files: [] }
  }
  runtime.status('Summarizing session…')
  const result = await structuredGenerate<{ title: string; summary: string; files: string[] }>(
    runtime,
    [
      systemPrompt(
        `${JSON_SYSTEM}\n\nSummarize this editor session from its recorded event log. title: 3-6 words. summary: 1-2 sentences about what was worked on. files: relevant file paths from the log (max 8). Do not invent activity that is not in the log.`
      ),
      userPrompt(eventsText)
    ],
    schemas.sessionSummary,
    { jsonSchema: schemas.sessionSummary }
  )
  const summary: SessionSummary = {
    title: result.title.slice(0, 80),
    summary: result.summary.slice(0, 300),
    files: (result.files ?? []).slice(0, 8)
  }
  const { saveSessionSummary } = await import('../../core/session-manager')
  saveSessionSummary(session.id, JSON.stringify(summary))
  return summary
}

void FILE_OV_VERSION
void fileOverviewOp
void eventsForSession