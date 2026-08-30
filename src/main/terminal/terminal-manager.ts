import * as pty from 'node-pty'
import { EventEmitter } from 'events'
import { shell } from 'electron'
import path from 'path'
import type { TerminalSessionInfo } from '../../shared/types'

/**
 * Bottom pane terminal: xterm.js in the renderer, node-pty here.
 * Each tab is a separate pty session; hiding the pane never kills processes.
 * The renderer drives everything by session id (create/close/activate/write/resize).
 */

interface TermSession {
  id: string
  proc: pty.IPty
  cols: number
  rows: number
  title: string
  startedAt: number
  alive: boolean
}

const emitter = new EventEmitter()

const sessions = new Map<string, TermSession>()
let activeId: string | null = null
let lastCols = 100
let lastRows = 30
let seq = 0

function shellPath(): string {
  const env = shell ? process.env.SHELL : undefined
  return env ?? (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash')
}

function shellName(): string {
  return path.basename(shellPath()).replace(/\.exe$/i, '')
}

/** Spawn a fresh session and return its id. */
export function createTerminal(cwd?: string, cols = lastCols, rows = lastRows): { ok: boolean; id?: string; error?: string } {
  try {
    seq += 1
    const id = `term-${Date.now()}-${seq}`
    const proc = pty.spawn(shellPath(), [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd ?? process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' },
      useConpty: process.platform === 'win32'
    })
    const session: TermSession = {
      id,
      proc,
      cols,
      rows,
      title: seq === 1 ? shellName() : `${shellName()} ${seq}`,
      startedAt: Date.now(),
      alive: true
    }
    sessions.set(id, session)
    activeId = id
    lastCols = cols
    lastRows = rows

    proc.onData((data) => {
      emitter.emit('data', id, data)
    })
    proc.onExit(({ exitCode }) => {
      const s = sessions.get(id)
      if (s) s.alive = false
      emitter.emit('exit', id, exitCode)
      if (activeId === id) activeId = null
      emitter.emit('changed')
    })
    emitter.emit('changed')
    return { ok: true, id }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** Back-compat: make sure at least one session exists. */
export function ensureTerminal(cwd?: string): { ok: boolean; error?: string } {
  if (sessions.size > 0) return { ok: true }
  const res = createTerminal(cwd)
  return { ok: res.ok, error: res.error }
}

export function listTerminals(): TerminalSessionInfo[] {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    title: s.title,
    alive: s.alive,
    startedAt: s.startedAt
  }))
}

export function closeTerminal(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  try {
    s.proc.kill()
  } catch {
    /* ignore */
  }
  sessions.delete(id)
  if (activeId === id) {
    const remaining = [...sessions.values()]
    activeId = remaining.length ? remaining[remaining.length - 1].id : null
  }
  emitter.emit('changed')
}

export function activateTerminal(id: string): void {
  if (sessions.has(id)) {
    activeId = id
    lastCols = sessions.get(id)!.cols
    lastRows = sessions.get(id)!.rows
  }
}

export function writeToTerminal(data: string): void
export function writeToTerminal(id: string, data: string): void
export function writeToTerminal(a: string, b?: string): void {
  const id = b === undefined ? (activeId ?? '') : a
  const data = b === undefined ? a : b
  const s = sessions.get(id)
  if (s && s.alive) s.proc.write(data)
}

export function resizeTerminal(cols: number, rows: number): void
export function resizeTerminal(id: string, cols: number, rows: number): void
export function resizeTerminal(a: string | number, b: number, c?: number): void {
  let id: string
  let cols: number
  let rows: number
  if (typeof a === 'string') {
    id = a
    cols = b
    rows = c ?? b
  } else {
    id = activeId ?? ''
    cols = a
    rows = b
  }
  lastCols = cols
  lastRows = rows
  const s = sessions.get(id)
  if (!s || !s.alive) return
  if (s.cols !== cols || s.rows !== rows) {
    try {
      s.proc.resize(cols, rows)
      s.cols = cols
      s.rows = rows
    } catch {
      /* ignore */
    }
  }
}

export function killTerminal(): void {
  for (const [, s] of sessions) {
    try {
      s.proc.kill()
    } catch {
      /* ignore */
    }
  }
  sessions.clear()
  activeId = null
  emitter.emit('changed')
}

export function isTerminalRunning(): boolean {
  return sessions.size > 0
}

export function onTerminalData(cb: (id: string, data: string) => void): () => void {
  emitter.on('data', cb)
  return () => emitter.off('data', cb)
}

export function onTerminalExit(cb: (id: string, code: number) => void): () => void {
  emitter.on('exit', cb)
  return () => emitter.off('exit', cb)
}

/** Fires whenever the set of sessions changes (created / closed / exited). */
export function onTerminalChanged(cb: () => void): () => void {
  emitter.on('changed', cb)
  return () => emitter.off('changed', cb)
}