import { schemas } from './schemas'
import type { JSONSchema } from '../json'
import { OpRuntime, structuredGenerate, JSON_SYSTEM, systemPrompt, userPrompt, filterValidPaths } from './helpers'
import { TextEdit, ChangeRequest } from '../../../shared/types'
import { splitLines, sliceLines, languageFromPath, joinLines } from '../../../shared/utils'
import { readFileBounded, budgetFromContextWindow, makeSectionBuilder, buildProjectManifest } from '../context'
import { getSymbols, getChunks, getImports, getReferences } from '../../core/retrieval'
import { textSearch } from '../../core/text-search'
import { fuzzyFiles } from '../../core/file-search'
import { createChangeRequest } from '../../core/patcher'
import { getProjectRoot } from '../../project'
import { readProjectFile } from '../../project'
import { listDirectorySafe, projectStructureText } from '../../core/codebase-tools'

export const PROMPT_VERSION = 1

const MAX_TOOL_ITERS = 15

/**
 * Lenient normalization for edit proposals: tolerate "changes" instead of
 * "edits", arrays of edits, wrapper objects, and per-edit key variants
 * (type/op/action → operation, file/filePath → path, code/newContent →
 * replacement). Empty/missing edits default to [] — the op then reports a
 * friendly "no edits proposed" error.
 */
export function editsNormalize(v: unknown): unknown {
  const normEdit = (e: unknown): unknown => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return {}
    const o = e as Record<string, unknown>
    let operation =
      typeof o.operation === 'string' ? o.operation : typeof o.type === 'string' ? o.type : typeof o.op === 'string' ? o.op : typeof o.action === 'string' ? o.action : ''
    if (operation === 'modify') operation = 'replace'
    if (operation === 'add' || operation === 'new') operation = 'create'
    if (operation === 'remove') operation = 'delete'
    // infer replace/insert when the operation key is missing entirely
    if (!operation && typeof o.replacement === 'string') {
      operation = typeof o.startLine === 'number' ? 'replace' : 'insert'
    }
    const path = (o.path ?? o.file ?? o.filePath ?? o.fileName ?? '') as string
    const replacement =
      (typeof o.replacement === 'string' ? o.replacement : '') ||
      (operation !== 'create' && typeof o.content === 'string' ? o.content : '') ||
      (typeof o.newContent === 'string' ? o.newContent : '') ||
      (typeof o.code === 'string' ? o.code : '')
    const content = typeof o.content === 'string' ? o.content : typeof o.replacement === 'string' && operation === 'create' ? o.replacement : ''
    const out: Record<string, unknown> = { operation, path }
    if (typeof o.startLine === 'number') out.startLine = o.startLine
    if (typeof o.endLine === 'number') out.endLine = o.endLine
    if (operation !== 'create' && replacement) out.replacement = replacement
    if (operation === 'create' && content) out.content = content
    return out
  }
  const pick = (o: Record<string, unknown>): unknown => {
    const raw = Array.isArray(o.edits) ? o.edits : Array.isArray(o.changes) ? o.changes : []
    return {
      summary: typeof o.summary === 'string' ? o.summary : '',
      edits: raw.map(normEdit)
    }
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) return pick(v as Record<string, unknown>)
  if (Array.isArray(v)) {
    const inner = v.find((x) => x && typeof x === 'object' && !Array.isArray(x))
    if (inner) return pick(inner as Record<string, unknown>)
  }
  return v
}

// ---------------------------------------------------------------------------
// Selection edit
// ---------------------------------------------------------------------------

