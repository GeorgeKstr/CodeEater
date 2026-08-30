import Database from 'better-sqlite3'
import path from 'path'
import { projectDbPath } from '../project'

/**
 * SQLite persistence for the deterministic project index and AI artifacts.
 * One database file per project, stored under userData.
 */

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db
  throw new Error('database not open')
}

export function isOpen(): boolean {
  return db !== null
}

export function openDatabase(root: string): void {
  closeDatabase()
  const file = projectDbPath(root)
  const dir = path.dirname(file)
  require('fs').mkdirSync(dir, { recursive: true })
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  migrate(db)
}

export function closeDatabase(): void {
  if (db) {
    try {
      db.close()
    } catch {
      /* ignore */
    }
    db = null
  }
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      language TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      mtime REAL NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      parent_symbol TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);

    CREATE TABLE IF NOT EXISTS imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      raw_target TEXT NOT NULL,
      resolved_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_imports_source ON imports(source_file_id);
    CREATE INDEX IF NOT EXISTS idx_imports_resolved ON imports(resolved_file_id);

    CREATE TABLE IF NOT EXISTS code_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      symbol_name TEXT,
      kind TEXT NOT NULL DEFAULT 'top',
      content_hash TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON code_chunks(file_id);

    CREATE TABLE IF NOT EXISTS ai_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      file_path TEXT NOT NULL DEFAULT '',
      input_hash TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      prompt_version INTEGER NOT NULL DEFAULT 1,
      result_json TEXT NOT NULL,
      generated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_key
      ON ai_artifacts(kind, file_path, input_hash, model, prompt_version);

    CREATE TABLE IF NOT EXISTS change_requests (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_root TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      summary_json TEXT
    );

    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      path TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sess_events ON session_events(session_id, ts);
  `)
}

// ---------------------------------------------------------------------------
// AI artifact cache
// ---------------------------------------------------------------------------

export interface ArtifactRecord {
  kind: string
  filePath: string
  inputHash: string
  model: string
  promptVersion: number
  resultJson: string
  generatedAt: number
}

export function putArtifact(rec: ArtifactRecord): void {
  const d = getDb()
  d.prepare(
    `INSERT INTO ai_artifacts (kind, file_path, input_hash, model, prompt_version, result_json, generated_at)
     VALUES (@kind, @filePath, @inputHash, @model, @promptVersion, @resultJson, @generatedAt)
     ON CONFLICT(kind, file_path, input_hash, model, prompt_version)
     DO UPDATE SET result_json = excluded.result_json, generated_at = excluded.generated_at`
  ).run(rec)
}

/** Map a SQLite artifact row (snake_case) to the camelCase record shape. */
function mapArtifactRow(row: Record<string, unknown>): ArtifactRecord {
  return {
    kind: String(row.kind ?? ''),
    filePath: String(row.file_path ?? ''),
    inputHash: String(row.input_hash ?? ''),
    model: String(row.model ?? ''),
    promptVersion: Number(row.prompt_version ?? 0),
    resultJson: String(row.result_json ?? ''),
    generatedAt: Number(row.generated_at ?? 0)
  }
}

export function getArtifact(
  kind: string,
  filePath: string,
  inputHash: string,
  model: string,
  promptVersion: number
): ArtifactRecord | null {
  const d = getDb()
  const row = d
    .prepare(
      `SELECT * FROM ai_artifacts
       WHERE kind = ? AND file_path = ? AND input_hash = ? AND model = ? AND prompt_version = ?`
    )
    .get(kind, filePath, inputHash, model, promptVersion) as Record<string, unknown> | undefined
  return row ? mapArtifactRow(row) : null
}

/** Most recent artifact of a kind regardless of key (used for memento + offline display). */
export function getLatestArtifact(kind: string, filePath?: string): ArtifactRecord | null {
  const d = getDb()
  const row = filePath
    ? (d
        .prepare(
          `SELECT * FROM ai_artifacts WHERE kind = ? AND file_path = ? ORDER BY generated_at DESC LIMIT 1`
        )
        .get(kind, filePath) as Record<string, unknown> | undefined)
    : (d
        .prepare(`SELECT * FROM ai_artifacts WHERE kind = ? ORDER BY generated_at DESC LIMIT 1`)
        .get(kind) as Record<string, unknown> | undefined)
  return row ? mapArtifactRow(row) : null
}

export function invalidateFileArtifacts(relPath: string): void {
  const d = getDb()
  d.prepare('DELETE FROM ai_artifacts WHERE file_path = ?').run(relPath)
}

export function invalidateAllArtifacts(): void {
  const d = getDb()
  d.prepare('DELETE FROM ai_artifacts').run()
}

// ---------------------------------------------------------------------------
// Change request persistence
// ---------------------------------------------------------------------------

export function putChangeRequest(id: string, json: string): void {
  const d = getDb()
  d.prepare(
    `INSERT INTO change_requests (id, json, created_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json`
  ).run(id, json, Date.now())
}

export function getChangeRequestJson(id: string): string | null {
  const d = getDb()
  const row = d.prepare('SELECT json FROM change_requests WHERE id = ?').get(id) as
    | { json: string }
    | undefined
  return row?.json ?? null
}

export function listChangeRequestRows(): { id: string; json: string; created_at: number }[] {
  const d = getDb()
  return d
    .prepare('SELECT id, json, created_at FROM change_requests ORDER BY created_at DESC')
    .all() as { id: string; json: string; created_at: number }[]
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function insertSession(
  id: string,
  projectRoot: string,
  startedAt: number,
  summaryJson?: string
): void {
  const d = getDb()
  d.prepare(
    `INSERT INTO sessions (id, project_root, started_at, summary_json) VALUES (?, ?, ?, ?)`
  ).run(id, projectRoot, startedAt, summaryJson ?? null)
}

export function endSession(id: string, endedAt: number, summaryJson?: string): void {
  const d = getDb()
  d.prepare('UPDATE sessions SET ended_at = ?, summary_json = COALESCE(?, summary_json) WHERE id = ?').run(
    endedAt,
    summaryJson ?? null,
    id
  )
}

export function insertSessionEvent(
  sessionId: string,
  ts: number,
  type: string,
  path?: string,
  detail?: string
): void {
  const d = getDb()
  d.prepare(
    'INSERT INTO session_events (session_id, ts, type, path, detail) VALUES (?, ?, ?, ?, ?)'
  ).run(sessionId, ts, type, path ?? null, detail ?? null)
}

export function listSessions(limit: number): {
  id: string
  projectRoot: string
  startedAt: number
  endedAt?: number
  summaryJson?: string
  eventCount: number
}[] {
  const d = getDb()
  return d
    .prepare(
      `SELECT s.id, s.project_root AS projectRoot, s.started_at AS startedAt, s.ended_at AS endedAt,
              s.summary_json AS summaryJson,
              (SELECT COUNT(*) FROM session_events e WHERE e.session_id = s.id) AS eventCount
       FROM sessions s ORDER BY s.started_at DESC LIMIT ?`
    )
    .all(limit) as {
    id: string
    projectRoot: string
    startedAt: number
    endedAt?: number
    summaryJson?: string
    eventCount: number
  }[]
}

export function getSessionEvents(sessionId: string, limit = 200): {
  id: number
  ts: number
  type: string
  path?: string
  detail?: string
}[] {
  const d = getDb()
  return d
    .prepare(
      `SELECT id, ts, type, path, detail FROM session_events
       WHERE session_id = ? ORDER BY ts DESC LIMIT ?`
    )
    .all(sessionId, limit) as {
    id: number
    ts: number
    type: string
    path?: string
    detail?: string
  }[]
}

export function deleteIndexedFile(path: string): void {
  const d = getDb()
  d.prepare('DELETE FROM files WHERE path = ?').run(path)
}

export { Database }