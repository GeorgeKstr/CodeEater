import Parser from 'web-tree-sitter'
import { promises as fs } from 'fs'
import * as fsSync from 'fs'
import path from 'path'
import crypto from 'crypto'
import { createRequire } from 'module'
import { SymbolInfo, SymbolKind, ChunkInfo, ImportInfo } from '../../shared/types'
import { languageFromPath, tsGrammarForLanguage, isIgnored } from '../../shared/utils'
import { getDb } from '../persistence/database'

const require = createRequire(import.meta.url)

type TsLanguage = Parser.Language
type TsNode = Parser.SyntaxNode
type TsTree = Parser.Tree

/**
 * Deterministic structural indexing with tree-sitter (WASM grammars).
 * Produces symbols, imports and semantic chunk boundaries used for AI context.
 * This module performs no AI work and no mutations.
 */

interface NodeSpec {
  type: string
  kind: SymbolKind
}

const TS_SPECS: NodeSpec[] = [
  { type: 'function_declaration', kind: 'function' },
  { type: 'method_definition', kind: 'method' },
  { type: 'class_declaration', kind: 'class' },
  { type: 'interface_declaration', kind: 'interface' },
  { type: 'type_alias_declaration', kind: 'type' },
  { type: 'enum_declaration', kind: 'enum' },
  { type: 'module_declaration', kind: 'module' }
]

const GENERIC_SPECS: NodeSpec[] = [
  { type: 'function_definition', kind: 'function' },
  { type: 'function_declaration', kind: 'function' },
  { type: 'method_definition', kind: 'method' },
  { type: 'method_declaration', kind: 'method' },
  { type: 'class_declaration', kind: 'class' },
  { type: 'class_definition', kind: 'class' },
  { type: 'interface_declaration', kind: 'interface' },
  { type: 'trait_declaration', kind: 'interface' },
  { type: 'struct_declaration', kind: 'class' },
  { type: 'enum_declaration', kind: 'enum' },
  { type: 'type_alias_declaration', kind: 'type' },
  { type: 'mod_declaration', kind: 'module' }
]

/** node types whose value is an anonymous/arrow function → symbol */
const FN_VALUE_TYPES = new Set(['arrow_function', 'function_expression', 'function', 'lambda'])

interface ParsedFile {
  symbols: SymbolInfo[]
  imports: ImportInfo[]
  chunks: ChunkInfo[]
}

export class TreeSitterIndexer {
  private inited = false
  private langs = new Map<string, TsLanguage>()

  async init(): Promise<void> {
    if (this.inited) return
    const wasmPath = require.resolve('web-tree-sitter/tree-sitter.wasm')
    await Parser.init({ locateFile: () => wasmPath })
    this.inited = true
  }

  private grammarDir(): string {
    return path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out')
  }

  private async langFor(langId: string): Promise<TsLanguage | null> {
    const grammar = tsGrammarForLanguage(langId)
    if (!grammar) return null
    const cached = this.langs.get(grammar)
    if (cached) return cached
    try {
      const bytes = fsSync.readFileSync(path.join(this.grammarDir(), `tree-sitter-${grammar}.wasm`))
      const lang = await Parser.Language.load(bytes)
      this.langs.set(grammar, lang)
      return lang
    } catch (e) {
      console.warn('failed to load grammar', grammar, e)
      return null
    }
  }

  /** Returns null when the language has no grammar or parsing fails. */
  async parse(text: string, langId: string): Promise<ParsedFile | null> {
    await this.init()
    const lang = await this.langFor(langId)
    if (!lang) return null
    const parser = new Parser()
    parser.setLanguage(lang)
    let tree: TsTree | null = null
    try {
      tree = parser.parse(text)
    } catch {
      return null
    }
    const specs =
      langId === 'typescript' || langId === 'javascript' || langId === 'tsx'
        ? TS_SPECS
        : GENERIC_SPECS
    try {
      if (!tree) return null
      return this.extract(tree, text, langId, specs)
    } finally {
      parser.delete()
      tree?.delete()
    }
  }