export async function selectionEditOp(
  runtime: OpRuntime,
  input: {
    prompt: string
    filePath: string
    selectionStart: { line: number; character: number }
    selectionEnd: { line: number; character: number }
    selectedText: string
  }
): Promise<ChangeRequest> {
  const filePath = input.filePath
  const text = await readProjectFile(filePath).catch(() => null)
  if (text === null) throw new Error(`File not found: ${filePath}`)
  const lines = splitLines(text)
  const lineCount = lines.length
  const selStart = Math.max(1, Math.min(lineCount, input.selectionStart.line + 1))
  const selEnd = Math.max(selStart, Math.min(lineCount, input.selectionEnd.line + 1))
  const language = languageFromPath(filePath)

  // surrounding context: 10 lines before, 10 after
  const before = sliceLines(text, Math.max(1, selStart - 10), selStart - 1)
  const after = sliceLines(text, selEnd + 1, Math.min(lineCount, selEnd + 10))
  const selected = input.selectedText || sliceLines(text, selStart, selEnd)

  // containing symbol
  let containing = ''
  try {
    const syms = getSymbols(filePath)
    const hit = [...syms].reverse().find((s) => s.startLine <= selStart && s.endLine >= selEnd)
    if (hit) containing = `${hit.kind} ${hit.parent ? hit.parent + '.' : ''}${hit.name} (lines ${hit.startLine}-${hit.endLine})`
  } catch {
    /* ignore */
  }

  void buildProjectManifest
  runtime.status('Preparing edit context…')
  const budget = budgetFromContextWindow(runtime.gateway.getConfig().contextWindow)
  const b = makeSectionBuilder(budget)
  b.addSection('REQUEST', input.prompt)
  b.addSection('FILE', `${filePath} (${language})${containing ? `\nCONTAINING SYMBOL: ${containing}` : ''}\nSELECTED LINES ${selStart}-${selEnd}`)
  b.addSection('SELECTED CODE', selected)
  if (before.trim()) b.addSection('CODE BEFORE SELECTION', before)
  if (after.trim()) b.addSection('CODE AFTER SELECTION', after)

  runtime.status('Generating edit proposal…')
  const result = await structuredGenerate<{ summary: string; edits: TextEdit[] }>(
    runtime,
    [
      systemPrompt(
        `${JSON_SYSTEM}\n\nYou propose code edits. Output a structured edit list.\n` +
          `Rules for ${filePath}:\n` +
          `- Every edit MUST target exactly "${filePath}".\n` +
          `- Line ranges are 1-based inclusive. Selected region is ${selStart}-${selEnd}. You should stay INSIDE or directly adjacent (within 5 lines) to the selected region. Minor surrounding adjustments are permitted, large rewrites are not.\n` +
          `- operation "replace": replacement for lines startLine..endLine; "insert": insert replacement AFTER line startLine (0 = top of file).\n` +
          `- Return complete replacement code — the editor applies it deterministically.`
      ),
      userPrompt(b.sections.map((s) => `### ${s.title}\n${s.text}`).join('\n\n'))
    ],
    schemas.edits,
    { jsonSchema: schemas.edits, normalize: editsNormalize }
  )

  const validEdits = validateEditsTarget(result.edits ?? [], filePath, budget)
  const scopeEdits = restrictToSelection(validEdits, selStart, selEnd, lineCount)
  if (scopeEdits.length === 0) throw new Error('The AI did not propose any edits for the selected code — try rephrasing your request.')
  return createChangeRequest(
    {
      prompt: input.prompt,
      scope: 'selection',
      summary: result.summary || 'Selection edit',
      edits: scopeEdits
    },
    getProjectRoot()!
  )
}

function validateEditsTarget(edits: TextEdit[], filePath: string, budget: { usableInput: number }): TextEdit[] {
  void budget
  const out: TextEdit[] = []
  for (const e of edits) {
    if (e.operation === 'create') {
      if (e.path === filePath) {
        // treat as replace of whole selection? reject creates on same file
        continue
      }
      continue // creates not allowed in selection/file scope
    }
    if (e.path !== filePath) continue
    if (e.operation === 'replace' && typeof e.replacement !== 'string') continue
    if (e.operation === 'insert' && typeof e.replacement !== 'string') continue
    if (e.operation === 'delete' && (e.startLine === undefined || e.endLine === undefined)) continue
    out.push(e)
  }
  return out
}

