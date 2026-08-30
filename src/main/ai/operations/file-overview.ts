import { schemas } from './schemas'
import { OpRuntime, structuredGenerate, renameKeys, JSON_SYSTEM, systemPrompt, userPrompt } from './helpers'
import { FileOverview, FileSection, RelatedFile } from '../../../shared/types'
import { sha256 } from '../../../shared/utils'
import { getArtifact, getLatestArtifact, putArtifact } from '../../persistence/database'
import {
  buildFileContextSection,
  makeSectionBuilder,
  budgetFromContextWindow,
  renderOutline
} from '../context'
import { getSymbols, getImports, getReferences, fileMeta } from '../../core/retrieval'
import { readProjectFile } from '../../project'
import { splitLines } from '../../../shared/utils'

export const PROMPT_VERSION = 1

export async function fileOverviewOp(
  runtime: OpRuntime,
  input: { path: string; force?: boolean }
): Promise<FileOverview> {
  const relPath = input.path
  const text = await readProjectFile(relPath).catch(() => null)
  if (text === null) throw new Error(`File not found: ${relPath}`)
  const meta = fileMeta(relPath)
  const lineCount = splitLines(text).length
  const outline = renderOutline(relPath)

  const model = runtime.gateway.getActiveModel() ?? 'unknown'
  const directRelated = getImports(relPath)
    .map((i) => i.resolvedRelPath)
    .filter((p): p is string => !!p)
  const references = getReferences(relPath)

  // deterministic feature membership (hint-match against path)
  const featureHints = (await mementoFeatures()).filter((f) =>
    [...f.searchHints, f.name].some((h) => relPath.toLowerCase().includes(h.toLowerCase()))
  )

  const inputHash = await sha256(
    JSON.stringify({
      contentHash: meta?.contentHash ?? text,
      outline,
      imports: directRelated,
      references,
      featureHints: featureHints.map((f) => f.name),
      promptVersion: PROMPT_VERSION
    })
  )

  const cached = getArtifact('file-overview', relPath, inputHash, model, PROMPT_VERSION)
  if (cached && !input.force) {
    return {
      ...JSON.parse(cached.resultJson),
      path: relPath,
      cached: true,
      generatedAt: cached.generatedAt,
      model
    } as FileOverview
  }

  runtime.status('Analyzing file…')
  const budget = budgetFromContextWindow(runtime.gateway.getConfig().contextWindow)
  const b = makeSectionBuilder(budget, { singleFileBudget: budget.usableInput })
  await buildFileContextSection(relPath, b, { includeFullWhenSmall: true })
  if (featureHints.length) {
    b.addSection('KNOWN FEATURE MEMBERSHIP', featureHints.map((f) => f.name).join(', '))
  }
  if (directRelated.length) {
    b.addSection('DIRECT IMPORTS', directRelated.join('\n'))
  }
  if (references.length) {
    b.addSection('INCOMING REFERENCES', references.slice(0, 20).join('\n'))
  }

  const contextText = b.sections.map((s) => `### ${s.title}\n${s.text}`).join('\n\n')
  const result = await structuredGenerate<{
    summary: string
    sections: FileSection[]
    relatedFiles: RelatedFile[]
  }>(
    runtime,
    [
      systemPrompt(
        `${JSON_SYSTEM}\n\nYou are summarizing source files for navigation. Rules:\n` +
          `- summary: one to two sentences about the file's responsibility and behavior, NOT its syntax.\n` +
          `- sections: a SMALL number (2-8) of meaningful functional groups of code, aligned to the provided outline where possible. Do NOT list every function. Only include sections that actually exist in the file.\n` +
          `- relatedFiles: files that belong to the same feature/workflow or are logically related. You may include files not listed in imports. Max 8. Only real paths.\n` +
          `- startLine/endLine must be within 1..${lineCount} and startLine <= endLine.`
      ),
      userPrompt(`FILE\n${relPath}\n\n${contextText}`)
    ],
    schemas.fileOverview,
    {
      jsonSchema: schemas.fileOverview,
      normalize: (v) => {
        const obj = (v ?? {}) as Record<string, unknown>
        const relatedFiles = Array.isArray(obj.relatedFiles)
          ? obj.relatedFiles.map((r: unknown) =>
              typeof r === 'string'
                ? { path: r, reason: '', relationshipType: 'semantic' }
                : r
            )
          : []
        const sections = Array.isArray(obj.sections)
          ? obj.sections.map((s: unknown) => {
              if (s && typeof s === 'object') {
                const so = s as Record<string, unknown>
                const title = so.title ?? so.name
                return { title, startLine: so.startLine, endLine: so.endLine }
              }
              return s
            })
          : []
        return renameKeys({ ...obj, relatedFiles, sections }, {
          name: ['title'],
          type: ['relationshipType'],
          relPath: ['path'],
          file: ['path']
        })
      }
    }
  )

  const sections = validateSections(result.sections ?? [], lineCount, text)
  const relatedFiles = await validateRelatedFiles(runtime, result.relatedFiles ?? [], relPath)
  const overview: FileOverview = {
    path: relPath,
    summary: result.summary.slice(0, 500),
    sections,
    relatedFiles,
    cached: false,
    generatedAt: Date.now(),
    model
  }
  putArtifact({
    kind: 'file-overview',
    filePath: relPath,
    inputHash,
    model,
    promptVersion: PROMPT_VERSION,
    resultJson: JSON.stringify(overview),
    generatedAt: overview.generatedAt
  })
  return overview
}

function validateSections(sections: FileSection[], lineCount: number, text: string): FileSection[] {
  const lines = splitLines(text)
  const out: FileSection[] = []
  for (const s of sections) {
    const start = Math.max(1, Math.min(lineCount, Math.floor(s.startLine)))
    const end = Math.max(start, Math.min(lineCount, Math.floor(s.endLine)))
    if (start > lineCount) continue
    const title = String(s.title ?? '').trim().slice(0, 80)
    if (!title) continue
    // sanity: non-empty slice
    if (lines.slice(start - 1, end).join('').trim() === '') continue
    out.push({ title, startLine: start, endLine: end })
  }
  return out.slice(0, 12)
}

async function validateRelatedFiles(
  _runtime: OpRuntime,
  related: RelatedFile[],
  current: string
): Promise<RelatedFile[]> {
  const { promises: fs } = await import('fs')
  const { resolveInProject } = await import('../../project')
  const out: RelatedFile[] = []
  for (const r of related.slice(0, 8)) {
    const path = String(r.path ?? '')
    if (!path || path === current) continue
    const abs = await resolveInProject(path)
    if (!abs) continue
    try {
      await fs.stat(abs)
      out.push({
        path,
        reason: String(r.reason ?? '').slice(0, 160) || 'related',
        relationshipType: r.relationshipType === 'direct' ? 'direct' : 'semantic'
      })
    } catch {
      /* skip nonexistent */
    }
  }
  return out
}

/** Features known from a previous project-features pass (best-effort, deterministic). */
let featureCache: { name: string; searchHints: string[] }[] = []

export function setFeaturesForMemento(features: { name: string; searchHints: string[] }[]): void {
  featureCache = features
}

async function mementoFeatures(): Promise<{ name: string; searchHints: string[] }[]> {
  try {
    const artifact = getLatestArtifact('project-features')
    if (artifact) {
      const parsed = JSON.parse(artifact.resultJson) as { features: { name: string; searchHints: string[] }[] }
      return parsed.features ?? []
    }
  } catch {
    /* ignore */
  }
  return featureCache
}

void getSymbols