  private extract(
    tree: TsTree,
    text: string,
    langId: string,
    specs: NodeSpec[]
  ): ParsedFile {
    const symbols: SymbolInfo[] = []
    const imports: ImportInfo[] = []
    const specByType = new Map(specs.map((s) => [s.type, s.kind]))
    this.walk(tree.rootNode, specByType, langId, symbols, imports, null, new Set())
    const chunks = this.buildChunks(symbols, text)
    return { symbols, imports, chunks }
  }

  private walk(
    node: TsNode,
    specByType: Map<string, SymbolKind>,
    langId: string,
    symbols: SymbolInfo[],
    imports: ImportInfo[],
    parentClass: string | null,
    visited: Set<TsNode>
  ): void {
    if (visited.has(node)) return
    visited.add(node)
    const t = node.type

    if (t === 'import_statement' || t === 'import_declaration' || t === 'preproc_include') {
      const target = extractImportTarget(node.text, langId)
      if (target) imports.push({ rawTarget: target, kind: importKind(t) })
    }
    if (t === 'call_expression' && (langId === 'javascript' || langId === 'typescript' || langId === 'tsx')) {
      const m = /require\(\s*['"]([^'"]+)['"]\s*\)/.exec(node.text)
      if (m) imports.push({ rawTarget: m[1], kind: 'require' })
    }
    if (t === 'import_from_statement' || t === 'include_statement' || t === 'use_declaration') {
      const target = extractImportTarget(node.text, langId)
      if (target) imports.push({ rawTarget: target, kind: importKind(t) })
    }

    const kind = specByType.get(t)
    if (kind) {
      const name = fieldName(node) ?? deriveName(node, t)
      if (name) {
        symbols.push({
          name,
          kind,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          parent: parentClass ?? undefined
        })
      }
      const container =
        t === 'class_declaration' || t === 'class_definition' || t === 'struct_declaration'
          ? (name ?? parentClass)
          : parentClass
      for (const child of node.namedChildren) {
        this.walk(child, specByType, langId, symbols, imports, container, visited)
      }
      return
    }

    if ((t === 'lexical_declaration' || t === 'variable_declaration') && isFunctionValue(node)) {
      const name = firstDeclaratorName(node)
      if (name) {
        symbols.push({
          name,
          kind: 'function',
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          parent: parentClass ?? undefined
        })
      }
    }

    for (const child of node.namedChildren) {
      this.walk(child, specByType, langId, symbols, imports, parentClass, visited)
    }
  }

  private buildChunks(symbols: SymbolInfo[], text: string): ChunkInfo[] {
    if (symbols.length === 0) {
      const lineCount = Math.max(1, text.split(/\r?\n/).length)
      return [{ startLine: 1, endLine: lineCount, kind: 'top' }]
    }
    // all symbols (functions, methods, classes) become chunks, sorted by position
    const sorted = [...symbols].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)
    const seen = new Set<string>()
    const chunks: ChunkInfo[] = []
    for (const s of sorted) {
      if (s.endLine < s.startLine) continue
      const key = `${s.kind}:${s.name}:${s.startLine}`
      if (seen.has(key)) continue
      seen.add(key)
      chunks.push({ startLine: s.startLine, endLine: s.endLine, symbolName: s.name, kind: s.kind })
    }
    if (chunks.length > 0 && chunks[0].startLine > 1) {
      chunks.unshift({ startLine: 1, endLine: chunks[0].startLine - 1, kind: 'top' })
    }
    return chunks
  }
}

function importKind(t: string): 'import' | 'require' | 'include' | 'use' {
  if (t === 'preproc_include') return 'include'
  if (t === 'call_expression') return 'require'
  if (t === 'use_declaration') return 'use'
  return 'import'
}

function extractImportTarget(raw: string, langId: string): string | null {
  const noComment = raw.replace(/\/\/.*$/gm, '').trim()
  let m = /\bfrom\s*['"]([^'"]+)['"]/.exec(noComment)
  if (!m) m = /^\s*import\s+['"]([^'"]+)['"]/.exec(noComment)
  if (!m) m = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/.exec(raw)
  if (!m) m = /^\s*use\s+([\w:]+)/.exec(raw)
  if (!m && langId === 'python') {
    m = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/.exec(noComment)
    if (m) return (m[1] ?? m[2]).split('.')[0]
  }
  if (!m && langId === 'go') {
    m = /"([^"]+)"/.exec(noComment)
  }
  return m ? m[1] : null
}