function restrictToSelection(edits: TextEdit[], selStart: number, selEnd: number, lineCount: number): TextEdit[] {
  const MARGIN = 5
  const out: TextEdit[] = []
  for (const e of edits) {
    const s = e.startLine ?? 0
    const en = e.endLine ?? s
    const touches =
      (s >= selStart - MARGIN && s <= selEnd + MARGIN) ||
      (en >= selStart - MARGIN && en <= selEnd + MARGIN) ||
      (s <= selStart && en >= selEnd)
    if (touches) {
      const clamped = {
        ...e,
        startLine: Math.max(1, Math.min(lineCount, s)),
        endLine: Math.max(1, Math.min(lineCount, en))
      }
      out.push(clamped)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// File edit
// ---------------------------------------------------------------------------

export async function fileEditOp(
  runtime: OpRuntime,
  input: { prompt: string; filePath: string }
): Promise<ChangeRequest> {
  const filePath = input.filePath
  const text = await readProjectFile(filePath).catch(() => null)
  if (text === null) throw new Error(`File not found: ${filePath}`)
  const language = languageFromPath(filePath)
  const lineCount = splitLines(text).length

  const budget = budgetFromContextWindow(runtime.gateway.getConfig().contextWindow)
  const b = makeSectionBuilder(budget, { singleFileBudget: budget.usableInput })
  runtime.status('Loading file context…')
  const wholeBudgetOk = budget.usableInput > Math.ceil(text.length / 4) * 2 // file + prompt + output
  if (wholeBudgetOk) {
    b.addSection(`FILE ${filePath} (${language})`, text)
  } else {
    b.addSection(`FILE ${filePath} (${language}) — outline`, outlineText(filePath))
    const chunks = getChunks(filePath)
    for (const c of chunks.slice(0, 40)) {
      const slice = sliceLines(text, c.startLine, c.endLine)
      b.addSection(`${filePath}:${c.startLine}-${c.endLine}${c.symbolName ? ` (${c.symbolName})` : ''}`, slice)
    }
  }
  const manifest = await buildProjectManifest()
  if (manifest) {
    const deps = manifest.dependencies.slice(0, 12).join(', ')
    b.addSection('PROJECT', `root: ${manifest.rootName}\ndeps: ${deps}`)
  }
  runtime.status('Generating edit proposal…')
  const result = await structuredGenerate<{ summary: string; edits: TextEdit[] }>(
    runtime,
    [
      systemPrompt(
        `${JSON_SYSTEM}\n\nYou propose code edits for the active file. Output a structured edit list.\n` +
          `Rules for ${filePath}:\n` +
          `- Every edit MUST target exactly "${filePath}".\n` +
          `- Line ranges are 1-based inclusive and must lie within 1..${lineCount}.\n` +
          `- Edits must not overlap.\n` +
          `- operation "replace" replaces lines startLine..endLine; "insert" inserts AFTER line startLine (0 = top); "delete" removes lines startLine..endLine.\n` +
          `- Return complete replacement code.`
      ),
      userPrompt(b.sections.map((s) => `### ${s.title}\n${s.text}`).join('\n\n') + `\n\nREQUEST\n${input.prompt}`)
    ],
    schemas.edits,
    { jsonSchema: schemas.edits, normalize: editsNormalize }
  )
  const edits = validateEditsTarget(result.edits ?? [], filePath, budget).filter(
    (e) => (e.startLine ?? 0) <= lineCount && (e.endLine ?? 0) <= lineCount
  )
  if (edits.length === 0) throw new Error('The AI did not propose any edits for this file — try rephrasing your request.')
  return createChangeRequest(
    { prompt: input.prompt, scope: 'file', summary: result.summary || 'File edit', edits },
    getProjectRoot()!
  )
}

function outlineText(filePath: string): string {
  try {
    const syms = getSymbols(filePath)
    return syms.map((s) => `${s.kind} ${s.parent ? s.parent + '.' : ''}${s.name} (${s.startLine}-${s.endLine})`).join('\n') || '(none)'
  } catch {
    return '(index unavailable)'
  }
}

// ---------------------------------------------------------------------------
// Codebase plan (read-only exploration loop)
// ---------------------------------------------------------------------------

export interface CodebasePlan {
  summary: string
  files: { path: string; reason: string }[]
}

const planSchema: JSONSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['searchCode', 'findFiles', 'readFile', 'readLines', 'getSymbols', 'getImports', 'getReferences', 'listDirectory', 'getProjectStructure', 'finalPlan'] },
    query: { type: 'string' },
    path: { type: 'string' },
    startLine: { type: 'integer' },
    endLine: { type: 'integer' },
    summary: { type: 'string' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, reason: { type: 'string' } },
        required: ['path', 'reason'],
        additionalProperties: false
      }
    }
  },
  required: ['action'],
  additionalProperties: false
}

