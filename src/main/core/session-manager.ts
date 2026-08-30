import { randomUUID } from 'crypto'
import { SessionEventType, SessionRecord, SessionEventRecord } from '../../shared/types'
import {
  insertSession,
  endSession,
  insertSessionEvent,
  listSessions,
  getSessionEvents,
  getDb
} from '../persistence/database'
import { getProjectRoot } from '../project'

/**
 * Actual editor sessions: recorded deterministic events (opened files, edits,
 * accepted/rejected AI changes). AI only summarizes what is recorded here —
 * history is never invented from nothing.
 */

const IDLE_MS = 30 * 60 * 1000 // 30 min of inactivity ends a session

let currentSessionId: string | null = null
let lastActivity = Date.now()
let idleTimer: NodeJS.Timeout | null = null

export function startSession(projectRoot: string): string {
  if (currentSessionId) {
    recordEvent('session_started' as SessionEventType)
    return currentSessionId
  }
  const id = randomUUID()
  insertSession(id, projectRoot, Date.now())
  currentSessionId = id
  lastActivity = Date.now()
  armIdleTimer()
  recordEvent('session_started' as SessionEventType)
  return id
}

export function stopSession(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  if (currentSessionId) {
    endSession(currentSessionId, Date.now())
    currentSessionId = null
  }
}

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (currentSessionId && Date.now() - lastActivity > IDLE_MS) {
      endSession(currentSessionId, Date.now())
      currentSessionId = null
    }
  }, IDLE_MS + 1000)
}

export function recordEvent(type: SessionEventType, path?: string, detail?: string): void {
  lastActivity = Date.now()
  const sid = currentSessionId
  if (!sid) {
    const root = getProjectRoot()
    if (root) startSession(root)
    else return
    insertSessionEvent(currentSessionId!, Date.now(), type, path, detail)
    armIdleTimer()
    return
  }
  insertSessionEvent(sid, Date.now(), type, path, detail)
}

export function getCurrentSessionId(): string | null {
  return currentSessionId
}

export function listRecentSessions(limit = 12): SessionRecord[] {
  return listSessions(limit).map((s) => ({
    id: s.id,
    projectRoot: s.projectRoot,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    summary: s.summaryJson ? JSON.parse(s.summaryJson) : undefined,
    eventCount: s.eventCount
  }))
}

export function eventsForSession(sessionId: string, limit = 200): SessionEventRecord[] {
  return getSessionEvents(sessionId, limit).map((e) => ({
    id: e.id,
    sessionId,
    ts: e.ts,
    type: e.type as SessionEventType,
    path: e.path,
    detail: e.detail
  }))
}

export function saveSessionSummary(sessionId: string, summaryJson: string): void {
  endSession(sessionId, Date.now(), summaryJson)
}

/** Recent event text, one line per event — deterministic input for AI summaries. */
export function renderEventsForSummary(sessionId: string, limit = 120): string {
  const events = getSessionEvents(sessionId, limit)
  const lines = events
    .reverse()
    .map((e) => {
      const t = new Date(e.ts).toLocaleString()
      const loc = [e.type.replace(/_/g, ' '), e.path ? `@ ${e.path}` : '', e.detail ? `— ${e.detail}` : '']
        .filter(Boolean)
        .join(' ')
      return `[${t}] ${loc}`
    })
  return lines.join('\n')
}

export function getDbHandle(): unknown {
  return getDb()
}