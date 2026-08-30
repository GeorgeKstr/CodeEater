import { promises as fs } from 'fs'
import path from 'path'
import crypto from 'crypto'
import { app } from 'electron'
import {
  ProjectInfo,
  ProjectUiState,
  FsEvent,
  TreeNode,
  FileStat
} from '../shared/types'
import { isIgnored } from '../shared/utils'
import { EventEmitter } from 'events'

/**
 * Owns the currently open project: root resolution, tree building,
 * filesystem watching, persisted UI state, and simple file ops.
 *
 * The deterministic editor (this) is the authority on files and paths.
 * No AI code touches the filesystem directly.
 */

const emitter = new EventEmitter()
export const projectEvents = emitter

let currentRoot: string | null = null
let watcher: PollingWatcher | null = null
let uiState: ProjectUiState | null = null

function userDataDir(): string {
  return app.getPath('userData')
}

function projectStateDir(root: string): string {
  const hash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 16)
  return path.join(userDataDir(), 'projects', hash)
}

export function projectDbPath(root: string): string {
  return path.join(projectStateDir(root), 'index.db')
}

export function projectUiStatePath(root: string): string {
  return path.join(projectStateDir(root), 'ui-state.json')
}

function isValidRoot(root: string): boolean {
  return path.isAbsolute(root)
}

export function getProjectRoot(): string | null {
  return currentRoot
}

