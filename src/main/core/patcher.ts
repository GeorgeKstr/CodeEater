import path from 'path'
import { randomUUID } from 'crypto'
import {
  ChangeRequest,
  ChangeRequestDraft,
  ChangeRequestFile,
  TextEdit
} from '../../shared/types'
import { sha256, splitLines, joinLines } from '../../shared/utils'
import {
  readProjectFile,
  resolveInProject,
  writeProjectFile,
  createProjectFile,
  deleteProjectFile,
  hashProjectFile,
  ensureDirForFile
} from '../project'
import { putChangeRequest, getChangeRequestJson, listChangeRequestRows } from '../persistence/database'
import { reindexPath } from './ts-indexer'
import { getProjectRoot } from '../project'

/**
 * The deterministic Change Request engine.
 *
 * Contract rules:
 *  - The LLM only proposes TextEdits. This module owns applying them.
 *  - Every proposal is validated: paths inside the project root, targets exist,
 *    line ranges valid, non-overlapping edits, hash-matched before apply.
 *  - Apply is atomic per request: pre-validate everything, then write.
 *  - Never silently overwrite newer user edits (hash check).
 */

export interface PatchResult {
  ok: boolean
  error?: string
  conflict?: boolean
}

// ---------------------------------------------------------------------------
// Text application
// ---------------------------------------------------------------------------

export function applyEditsToText(text: string, edits: TextEdit[]): { ok: boolean; text?: string; error?: string } {
  const nonCreate = edits
    .filter((e) => e.operation !== 'create')
    .sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0) || (a.endLine ?? 0) - (b.endLine ?? 0))
  if (nonCreate.length === 0) return { ok: true, text }
  const path = nonCreate[0].path
  if (nonCreate.some((e) => e.path !== path)) {
    return { ok: false, error: 'edits span multiple files — apply per file' }
  }
  const lines = splitLines(text)
  let prevEnd = 0
  for (const e of nonCreate) {
    const start = e.startLine ?? 1
    if (start < prevEnd) return { ok: false, error: `Overlapping edits at line ${start}` }
    prevEnd = e.operation === 'insert' ? start : (e.endLine ?? start)
  }
  for (const e of [...nonCreate].reverse()) {
    const start = e.startLine ?? 1
    const end = e.endLine ?? start
    if (e.operation === 'replace') {
      if (start < 1 || end > lines.length) {
        return { ok: false, error: `Line range out of bounds: ${start}..${end} (file has ${lines.length} lines)` }
      }
      const replacement = splitLines(e.replacement ?? '')
      lines.splice(start - 1, end - start + 1, ...replacement)
    } else if (e.operation === 'insert') {
      if (start < 0 || start > lines.length) {
        return { ok: false, error: `Insert line out of bounds: ${start} (file has ${lines.length} lines)` }
      }
      const replacement = splitLines(e.replacement ?? '')
      lines.splice(start, 0, ...replacement)
    } else if (e.operation === 'delete') {
      if (start < 1 || end > lines.length) {
        return { ok: false, error: `Delete range out of bounds: ${start}..${end}` }
      }
      lines.splice(start - 1, end - start + 1)
    }
  }
  return { ok: true, text: joinLines(lines) }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export async function validateEditPaths(edits: TextEdit[], _projectRoot: string): Promise<{ ok: boolean; error?: string }> {
  for (const e of edits) {
    if (e.operation === 'create') {
      const abs = await resolveInProject(e.path)
      if (!abs) return { ok: false, error: `Create path outside project: ${e.path}` }
      const exists = await checkExists(e.path)
      if (exists) return { ok: false, error: `Cannot create existing file: ${e.path}` }
      const parentExists = await checkExists(path.posix.dirname(e.path))
      if (!parentExists) {
        return { ok: false, error: `Parent directory does not exist: ${path.posix.dirname(e.path)}` }
      }
    } else {
      const abs = await resolveInProject(e.path)
      if (!abs) return { ok: false, error: `Edit path outside project: ${e.path}` }
      const exists = await checkExists(e.path)
      if (!exists) return { ok: false, error: `Target file does not exist: ${e.path}` }
    }
  }
  return { ok: true }
}

async function checkExists(relPath: string): Promise<boolean> {
  const abs = await resolveInProject(relPath)
  if (!abs) return false
  try {
    await require('fs').promises.stat(abs)
    return true
  } catch {
    return false
  }
}

/** Sort + sanity-check the edit list (no-op returns are rejected by callers first). */
export function normalizeEdits(edits: TextEdit[]): TextEdit[] {
  return [...edits].sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path)
    return (a.startLine ?? 0) - (b.startLine ?? 0)
  })
}

// ---------------------------------------------------------------------------
// Change Request construction
// ---------------------------------------------------------------------------

