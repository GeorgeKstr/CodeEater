import { spawn } from 'child_process'
import { rgPath } from '@vscode/ripgrep'
import { TextSearchOptions, TextSearchResult } from '../../shared/types'
import { DEFAULT_IGNORED_DIRS } from '../../shared/utils'

/**
 * Deterministic text search through ripgrep.
 * Never involves AI. Returns the exact byte positions of matches.
 */

interface RgMatchLine {
  type: 'match' | 'begin' | 'end' | 'summary'
  data: {
    path?: { text: string }
    lines?: { text: string }
    line_number?: number
    submatches?: { start: number; end: number; match: { text: string } }[]
  }
}

export async function textSearch(projectRoot: string, opts: TextSearchOptions): Promise<TextSearchResult[]> {
  const query = opts.query
  if (!query) return []
  const args: string[] = []
  args.push('-n', '--no-heading', '--json', '-I', '--hidden')
  for (const dir of DEFAULT_IGNORED_DIRS) {
    args.push('-g', `!${dir}/**`, '-g', `!**/${dir}/**`)
  }
  if (opts.includePaths?.length) {
    for (const p of opts.includePaths) {
      args.push('-g', p)
    }
  }
  if (opts.caseSensitive) args.push('--case-sensitive')
  else args.push('--smart-case')
  if (opts.wordMatch) args.push('--word-regexp')
  args.push('--')
  args.push(query, projectRoot)

  const maxResults = opts.maxResults ?? 200
  const results: TextSearchResult[] = []

  await new Promise<void>((resolve) => {
    let child: ReturnType<typeof spawn> | null = null
    try {
      child = spawn(rgPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      console.error('ripgrep spawn failed', e)
      resolve()
      return
    }
    let buffer = ''
    const finish = () => {
      try {
        child?.kill()
      } catch {
        /* ignore */
      }
      resolve()
    }
    const timer = setTimeout(finish, 15000) // hard timeout guard
    const stdout = child.stdout
    const stderr = child.stderr
    if (!stdout || !stderr) {
      finish()
      return
    }
    stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as RgMatchLine
          if (parsed.type !== 'match' || !parsed.data.path?.text) continue
          const rel = parsed.data.path.text.replace(projectRoot + '/', '')
          const lineText = (parsed.data.lines?.text ?? '').replace(/\r?\n$/, '')
          const lineNo = parsed.data.line_number ?? 0
          for (const sub of parsed.data.submatches ?? []) {
            results.push({
              path: parsed.data.path.text,
              relPath: rel,
              line: lineNo,
              lineText,
              matchStart: sub.start,
              matchEnd: sub.end
            })
            if (results.length >= maxResults) {
              clearTimeout(timer)
              finish()
              return
            }
          }
        } catch {
          /* skip malformed lines */
        }
      }
    })
    stderr.on('data', () => {
      /* ignore */
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish()
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  return results
}

/** rga — rg availability check used by the AI adapter too. */
export function rgAvailable(): string | null {
  try {
    return rgPath
  } catch {
    return null
  }
}