export async function openProject(root: string): Promise<ProjectInfo> {
  root = path.resolve(root)
  if (!isValidRoot(root)) throw new Error(`Invalid project root: ${root}`)
  const stat = await fs.stat(root)
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${root}`)

  await closeProject()

  currentRoot = root
  uiState = await loadUiState(root)
  watcher = new PollingWatcher(root, (ev) => emitter.emit('event', ev))
  watcher.start()
  await fs.mkdir(projectStateDir(root), { recursive: true })
  return { root, name: path.basename(root), openedAt: Date.now() }
}

export async function closeProject(): Promise<void> {
  if (watcher) {
    await watcher.stop()
    watcher = null
  }
  currentRoot = null
  uiState = null
}

export async function getProjectInfo(): Promise<ProjectInfo | null> {
  if (!currentRoot) return null
  return { root: currentRoot, name: path.basename(currentRoot), openedAt: Date.now() }
}

// ---------------------------------------------------------------------------
// UI state persistence
// ---------------------------------------------------------------------------

export async function loadUiState(root: string): Promise<ProjectUiState> {
  try {
    const raw = await fs.readFile(projectUiStatePath(root), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ProjectUiState>
    return {
      root,
      openTabs: Array.isArray(parsed.openTabs) ? parsed.openTabs : [],
      activeFile: parsed.activeFile,
      expandedDirs: Array.isArray(parsed.expandedDirs) ? parsed.expandedDirs : [],
      terminalVisible: !!parsed.terminalVisible
    }
  } catch {
    return { root, openTabs: [], expandedDirs: [], terminalVisible: false }
  }
}

export async function saveUiState(state: Partial<ProjectUiState>): Promise<void> {
  if (!currentRoot || !uiState) return
  uiState = { ...uiState, ...state, root: currentRoot }
  try {
    await fs.mkdir(path.dirname(projectUiStatePath(currentRoot)), { recursive: true })
    await fs.writeFile(projectUiStatePath(currentRoot), JSON.stringify(uiState, null, 2), 'utf-8')
  } catch (e) {
    console.error('failed to persist UI state', e)
  }
}

export function getUiState(): ProjectUiState | null {
  return uiState ? { ...uiState } : null
}

// ---------------------------------------------------------------------------
// Project tree
// ---------------------------------------------------------------------------

/** Build a virtualized-friendly flat-ordered tree; directories listed first. */
export async function buildTree(): Promise<TreeNode[]> {
  if (!currentRoot) return []
  const nodes = await readDirTree(currentRoot, '')
  nodes.sort(sortNodes)
  return nodes
}

function sortNodes(a: TreeNode, b: TreeNode): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

async function readDirTree(abs: string, rel: string): Promise<TreeNode[]> {
  let entries
  try {
    entries = await fs.readdir(abs, { withFileTypes: true })
  } catch {
    return []
  }
  const out: TreeNode[] = []
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (isIgnored(childRel)) continue
      const childAbs = path.join(abs, entry.name)
      const node: TreeNode = {
        name: entry.name,
        path: childAbs,
        relPath: childRel,
        isDir: true,
        expanded: uiState?.expandedDirs.includes(childRel),
        children: []
      }
      const children = await readDirTree(childAbs, childRel)
      if (children.length > 0) {
        children.sort(sortNodes)
        node.children = children
      }
      out.push(node)
    } else if (entry.isFile()) {
      out.push({
        name: entry.name,
        path: path.join(abs, entry.name),
        relPath: childRel,
        isDir: false
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// File ops (deterministic, path-safe)
// ---------------------------------------------------------------------------

/** Ensure a path stays within the project root (blocks ../ escapes). */
export async function resolveInProject(relOrAbs: string): Promise<string | null> {
  if (!currentRoot) return null
  const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.resolve(currentRoot, relOrAbs)
  const rel = path.relative(currentRoot, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  try {
    const realRoot = await fs.realpath(currentRoot)
    let realAbs: string
    try {
      realAbs = await fs.realpath(abs)
    } catch {
      // path may not exist yet (e.g. create) — resolve parent
      const parentReal = await fs.realpath(path.dirname(abs))
      realAbs = path.join(parentReal, path.basename(abs))
    }
    const relReal = path.relative(realRoot, realAbs)
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) return null
    return abs
  } catch {
    return null
  }
}

export async function readProjectFile(relPath: string): Promise<string> {
  const abs = await resolveInProject(relPath)
  if (!abs) throw new Error(`Path outside project: ${relPath}`)
  return fs.readFile(abs, 'utf-8')
}

export async function readProjectLines(relPath: string, startLine: number, endLine: number): Promise<string> {
  const abs = await resolveInProject(relPath)
  if (!abs) throw new Error(`Path outside project: ${relPath}`)
  const text = await fs.readFile(abs, 'utf-8')
  const lines = text.split(/\r?\n/)
  const s = Math.max(1, startLine)
  const e = Math.min(lines.length, endLine)
  if (s > e) return ''
  return lines.slice(s - 1, e).join('\n')
}

export async function statProjectFile(relPath: string): Promise<FileStat | null> {
  const abs = await resolveInProject(relPath)
  if (!abs) return null
  try {
    const st = await fs.stat(abs)
    return {
      path: abs,
      relPath: path.relative(currentRoot!, abs).split(path.sep).join('/'),
      size: st.size,
      mtime: st.mtimeMs,
      isDir: st.isDirectory()
    }
  } catch {
    return null
  }
}

export async function hashProjectFile(relPath: string): Promise<{ hash: string; mtime: number; size: number } | null> {
  const abs = await resolveInProject(relPath)
  if (!abs) return null
  try {
    const content = await fs.readFile(abs)
    const st = await fs.stat(abs)
    const hash = crypto.createHash('sha256').update(content).digest('hex')
    return { hash, mtime: st.mtimeMs, size: st.size }
  } catch {
    return null
  }
}

/** Write a file inside the project. Returns conflict info if hash mismatched. */
export async function writeProjectFile(
  relPath: string,
  content: string,
  expectedHash?: string
): Promise<{ ok: boolean; hash: string; conflict?: boolean }> {
  const abs = await resolveInProject(relPath)
  if (!abs) throw new Error(`Path outside project: ${relPath}`)
  if (expectedHash) {
    const current = await hashProjectFile(relPath)
    if (!current || current.hash !== expectedHash) {
      return { ok: false, hash: current?.hash ?? '', conflict: true }
    }
  }
  await fs.writeFile(abs, content, 'utf-8')
  const hash = crypto.createHash('sha256').update(content).digest('hex')
  emitter.emit('event', { type: 'change', path: abs } satisfies FsEvent)
  return { ok: true, hash }
}

export async function ensureDirForFile(relPath: string): Promise<void> {
  const abs = await resolveInProject(relPath)
  if (!abs) return
  await fs.mkdir(path.dirname(abs), { recursive: true })
}

export async function createProjectFile(relPath: string, content: string): Promise<void> {
  const abs = await resolveInProject(relPath)
  if (!abs) throw new Error(`Path outside project: ${relPath}`)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, 'utf-8')
  emitter.emit('event', { type: 'add', path: abs, isDir: false } satisfies FsEvent)
}

export async function deleteProjectFile(relPath: string): Promise<{ ok: boolean; error?: string }> {
  const abs = await resolveInProject(relPath)
  if (!abs) return { ok: false, error: `Path outside project: ${relPath}` }
  try {
    await fs.unlink(abs)
    emitter.emit('event', { type: 'unlink', path: abs, isDir: false } satisfies FsEvent)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Filesystem watcher
//
// fs.watch with { recursive: true } is only supported on macOS/Windows.
// For cross-platform reliability we use a lightweight poller: it walks the
// tree from the root, compares (mtime, size) signatures, and emits
// add/change/unlink events. A rapid fallback fs.watch on the root is also
// installed where the platform permits it; the poller remains authoritative.
// ---------------------------------------------------------------------------

interface FsEntry {
  mtime: number
  size: number
  isDir: boolean
}

export class PollingWatcher {
  private timer: NodeJS.Timeout | null = null
  private known = new Map<string, FsEntry>()
  private intervalMs = 1500
  private stopped = false

  constructor(
    private root: string,
    private onEvent: (e: FsEvent) => void
  ) {}

  start(): void {
    this.scan().then(() => {
      if (this.stopped) return
      this.timer = setInterval(() => void this.scan(), this.intervalMs)
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.known.clear()
  }

  private async scan(): Promise<void> {
    if (this.stopped) return
    const current = new Map<string, FsEntry>()
    try {
      await this.walk(this.root, '', current)
    } catch {
      return
    }
    const events: FsEvent[] = []
    for (const [rel, entry] of current) {
      const prev = this.known.get(rel)
      if (!prev) {
        events.push({ type: entry.isDir ? 'addDir' : 'add', path: this.absOf(rel), isDir: entry.isDir })
      } else if (!entry.isDir && (prev.mtime !== entry.mtime || prev.size !== entry.size)) {
        events.push({ type: 'change', path: this.absOf(rel) })
      }
    }
    for (const [rel, prev] of this.known) {
      if (!current.has(rel)) {
        events.push({ type: 'unlink', path: this.absOf(rel), isDir: prev.isDir })
      }
    }
    this.known = current
    if (events.length && !this.stopped) {
      const batch = new Set<string>()
      for (const ev of events) {
        const key = `${ev.type}:${ev.path}`
        if (batch.has(key)) continue
        batch.add(key)
        this.onEvent(ev)
      }
    }
  }

  private absOf(rel: string): string {
    return path.join(this.root, rel.split('/').join(path.sep))
  }

  private async walk(absDir: string, relDir: string, out: Map<string, FsEntry>): Promise<void> {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (isIgnored(rel)) continue
        out.set(rel, { mtime: 0, size: 0, isDir: true })
        await this.walk(path.join(absDir, entry.name), rel, out)
      } else if (entry.isFile()) {
        try {
          const st = await fs.stat(path.join(absDir, entry.name))
          out.set(rel, { mtime: st.mtimeMs, size: st.size, isDir: false })
        } catch {
          /* file vanished mid-scan */
        }
      }
    }
  }
}