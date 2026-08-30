import {
  estimateTokens,
  sliceLines,
  languageFromPath,
  splitLines,
  joinLines
} from '../../shared/utils'
import {
  fileMeta,
  getSymbols,
  getChunks,
  getImports,
  getReferences
} from '../core/retrieval'
import { getProjectRoot } from '../project'
import { readProjectFile } from '../project'
import { SymbolInfo, ChunkInfo } from '../../shared/types'

/**
 * AIContextBuilder — retrieves, never dumps.
 *
 * The Model Gateway does NOT decide which files are relevant. This subsystem
 * builds a bounded context from the deterministic project index, following a
 * strict priority order and token budget.
 *
 * Priority (highest first):
 *   1. user instruction
 *   2. selected code / target file
 *   3. direct references
 *   4. relevant chunks
 *   5. project metadata
 *   6. previous contextual information
 */

export interface ProjectManifest {
  rootName: string
  structure: string[]
  importantFiles: string[]
  dependencies: string[]
  scripts: string[]
  readmeSnippet: string
}

export class TokenBudget {
  constructor(
    public readonly total: number,
    public readonly reservedOutput: number,
    public readonly instructions: number
  ) {}

  get usableInput(): number {
    return Math.max(1024, this.total - this.reservedOutput - this.instructions)
  }
}

export function budgetFromContextWindow(contextWindow: number): TokenBudget {
  const total = contextWindow > 0 ? contextWindow : 32768
  return new TokenBudget(total, Math.min(8192, Math.round(total * 0.15)), 2048)
}

export interface SectionBuilder {
  addSection(title: string, text: string): void
  sections: { title: string; text: string }[]
  withinBudget: boolean
  tokensUsed: number
}

/** Ordered sections; once over budget, lower-priority sections are cut (never truncated mid-construct when avoidable). */
export function makeSectionBuilder(budget: TokenBudget, opts?: { singleFileBudget?: number }): SectionBuilder {
  const sections: { title: string; text: string }[] = []
  let tokens = 0
  return {
    sections,
    get withinBudget(): boolean {
      return tokens <= budget.usableInput
    },
    get tokensUsed(): number {
      return tokens
    },
    addSection(title: string, text: string): void {
      if (!text) return
      const t = estimateTokens(text)
      if (tokens + t > budget.usableInput) return // drop instead of truncate
      if (opts?.singleFileBudget && t > opts.singleFileBudget) return
      sections.push({ title, text })
      tokens += t
    }
  }
}

export function renderSections(sections: { title: string; text: string }[]): string {
  return sections.map((s) => `### ${s.title}\n${s.text}`).join('\n\n')
}

// ---------------------------------------------------------------------------
// Deterministic retrieval helpers for context building
// ---------------------------------------------------------------------------

export async function readFileRel(relPath: string): Promise<string | null> {
  const root = getProjectRoot()
  if (!root) return null
  try {
    return await readProjectFile(relPath)
  } catch {
    return null
  }
}

export interface FileContextOptions {
  maxChars?: number
  includeLines?: [number, number]
}

/** Read a file's text, optionally bounded by line range or max chars. */
export async function readFileBounded(
  relPath: string,
  opts: FileContextOptions = {}
): Promise<{ text: string; full: boolean; lineCount: number } | null> {
  const text = await readFileRel(relPath)
  if (text === null) return null
  const lines = splitLines(text)
  let out = text
  if (opts.includeLines) {
    const [s, e] = opts.includeLines
    out = sliceLines(text, s, e)
  }
  if (opts.maxChars && out.length > opts.maxChars) {
    out = out.slice(0, opts.maxChars) + '\n// …(truncated)'
  }
  return { text: out, full: out === text, lineCount: lines.length }
}

/** Symbol outline text for prompt inclusion. */
export function renderOutline(relPath: string): string {
  let symbols: SymbolInfo[] = []
  try {
    symbols = getSymbols(relPath)
  } catch {
    return '(index unavailable)'
  }
  if (symbols.length === 0) return '(no symbols indexed)'
  return symbols
    .map((s) => {
      const parent = s.parent ? `${s.parent}.` : ''
      return `${s.kind} ${parent}${s.name}  lines ${s.startLine}-${s.endLine}`
    })
    .join('\n')
}