export async function codebasePlanOp(
  runtime: OpRuntime,
  input: { prompt: string }
): Promise<CodebasePlan> {
  const root = getProjectRoot()
  if (!root) throw new Error('no project open')
  const manifest = await buildProjectManifest()

  const messages = [
    systemPrompt(
      `${JSON_SYSTEM}\n\nYou are planning a codebase change with READ-ONLY tools. Decide what else you need to see, then call one tool. When you have enough understanding, return finalPlan.\n\n` +
        `TOOLS (respond with JSON {"action": ...}):\n` +
        `- {"action":"searchCode","query":"...","path":"optional relative path"} — deterministic grep\n` +
        `- {"action":"findFiles","query":"file or path term"} — fuzzy file search\n` +
        `- {"action":"readFile","path":"rel/path.ts"}\n` +
        `- {"action":"readLines","path":"rel/path.ts","startLine":1,"endLine":80}\n` +
        `- {"action":"getSymbols","path":"rel/path.ts"}\n` +
        `- {"action":"getImports","path":"rel/path.ts"}\n` +
        `- {"action":"getReferences","path":"rel/path.ts"}\n` +
        `- {"action":"listDirectory","path":"rel/dir"}\n` +
        `- {"action":"getProjectStructure"}\n` +
        `- {"action":"finalPlan","summary":"...","files":[{"path":"rel/path.ts","reason":"..."}]}\n\n` +
        `Always use relative paths from the project root. No more than ${MAX_TOOL_ITERS} tool calls.`
    ),
    userPrompt(`PROJECT MANIFEST\n${projectManifestText(manifest)}\n\nUSER REQUEST\n${input.prompt}`)
  ]

  for (let i = 0; i < MAX_TOOL_ITERS; i++) {
    runtime.status(`Planning (${i + 1}/${MAX_TOOL_ITERS})…`)
    const step = await structuredGenerate<{
      action: string
      query?: string
      path?: string
      startLine?: number
      endLine?: number
      summary?: string
      files?: { path: string; reason: string }[]
    }>(runtime, messages, planSchema, {
      jsonSchema: undefined,
      enableThinking: false,
      normalize: (v) => {
        // models occasionally wrap the single action in a JSON array
        if (Array.isArray(v) && v.length === 1 && v[0] && typeof v[0] === 'object' && !Array.isArray(v[0])) {
          return v[0]
        }
        return v
      }
    })

    if (!step.action) throw new Error('model returned no action')

    if (step.action === 'finalPlan') {
      const files = await validatePlanFiles(runtime, step.files ?? [])
      return { summary: step.summary ?? input.prompt, files }
    }

    const toolResult = await executeTool(runtime, step)
    if (toolResult.ERROR) {
      messages.push(userPrompt(JSON.stringify({ action: step.action, result: toolResult.ERROR })))
      continue
    }
    messages.push(userPrompt(`Tool result for ${step.action}:\n${toolResult.text}`))
  }
  throw new Error('Planning exceeded maximum iterations — try a more focused request')
}

async function validatePlanFiles(
  _runtime: OpRuntime,
  files: { path: string; reason: string }[]
): Promise<{ path: string; reason: string }[]> {
  const valid = await filterValidPaths(_runtime, files.map((f) => f.path))
  return files.filter((f) => valid.includes(f.path)).slice(0, 15)
}

async function executeTool(
  _runtime: OpRuntime,
  step: { action: string; query?: string; path?: string; startLine?: number; endLine?: number }
): Promise<{ text: string; ERROR?: string }> {
  const root = getProjectRoot()
  if (!root) return { text: '', ERROR: 'no project open' }
  switch (step.action) {
    case 'searchCode': {
      const query = step.query ?? ''
      if (!query) return { text: '', ERROR: 'missing query' }
      const inc = step.path ? [step.path] : undefined
      const hits = await textSearch(root, { query, maxResults: 40, includePaths: inc })
      if (hits.length === 0) return { text: 'no matches' }
      return {
        text: hits.slice(0, 30).map((h) => `${h.relPath}:${h.line}: ${h.lineText.trim().slice(0, 120)}`).join('\n')
      }
    }
    case 'findFiles': {
      const q = step.query ?? ''
      const hits = fuzzyFiles(q, 25)
      return { text: hits.map((h) => h.relPath).join('\n') || 'no matches' }
    }
    case 'readFile': {
      const p = step.path ?? ''
      const data = await readFileBounded(p, { maxChars: 20000 })
      return data ? { text: data.text } : { text: '', ERROR: `cannot read ${p}` }
    }
    case 'readLines': {
      const p = step.path ?? ''
      const s = Math.max(1, step.startLine ?? 1)
      const e = Math.max(s, step.endLine ?? s + 40)
      const data = await readFileBounded(p, { includeLines: [s, e], maxChars: 16000 })
      return data ? { text: data.text } : { text: '', ERROR: `cannot read ${p}` }
    }
    case 'getSymbols': {
      const p = step.path ?? ''
      const syms = getSymbols(p)
      return { text: syms.map((s) => `${s.kind} ${s.parent ? s.parent + '.' : ''}${s.name} ${s.startLine}-${s.endLine}`).join('\n') || 'no symbols' }
    }
    case 'getImports': {
      const p = step.path ?? ''
      const imports = getImports(p)
      return { text: imports.map((i) => i.rawTarget + (i.resolvedRelPath ? ` → ${i.resolvedRelPath}` : '')).join('\n') || 'no imports' }
    }
    case 'getReferences': {
      const p = step.path ?? ''
      const refs = getReferences(p)
      return { text: refs.join('\n') || 'no references' }
    }
    case 'listDirectory': {
      const p = step.path ?? ''
      const entries = await listDirectorySafe(p)
      return { text: entries.slice(0, 60).map((e) => (e.isDir ? `${e.name}/` : e.name)).join('\n') }
    }
    case 'getProjectStructure': {
      return { text: await projectStructureText() }
    }
    default:
      return { text: '', ERROR: `unknown tool: ${step.action}` }
  }
}