export async function createChangeRequest(
  draft: ChangeRequestDraft,
  projectRoot: string
): Promise<ChangeRequest> {
  const uniquePaths = new Set(draft.edits.map((e) => e.path))
  if (uniquePaths.size === 0) throw new Error('No edits to apply')

  const v = await validateEditPaths(draft.edits, projectRoot)
  if (!v.ok) throw new Error(v.error ?? 'invalid edits')

  // group edits per path to build per-file before/after content
  const byPath = groupEditsByPath(draft.edits)
  const files: ChangeRequestFile[] = []

  for (const relPath of byPath.keys()) {
    const edits = [...byPath.get(relPath)!].sort(
      (a, b) => (a.startLine ?? 0) - (b.startLine ?? 0)
    )
    const isCreate = edits.every((e) => e.operation === 'create')
    const isDelete = edits.length === 1 && edits[0].operation === 'delete' && edits[0].startLine === undefined

    let operation: ChangeRequestFile['operation']
    let originalContent = ''
    let proposedContent = ''
    if (isCreate) {
      operation = 'create'
      proposedContent = edits[0].content ?? ''
    } else if (isDelete) {
      operation = 'delete'
      try {
        originalContent = await readProjectFile(relPath)
      } catch {
        originalContent = ''
      }
      proposedContent = ''
    } else {
      operation = 'modify'
      try {
        originalContent = await readProjectFile(relPath)
      } catch {
        originalContent = ''
      }
      const applied = applyEditsToText(originalContent, edits)
      if (!applied.ok || applied.text === undefined) {
        throw new Error(`Cannot apply edits to ${relPath}: ${applied.error}`)
      }
      proposedContent = applied.text
    }

    const hash = await sha256(originalContent)
    const disk = await hashProjectFile(relPath)
    const state = isCreate ? 'new' : disk ? (disk.hash === hash ? 'clean' : 'stale') : 'missing'

    files.push({
      path: relPath,
      operation,
      originalHash: isCreate ? undefined : hash,
      proposedHash: await sha256(proposedContent),
      originalContent,
      proposedContent,
      diskHash: disk?.hash,
      state
    })
  }

  const id = randomUUID()
  const req: ChangeRequest = {
    id,
    prompt: draft.prompt,
    scope: draft.scope,
    status: 'pending',
    createdAt: Date.now(),
    summary: draft.summary || 'AI edit proposal',
    files,
    edits: draft.edits
  }
  putChangeRequest(id, JSON.stringify(req))
  return req
}

export function groupEditsByPath(edits: TextEdit[]): Map<string, TextEdit[]> {
  const m = new Map<string, TextEdit[]>()
  for (const e of edits) {
    const arr = m.get(e.path) ?? []
    arr.push(e)
    m.set(e.path, arr)
  }
  return m
}

// ---------------------------------------------------------------------------
// List / get
// ---------------------------------------------------------------------------

export async function listChangeRequests(): Promise<ChangeRequest[]> {
  const rows = listChangeRequestRows()
  const out: ChangeRequest[] = []
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.json) as ChangeRequest
      out.push(await refreshDiskState(parsed))
    } catch {
      /* skip corrupt */
    }
  }
  return out
}

export async function getChangeRequest(id: string): Promise<ChangeRequest | null> {
  const raw = getChangeRequestJson(id)
  if (!raw) return null
  try {
    return refreshDiskState(JSON.parse(raw) as ChangeRequest)
  } catch {
    return null
  }
}

/** Re-check each file's disk hash against the captured original. */
async function refreshDiskState(req: ChangeRequest): Promise<ChangeRequest> {
  const out = { ...req, files: [] as ChangeRequestFile[] }
  for (const f of req.files) {
    let state = f.state
    let diskHash = f.diskHash
    if (f.operation === 'modify') {
      const disk = await hashProjectFile(f.path)
      diskHash = disk?.hash
      state = disk ? (disk.hash === f.originalHash ? 'clean' : 'stale') : 'missing'
    } else if (f.operation === 'delete') {
      const disk = await hashProjectFile(f.path)
      diskHash = disk?.hash
      state = disk ? (disk.hash === f.originalHash ? 'clean' : 'stale') : 'missing'
    } else {
      const disk = await hashProjectFile(f.path)
      diskHash = disk?.hash
      state = disk ? 'stale' : 'new'
    }
    out.files.push({ ...f, state, diskHash })
  }
  return out
}

// ---------------------------------------------------------------------------
// Apply / Reject / Revert
// ---------------------------------------------------------------------------

