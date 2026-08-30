import * as pty from 'node-pty'
import { EventEmitter } from 'events'
import { shell } from 'electron'

/**
 * Bottom pane terminal: xterm.js in the renderer, node-pty here.
 * Hiding the pane must never kill the process — the manager outlives visibility.
 * Designed so multiple sessions/tabs can be added later (sessions map).
 */

interface TermSession {
  proc: pty.IPty
  cols: number
  rows: number
}

const emitter = new EventEmitter()

let sessions = new Map<string, TermSession>()
let activeId: string | null = null
let lastCols = 100
let lastRows = 30

function shellPath(): string {
  const env = shell ? process.env.SHELL : undefined
  return (
    env ??
    (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash')
  )
}

export function startTerminal(cols = lastCols, rows = lastRows, cwd?: string): { ok: boolean; error?: string } {
  try {
    const id = `term-${Date.now()}`
    const proc = pty.spawn(shellPath(), [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd ?? process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' },
      useConpty: process.platform === 'win32'
    })
    const session: TermSession = { proc, cols, rows }
    sessions.set(id, session)
    activeId = id
    lastCols = cols
    lastRows = rows

    proc.onData((data) => {
      emitter.emit('data', id, data)
    })
    proc.onExit(({ exitCode }) => {
      emitter.emit('exit', id, exitCode)
      sessions.delete(id)
      if (activeId === id) activeId = null
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function ensureTerminal(cwd?: string): { ok: boolean; error?: string } {
  if (activeId && sessions.has(activeId)) return { ok: true }
  return startTerminal(lastCols, lastRows, cwd)
}

export function writeToTerminal(data: string): void {
  if (activeId && sessions.has(activeId)) {
    sessions.get(activeId)!.proc.write(data)
  }
}

export function resizeTerminal(cols: number, rows: number): void {
  lastCols = cols
  lastRows = rows
  if (activeId && sessions.has(activeId)) {
    const s = sessions.get(activeId)!
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
}

export function isTerminalRunning(): boolean {
  return activeId !== null && sessions.has(activeId)
}

export function onTerminalData(cb: (id: string, data: string) => void): () => void {
  emitter.on('data', cb)
  return () => emitter.off('data', cb)
}

export function onTerminalExit(cb: (id: string, code: number) => void): () => void {
  emitter.on('exit', cb)
  return () => emitter.off('exit', cb)
}