export function renderChunkLines(relPath: string, chunk: ChunkInfo): string {
  return `${relPath}:${chunk.startLine}-${chunk.endLine}${chunk.symbolName ? ` (${chunk.symbolName})` : ''}`
}

/** Build a compact context section for one relevant file: outline + selected chunks or whole file if small. */
export async function buildFileContextSection(
  relPath: string,
  builder: SectionBuilder,
  opts: { includeFullWhenSmall?: boolean; chunkBudget?: number } = {}
): Promise<void> {
  const meta = fileMeta(relPath)
  const text = await readFileRel(relPath)
  if (text === null || !meta) return
  const lang = meta.language
  const outline = renderOutline(relPath)
  const chunks = getChunks(relPath)

  if (opts.includeFullWhenSmall !== false && text.length < 40000) {
    builder.addSection(`FILE ${relPath} (${lang})`, text)
    return
  }
  // bounded: outline + chunk slices
  builder.addSection(`FILE ${relPath} (${lang}) — outline`, outline)
  const usable = chunks.filter((c) => c.kind !== 'top' || c.startLine > 1)
  for (const c of usable.slice(0, opts.chunkBudget ?? 30)) {
    const slice = sliceLines(text, c.startLine, c.endLine)
    builder.addSection(renderChunkLines(relPath, c), slice)
  }
}

// ---------------------------------------------------------------------------
// Project manifest (deterministic, used by every project-level AI op)
// ---------------------------------------------------------------------------

export async function buildProjectManifest(): Promise<ProjectManifest | null> {
  const root = getProjectRoot()
  if (!root) return null
  const rootName = root.split('/').filter(Boolean).pop() ?? root
  const structure = (await firstLevels(root)).slice(0, 40)
  const deps = await readDependencies(root)
  const scripts = await readScripts(root)
  const importantFiles = await findImportantFiles(root)
  const readmeSnippet = await readReadme(root)
  return { rootName, structure, importantFiles, dependencies: deps, scripts, readmeSnippet }
}

async function firstLevels(root: string): Promise<string[]> {
  const { promises: fs } = await import('fs')
  const { isIgnored } = await import('../../shared/utils')
  const rows: string[] = []
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory()) {
        if (isIgnored(e.name)) continue
        rows.push(`${e.name}/`)
        // one level deeper, top 3 each
        try {
          const sub = await fs.readdir(pathJoin(root, e.name), { withFileTypes: true })
          const dirs = sub.filter((s) => s.isDirectory() && !isIgnored(s.name)).slice(0, 3)
          for (const d of dirs) rows.push(`  ${e.name}/${d.name}/`)
        } catch {
          /* ignore */
        }
      } else if (e.isFile()) {
        rows.push(e.name)
      }
    }
  } catch {
    /* ignore */
  }
  return rows
}

function pathJoin(...parts: string[]): string {
  const path = require('path') as typeof import('path')
  return path.join(...parts)
}

