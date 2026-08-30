import { promises as fs } from 'fs'
import path from 'path'
import { getProjectRoot, resolveInProject } from '../project'
import { isIgnored } from '../../shared/utils'
import { getImports, getReferences, getSymbols, allFilePaths } from './retrieval'
import { splitLines } from '../../shared/utils'

/**
 * Read-only deterministic tools for the codebase-exploration loop.
 * No write operations and no shell execution are exposed here.
 */

export async function listDirectorySafe(relPath: string): Promise<{ name: string; isDir: boolean }[]> {
  const root = getProjectRoot()
  if (!root) return []
  const abs = await resolveInProject(relPath || '.')
  if (!abs) return []
  try {
    const entries = await fs.readdir(abs, { withFileTypes: true })
    return entries
      .filter((e) => !isIgnored(`${relPath}/${e.name}`))
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  } catch {
    return []
  }
}

export async function readFileSafe(relPath: string, maxChars = 30000): Promise<string | null> {
  const abs = await resolveInProject(relPath)
  if (!abs) return null
  try {
    const text = await fs.readFile(abs, 'utf-8')
    return text.length > maxChars ? text.slice(0, maxChars) + '\n// …(truncated)' : text
  } catch {
    return null
  }
}

export async function readLinesSafe(
  relPath: string,
  startLine: number,
  endLine: number
): Promise<string | null> {
  const abs = await resolveInProject(relPath)
  if (!abs) return null
  try {
    const text = await fs.readFile(abs, 'utf-8')
    const lines = splitLines(text)
    const s = Math.max(1, startLine)
    const e = Math.min(lines.length, Math.max(s, endLine))
    return lines.slice(s - 1, e).join('\n')
  } catch {
    return null
  }
}

/** Compact deterministic project structure (2 levels). */
export async function projectStructureText(): Promise<string> {
  const root = getProjectRoot()
  if (!root) return ''
  const { buildProjectManifest } = await import('../ai/context')
  const manifest = await buildProjectManifest()
  if (!manifest) return ''
  const lines: string[] = []
  lines.push(`ROOT: ${manifest.rootName}`)
  for (const s of manifest.structure.slice(0, 60)) lines.push(`  ${s}`)
  const files = allFilePaths()
  lines.push(`FILES (${files.length}):`)
  for (const f of files.slice(0, 120)) lines.push(`  ${f}`)
  return lines.join('\n')
}

export function toolBundle() {
  return { getImports, getReferences, getSymbols, listDirectorySafe, readFileSafe, readLinesSafe, projectStructureText }
}

void path