function fieldName(node: TsNode): string | null {
  const child = node.childForFieldName('name')
  if (child) return child.text
  return null
}

function deriveName(node: TsNode, t: string): string | null {
  if (t === 'impl_item' || t === 'mod_declaration') return null
  return fieldName(node)
}

function isFunctionValue(node: TsNode): boolean {
  for (const child of node.namedChildren) {
    if (FN_VALUE_TYPES.has(child.type)) return true
    if (child.type === 'variable_declarator') {
      for (const c of child.namedChildren) {
        if (FN_VALUE_TYPES.has(c.type)) return true
      }
    }
  }
  return false
}

function firstDeclaratorName(node: TsNode): string | null {
  for (const child of node.namedChildren) {
    if (child.type === 'variable_declarator') {
      const name = child.childForFieldName('name')
      if (name) return name.text
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Indexer: persists parsed structure to SQLite
// ---------------------------------------------------------------------------

export interface IndexedFileRecord {
  relPath: string
  language: string
  size: number
  mtime: number
  contentHash: string
  symbols: SymbolInfo[]
  imports: ImportInfo[]
  chunks: ChunkInfo[]
}

export async function readFileForIndex(
  absPath: string
): Promise<{ text: string; size: number; mtime: number } | null> {
  try {
    const buf = await fs.readFile(absPath)
    const st = await fs.stat(absPath)
    return { text: buf.toString('utf-8'), size: st.size, mtime: st.mtimeMs }
  } catch {
    return null
  }
}

export function hashContent(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

let globalTsIndexer: TreeSitterIndexer | null = null

export function getTsIndexer(): TreeSitterIndexer {
  if (!globalTsIndexer) globalTsIndexer = new TreeSitterIndexer()
  return globalTsIndexer
}

/** Index one file into the DB; removes existing rows for that path first. */
export async function indexFile(absPath: string, projectRoot: string): Promise<void> {
  const rel = path.relative(projectRoot, absPath).split(path.sep).join('/')
  if (isIgnored(rel)) return
  const data = await readFileForIndex(absPath)
  if (!data) return
  const language = languageFromPath(rel)
  const parsed = await getTsIndexer().parse(data.text, language)
  let symbols: SymbolInfo[] = []
  let imports: ImportInfo[] = []
  let chunks: ChunkInfo[] = []
  if (parsed) {
    symbols = parsed.symbols
    imports = parsed.imports
    chunks = parsed.chunks
  } else {
    const lines = data.text.split(/\r?\n/)
    chunks = [{ startLine: 1, endLine: Math.max(1, lines.length), kind: 'top' }]
  }
  persistIndexedFile(
    {
      relPath: rel,
      language,
      size: data.size,
      mtime: data.mtime,
      contentHash: hashContent(data.text),
      symbols,
      imports,
      chunks
    },
    projectRoot
  )
}

/** Persist one parsed file into SQLite and resolve import edges. */
export function persistIndexedFile(rec: IndexedFileRecord, _projectRoot: string): void {
  const d = getDb()
  const relPath = rec.relPath.split(path.sep).join('/')
  d.prepare('DELETE FROM files WHERE path = ?').run(relPath)
  const info = d
    .prepare('INSERT INTO files (path, language, size, mtime, content_hash) VALUES (?, ?, ?, ?, ?)')
    .run(relPath, rec.language, rec.size, rec.mtime, rec.contentHash)
  const fileId = Number(info.lastInsertRowid)

  const insSym = d.prepare(
    'INSERT INTO symbols (file_id, name, kind, start_line, end_line, parent_symbol) VALUES (?, ?, ?, ?, ?, ?)'
  )
  for (const s of rec.symbols) {
    insSym.run(fileId, s.name, s.kind, s.startLine, s.endLine, s.parent ?? null)
  }

  const insImp = d.prepare(
    'INSERT INTO imports (source_file_id, raw_target, resolved_file_id) VALUES (?, ?, NULL)'
  )
  for (const im of rec.imports) {
    insImp.run(fileId, im.rawTarget)
  }

  const insChunk = d.prepare(
    'INSERT INTO code_chunks (file_id, start_line, end_line, symbol_name, kind, content_hash) VALUES (?, ?, ?, ?, ?, ?)'
  )
  for (const c of rec.chunks) {
    insChunk.run(fileId, c.startLine, c.endLine, c.symbolName ?? null, c.kind, '')
  }

  resolveImportEdges(d, fileId, _projectRoot, relPath)
}

/** Resolve raw import targets against the file index (best-effort, deterministic). */
export function resolveImportEdges(
  d: import('better-sqlite3').Database,
  sourceFileId: number,
  _projectRoot: string,
  sourceRel: string
): void {
  const rows = d.prepare('SELECT id, path FROM files').all() as { id: number; path: string }[]
  const pathSet = new Set(rows.map((r) => r.path))
  const idByPath = new Map(rows.map((r) => [r.path, r.id]))
  const impRows = d
    .prepare('SELECT id, raw_target FROM imports WHERE source_file_id = ?')
    .all(sourceFileId) as { id: number; raw_target: string }[]

  const extCandidates = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '/index.ts', '/index.js', '/index.tsx']

  for (const row of impRows) {
    const raw = row.raw_target
    let candidates: string[] = []
    if (raw.startsWith('.') || raw.startsWith('/')) {
      const baseDir = path.posix.dirname(sourceRel)
      candidates = [path.posix.normalize(path.posix.join(baseDir, raw))]
    } else if (raw.startsWith('@/') || raw.startsWith('~/')) {
      for (const prefix of ['src/', 'app/', 'lib/', '']) {
        candidates.push(path.posix.normalize(prefix + raw.replace(/^[@~]\//, '')))
      }
    } else {
      continue
    }
    let resolved: string | null = null
    for (const cand of candidates) {
      if (pathSet.has(cand)) {
        resolved = cand
        break
      }
    }
    if (!resolved) {
      for (const cand of candidates) {
        for (const ext of extCandidates) {
          const withExt = cand.endsWith(ext) ? cand : cand + ext
          if (pathSet.has(withExt)) {
            resolved = withExt
            break
          }
        }
        if (resolved) break
      }
    }
    if (resolved) {
      const id = idByPath.get(resolved)
      if (id !== undefined) {
        d.prepare('UPDATE imports SET resolved_file_id = ? WHERE id = ?').run(id, row.id)
      }
    }
  }
}

/** Re-resolve import edges for every file after the full tree is present. */
export function resolveAllImportEdges(): void {
  const d = getDb()
  const files = d.prepare('SELECT id, path FROM files').all() as { id: number; path: string }[]
  const root = projectRootOf()
  if (!root) return
  for (const f of files) {
    resolveImportEdges(d, f.id, root, f.path)
  }
}

let currentProjectRoot: string | null = null
export function setProjectRootForIndex(root: string | null): void {
  currentProjectRoot = root
}
function projectRootOf(): string | null {
  return currentProjectRoot
}

/** Full project index pass. Returns counts. */
export async function indexProject(projectRoot: string): Promise<{ count: number; errors: number }> {
  let count = 0
  let errors = 0
  const seen = new Set<string>()
  const walk = async (absDir: string, relDir: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (isIgnored(rel)) continue
        await walk(path.join(absDir, e.name), rel)
      } else if (e.isFile()) {
        const absFile = path.join(absDir, e.name)
        const rel = relDir ? `${relDir}/${e.name}` : e.name
        seen.add(rel)
        count++
        try {
          await indexFile(absFile, projectRoot)
        } catch {
          errors++
        }
      }
    }
  }
  await walk(projectRoot, '')
  const d = getDb()
  const rows = d.prepare('SELECT path FROM files').all() as { path: string }[]
  for (const row of rows) {
    if (!seen.has(row.path)) d.prepare('DELETE FROM files WHERE path = ?').run(row.path)
  }
  resolveAllImportEdges()
  return { count, errors }
}

/** Re-index a single changed/added file (incremental update). */
export async function reindexPath(absPath: string, projectRoot: string): Promise<void> {
  const rel = path.relative(projectRoot, absPath).split(path.sep).join('/')
  if (isIgnored(rel)) return
  try {
    const st = await fs.stat(absPath)
    if (st.isDirectory()) return
    await indexFile(absPath, projectRoot)
  } catch {
    // file removed — drop from index
    const d = getDb()
    d.prepare('DELETE FROM files WHERE path = ?').run(rel)
  }
}