async function readDependencies(root: string): Promise<string[]> {
  const { promises: fs } = await import('fs')
  const out = new Set<string>()
  try {
    const pkg = JSON.parse(await fs.readFile(pathJoin(root, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    for (const k of Object.keys(pkg.dependencies ?? {})) out.add(k)
    for (const k of Object.keys(pkg.devDependencies ?? {})) out.add(`${k} (dev)`)
    if (out.size) return [...out].slice(0, 30)
  } catch {
    /* no package.json */
  }
  try {
    const txt = await fs.readFile(pathJoin(root, 'requirements.txt'), 'utf-8')
    return txt.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).slice(0, 30)
  } catch {
    /* ignore */
  }
  return [...out].slice(0, 30)
}

async function readScripts(root: string): Promise<string[]> {
  const { promises: fs } = await import('fs')
  try {
    const pkg = JSON.parse(await fs.readFile(pathJoin(root, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>
    }
    if (!pkg.scripts) return []
    return Object.entries(pkg.scripts).map(([k, v]) => `${k}: ${v}`)
  } catch {
    return []
  }
}

export async function discoverRunCommands(): Promise<
  { label: string; command: string; source: string; verified: boolean }[]
> {
  const root = getProjectRoot()
  if (!root) return []
  const { promises: fs } = await import('fs')
  const out: { label: string; command: string; source: string; verified: boolean }[] = []
  try {
    const pkg = JSON.parse(await fs.readFile(pathJoin(root, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>
    }
    const scripts = pkg.scripts ?? {}
    const map: [string, string][] = [
      ['Development', 'dev'],
      ['Build', 'build'],
      ['Test', 'test'],
      ['Start', 'start'],
      ['Lint', 'lint'],
      ['Typecheck', 'typecheck']
    ]
    for (const [label, key] of map) {
      const value = scripts[key]
      if (typeof value === 'string') {
        out.push({ label, command: `npm run ${key}`, source: 'package.json', verified: true })
      }
    }
    if (out.length === 0) {
      const first = Object.entries(scripts).slice(0, 3)
      for (const [k] of first) out.push({ label: k[0].toUpperCase() + k.slice(1), command: `npm run ${k}`, source: 'package.json', verified: true })
    }
    return out
  } catch {
    /* no package.json */
  }
  try {
    const make = await fs.readFile(pathJoin(root, 'Makefile'), 'utf-8')
    const targets = make
      .split(/\r?\n/)
      .filter((l) => /^[a-zA-Z0-9_.-]+\s*:/.test(l) && !/^\t/.test(l) && !/^\./.test(l))
      .map((l) => l.split(':')[0].trim())
      .slice(0, 5)
    for (const t of targets) out.push({ label: t[0].toUpperCase() + t.slice(1), command: `make ${t}`, source: 'Makefile', verified: true })
    return out
  } catch {
    /* no Makefile */
  }
  return out
}

async function findImportantFiles(root: string): Promise<string[]> {
  const { promises: fs } = await import('fs')
  const candidates = [
    'README.md', 'readme.md', 'package.json', 'composer.json', 'Cargo.toml',
    'pyproject.toml', 'Makefile', 'docker-compose.yml', 'Dockerfile', '.env.example',
    'vite.config.ts', 'vite.config.js', 'webpack.config.js', 'tsconfig.json',
    'src/main.ts', 'src/main.tsx', 'src/App.tsx', 'src/index.ts', 'src/index.tsx',
    'app/main.py', 'src/main.py', 'main.py', 'index.html', 'go.mod', 'build.gradle', 'pom.xml'
  ]
  const found: string[] = []
  for (const c of candidates) {
    try {
      await fs.access(pathJoin(root, c))
      found.push(c)
    } catch {
      /* ignore */
    }
  }
  return found
}

async function readReadme(root: string): Promise<string> {
  const { promises: fs } = await import('fs')
  for (const name of ['README.md', 'readme.md', 'Readme.md']) {
    try {
      const text = await fs.readFile(pathJoin(root, name), 'utf-8')
      return text.slice(0, 2000)
    } catch {
      /* ignore */
    }
  }
  return ''
}

/** Minimal deterministic structure string used in prompts (never a full dump). */
export async function structureOverview(): Promise<string> {
  const manifest = await buildProjectManifest()
  if (!manifest) return ''
  const parts = [
    `PROJECT ROOT: ${manifest.rootName}`,
    'STRUCTURE:',
    ...manifest.structure.map((s) => `  ${s}`),
    'IMPORTANT FILES:',
    ...manifest.importantFiles.map((s) => `  ${s}`),
    'DEPENDENCIES:',
    ...manifest.dependencies.map((s) => `  ${s}`),
    'SCRIPTS:',
    ...manifest.scripts.map((s) => `  ${s}`)
  ]
  if (manifest.readmeSnippet) {
    parts.push('README SNIPPET:', manifest.readmeSnippet.slice(0, 800))
  }
  return parts.join('\n')
}

export { fileMeta, getSymbols, getChunks, getImports, getReferences, languageFromPath, joinLines }
export type { SymbolInfo, ChunkInfo }