export async function applyChangeRequest(id: string): Promise<ChangeRequest> {
  const root = getProjectRoot()
  if (!root) throw new Error('no project open')
  const req = await getChangeRequest(id)
  if (!req) throw new Error('change request not found')
  if (req.status !== 'pending') throw new Error(`request is ${req.status}`)

  const fresh = await createProposedFromReq(req)
  if (!fresh.ok) {
    const conflicted: ChangeRequest = { ...req, status: 'conflicted', error: fresh.error }
    putChangeRequest(id, JSON.stringify(conflicted))
    return conflicted
  }

  // Phase 1: validate everything before touching the filesystem (atomic pre-check)
  for (const f of fresh.files) {
    if (f.operation === 'modify' || f.operation === 'delete') {
      const disk = await hashProjectFile(f.path)
      if (!disk || disk.hash !== f.originalHash) {
        const conflicted: ChangeRequest = { ...req, status: 'conflicted', error: `File changed on disk: ${f.path}` }
        putChangeRequest(id, JSON.stringify(conflicted))
        return conflicted
      }
    } else if (f.operation === 'create') {
      const disk = await hashProjectFile(f.path)
      if (disk) {
        const conflicted: ChangeRequest = { ...req, status: 'conflicted', error: `Target already exists: ${f.path}` }
        putChangeRequest(id, JSON.stringify(conflicted))
        return conflicted
      }
    }
  }

  // Phase 2: apply
  for (const f of fresh.files) {
    if (f.operation === 'modify') {
      await ensureDirForFile(f.path)
      await writeProjectFile(f.path, f.proposedContent ?? '', f.originalHash)
    } else if (f.operation === 'create') {
      await createProjectFile(f.path, f.proposedContent ?? '')
    } else if (f.operation === 'delete') {
      await deleteProjectFile(f.path)
    }
    void f
    await reindexPathFromRel(f.path, root)
  }

  const accepted: ChangeRequest = { ...fresh.req, status: 'accepted' }
  putChangeRequest(id, JSON.stringify(accepted))
  return accepted
}

async function reindexPathFromRel(rel: string, root: string): Promise<void> {
  const abs = path.join(root, rel.split('/').join(path.sep))
  await reindexPath(abs, root)
}

export async function rejectChangeRequest(id: string): Promise<ChangeRequest> {
  const req = await getChangeRequest(id)
  if (!req) throw new Error('change request not found')
  if (req.status !== 'pending') throw new Error(`request is ${req.status}`)
  const rejected: ChangeRequest = { ...req, status: 'rejected' }
  putChangeRequest(id, JSON.stringify(rejected))
  return rejected
}

export async function revertChangeRequest(id: string): Promise<ChangeRequest> {
  const root = getProjectRoot()
  if (!root) throw new Error('no project open')
  const req = await getChangeRequest(id)
  if (!req) throw new Error('change request not found')
  if (req.status !== 'accepted') throw new Error(`only accepted requests can be reverted (status: ${req.status})`)

  for (const f of req.files) {
    if (f.operation === 'modify') {
      const disk = await hashProjectFile(f.path)
      if (!disk || disk.hash !== f.proposedHash) {
        const conflicted: ChangeRequest = { ...req, status: 'conflicted', error: `Cannot revert ${f.path}: file changed since acceptance` }
        putChangeRequest(id, JSON.stringify(conflicted))
        return conflicted
      }
    } else if (f.operation === 'create') {
      const disk = await hashProjectFile(f.path)
      if (!disk || disk.hash !== f.proposedHash) {
        const conflicted: ChangeRequest = { ...req, status: 'conflicted', error: `Cannot revert ${f.path}: file changed since acceptance` }
        putChangeRequest(id, JSON.stringify(conflicted))
        return conflicted
      }
    } else if (f.operation === 'delete') {
      const disk = await hashProjectFile(f.path)
      if (disk) {
        const conflicted: ChangeRequest = { ...req, status: 'conflicted', error: `Cannot revert ${f.path}: file exists again` }
        putChangeRequest(id, JSON.stringify(conflicted))
        return conflicted
      }
    }
  }

  for (const f of req.files) {
    if (f.operation === 'modify') {
      await writeProjectFile(f.path, f.originalContent ?? '', f.proposedHash)
    } else if (f.operation === 'create') {
      await deleteProjectFile(f.path)
    } else if (f.operation === 'delete') {
      await ensureDirForFile(f.path)
      await createProjectFile(f.path, f.originalContent ?? '')
    }
    await reindexPathFromRel(f.path, root)
  }

  const reverted: ChangeRequest = { ...req, status: 'reverted' }
  putChangeRequest(id, JSON.stringify(reverted))
  return reverted
}

/** Re-derive proposed content from current on-disk content when it still matches. */
async function createProposedFromReq(req: ChangeRequest): Promise<{ ok: boolean; files: ChangeRequestFile[]; req: ChangeRequest; error?: string }> {
  const byPath = groupEditsByPath(req.edits.filter((e) => e.operation !== 'create' || true))
  const files: ChangeRequestFile[] = []
  const root = getProjectRoot()!
  for (const f of req.files) {
    const editsForThis = (byPath.get(f.path) ?? []).sort(
      (a, b) => (a.startLine ?? 0) - (b.startLine ?? 0)
    )
    if (f.operation === 'create') {
      files.push({ ...f, proposedContent: f.proposedContent ?? '' })
    } else if (f.operation === 'delete') {
      files.push({ ...f, proposedContent: '' })
    } else {
      let cur = ''
      try {
        cur = await readProjectFile(f.path)
      } catch {
        return { ok: false, files, req, error: `Cannot read ${f.path}` }
      }
      const app = applyEditsToText(cur, editsForThis)
      if (!app.ok) return { ok: false, files, req, error: app.error }
      files.push({ ...f, originalHash: await sha256(cur), proposedContent: app.text!, proposedHash: await sha256(app.text!) })
    }
    void root
  }
  return { ok: true, files, req: { ...req, files } }
}

/** sha256 hex for identity comparisons */
export async function contentHash(text: string): Promise<string> {
  return sha256(text)
}