function projectManifestText(manifest: Awaited<ReturnType<typeof buildProjectManifest>>): string {
  if (!manifest) return '(unknown)'
  return [
    `root: ${manifest.rootName}`,
    'structure:', ...manifest.structure.slice(0, 30).map((s) => `  ${s}`),
    'important files:', ...manifest.importantFiles.map((s) => `  ${s}`),
    'scripts:', ...manifest.scripts.slice(0, 10).map((s) => `  ${s}`)
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Codebase edit generation
// ---------------------------------------------------------------------------

export async function codebaseEditOp(
  runtime: OpRuntime,
  input: { prompt: string; plan: CodebasePlan }
): Promise<ChangeRequest> {
  const root = getProjectRoot()
  if (!root) throw new Error('no project open')
  const planFiles = input.plan.files ?? []
  if (planFiles.length === 0) throw new Error('plan listed no files to change')

  runtime.status('Loading planned files…')
  const budget = budgetFromContextWindow(runtime.gateway.getConfig().contextWindow)
  const b = makeSectionBuilder(budget, { singleFileBudget: budget.usableInput * 0.6 })
  b.addSection('REQUEST', input.prompt)
  b.addSection('PLAN', input.plan.summary)
  for (const f of planFiles.slice(0, 8)) {
    const data = await readFileBounded(f.path, { maxChars: budget.usableInput * 4 })
    if (!data) continue
    b.addSection(`FILE ${f.path} — ${f.reason}`, data.text)
  }

  runtime.status('Generating edits…')
  const result = await structuredGenerate<{ summary: string; edits: TextEdit[] }>(
    runtime,
    [
      systemPrompt(
        `${JSON_SYSTEM}\n\nPropose a multi-file code change implementing the plan. Output structured edits.\n` +
          `Rules:\n` +
          `- target files: ${planFiles.map((f) => `"${f.path}"`).join(', ')}; you may create NEW files only under existing directories.\n` +
          `- Line ranges are 1-based inclusive and must exist in the shown content.\n` +
          `- replace: replacement for lines startLine..endLine; insert: after line startLine (0 = top); create: new file with content; delete: lines startLine..endLine.\n` +
          `- Return complete code.`
      ),
      userPrompt(b.sections.map((s) => `### ${s.title}\n${s.text}`).join('\n\n'))
    ],
    schemas.edits,
    { jsonSchema: schemas.edits, normalize: editsNormalize }
  )
  const edits = validateCodebaseEdits(result.edits ?? [], planFiles)
  if (edits.length === 0) throw new Error('The AI did not propose any edits for the planned change — try rephrasing or accepting smaller changes.')
  return createChangeRequest(
    { prompt: input.prompt, scope: 'codebase', summary: result.summary || 'Codebase edit', edits },
    root
  )
}

function validateCodebaseEdits(edits: TextEdit[], planFiles: { path: string; reason: string }[]): TextEdit[] {
  const allowed = new Set(planFiles.map((f) => f.path))
  const out: TextEdit[] = []
  for (const e of edits) {
    if (e.operation === 'create') {
      // path may be new; parent must exist — validated later by patcher
      out.push(e)
      continue
    }
    if (!allowed.has(e.path)) continue
    if (e.operation === 'replace' && typeof e.replacement !== 'string') continue
    if (e.operation === 'insert' && typeof e.replacement !== 'string') continue
    if (e.operation === 'delete' && (e.startLine === undefined || e.endLine === undefined)) continue
    out.push(e)
  }
  return out
}

void sliceLines
void joinLines
void getImports
void getReferences