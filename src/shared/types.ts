/**
 * Shared type contract between the Electron main process and the renderer.
 * Everything crossing the typed IPC boundary is defined here.
 */

// ---------------------------------------------------------------------------
// Positions & navigation
// ---------------------------------------------------------------------------

/** Line numbers are 1-based (matching Monaco & ripgrep). Characters are 0-based (matching Monaco). */
export interface LineRange {
  startLine: number
  endLine: number
}

// ---------------------------------------------------------------------------
// Project & filesystem
// ---------------------------------------------------------------------------

export interface ProjectInfo {
  root: string
  name: string
  openedAt: number
}

export interface FileStat {
  path: string
  relPath: string
  size: number
  mtime: number // epoch ms
  isDir: boolean
}

export interface TreeNode {
  name: string
  path: string
  relPath: string
  isDir: boolean
  children?: TreeNode[]
  /** true when directory is expanded in UI */
  expanded?: boolean
}

export interface ProjectUiState {
  root: string
  openTabs: string[]
  activeFile?: string
  expandedDirs: string[]
  terminalVisible: boolean
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

export type EditorBuffer = {
  path: string
  content: string
  dirty: boolean
  /** content hash at last save */
  savedHash?: string
}

export interface SaveResult {
  ok: boolean
  hash?: string
  error?: string
}

export interface TextEdit {
  /** replace: lines [startLine..endLine] inclusive are replaced by `replacement`.
   *  insert:   text is inserted after line `startLine` (startLine 0 = top of file).
   *  create:   new file with `content`.
   *  delete:   delete lines [startLine..endLine] (or whole file if range empty). */
  operation: 'replace' | 'insert' | 'create' | 'delete'
  path: string
  startLine?: number
  endLine?: number
  replacement?: string
  content?: string
}

// ---------------------------------------------------------------------------
// Deterministic search
// ---------------------------------------------------------------------------

export interface TextSearchResult {
  path: string
  relPath: string
  line: number
  lineText: string
  matchStart: number
  matchEnd: number
}

export interface TextSearchOptions {
  query: string
  maxResults?: number
  caseSensitive?: boolean
  wordMatch?: boolean
  /** limit search to these paths (relative to project root) */
  includePaths?: string[]
}

export interface FileSearchResult {
  path: string
  relPath: string
  score: number
  isDir?: boolean
}

// ---------------------------------------------------------------------------
// Index (symbols / chunks / imports)
// ---------------------------------------------------------------------------

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'module'
  | 'variable'
  | 'topLevel'

export interface SymbolInfo {
  name: string
  kind: SymbolKind
  startLine: number
  endLine: number
  parent?: string
}

export interface ChunkInfo {
  startLine: number
  endLine: number
  symbolName?: string
  kind: string
}

export interface ImportInfo {
  rawTarget: string
  /** resolved path relative to project root, when resolvable */
  resolvedRelPath?: string
  kind: 'import' | 'require' | 'include' | 'use'
}

export interface IndexStatus {
  indexed: number
  errors: number
  lastIndexedAt: number
  inProgress: boolean
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string
  ownedBy?: string
}

export interface ModelCapabilities {
  chatCompletions: boolean
  responsesApi: boolean
  structuredOutput: boolean
  tools: boolean
  streaming: boolean
  embeddings: boolean
}

export type AIStatusKind = 'unconfigured' | 'connecting' | 'connected' | 'offline' | 'error'

export interface AIState {
  status: AIStatusKind
  error?: string
  models: ModelInfo[]
  activeModel?: string
  capabilities: ModelCapabilities
}

export interface AIConfig {
  baseUrl: string
  apiKey?: string
  modelMode: 'auto' | 'manual'
  model?: string
  contextWindow: number
  maxOutputTokens: number
  temperature: number
}

export const DEFAULT_AI_CONFIG: AIConfig = {
  baseUrl: 'http://localhost:1234/v1',
  modelMode: 'auto',
  contextWindow: 32768,
  maxOutputTokens: 4096,
  temperature: 0.1
}

export type AIOperationId =
  | 'project-overview'
  | 'project-features'
  | 'feature-resolution'
  | 'file-overview'
  | 'ai-search-expand'
  | 'ai-search-final'
  | 'selection-edit'
  | 'file-edit'
  | 'codebase-plan'
  | 'codebase-edit'
  | 'session-summary'

export interface AIOperationStatusEvent {
  requestId: string
  operation: AIOperationId
  /** short user-facing status line, e.g. "Analyzing file…" */
  message: string
  done?: boolean
  error?: string
}

/** Input payloads for each AI operation (renderer → main). */
export interface AIOperationInput {
  'project-overview': { force?: boolean }
  'project-features': { force?: boolean }
  'feature-resolution': { featureName: string; hints: string[] }
  'file-overview': { path: string; force?: boolean }
  'ai-search-expand': { query: string }
  'ai-search-final': {
    query: string
    expanded: {
      concepts: string[]
      likelySymbols: string[]
      likelyFileTerms: string[]
    }
  }
  'selection-edit': {
    prompt: string
    filePath: string
    selectionStart: { line: number; character: number }
    selectionEnd: { line: number; character: number }
    selectedText: string
  }
  'file-edit': { prompt: string; filePath: string }
  'codebase-plan': { prompt: string }
  'codebase-edit': {
    prompt: string
    plan: {
      summary: string
      files: { path: string; reason: string }[]
    }
  }
  'session-summary': { sessionId?: string; force?: boolean }
}

// ---------------------------------------------------------------------------
// Overview artifacts
// ---------------------------------------------------------------------------

export interface FileSection {
  title: string
  startLine: number
  endLine: number
}

export interface RelatedFile {
  path: string
  reason: string
  relationshipType: 'direct' | 'semantic'
}

export interface FileOverview {
  path: string
  summary: string
  sections: FileSection[]
  relatedFiles: RelatedFile[]
  cached: boolean
  generatedAt: number
  model?: string
}

export interface RunCommand {
  label: string
  command: string
  source: string
  verified: boolean
}

export interface FeatureFileLocation {
  label: string
  startLine: number
  endLine: number
}

export interface FeatureFile {
  path: string
  reason: string
  importance: 'primary' | 'secondary'
  locations: FeatureFileLocation[]
}

export interface ProjectFeature {
  name: string
  summary: string
  searchHints: string[]
  files?: FeatureFile[]
  resolved?: boolean
}

export interface SessionSummary {
  title: string
  summary: string
  files: string[]
}

export interface ProjectOverview {
  root: string
  summary: string
  commands: RunCommand[]
  features: ProjectFeature[]
  recentWork: SessionSummary[]
  cached: boolean
  generatedAt: number
  model?: string
}

/** Feature-resolution input built deterministically from the project index. */
export interface FeatureResolutionInput {
  featureName: string
  hints: string[]
  candidates: { path: string; reason: string; relevance: number }[]
}

export interface AISearchResult {
  path: string
  relPath: string
  startLine?: number
  endLine?: number
  reason: string
}

export interface AISearchResponse {
  summary: string
  results: AISearchResult[]
}

// ---------------------------------------------------------------------------
// Change requests
// ---------------------------------------------------------------------------

export type ChangeScope = 'selection' | 'file' | 'codebase'
export type ChangeStatus = 'pending' | 'accepted' | 'rejected' | 'reverted' | 'conflicted'
export type ChangeFileOperation = 'modify' | 'create' | 'delete'

export interface ChangeRequestFile {
  path: string
  operation: ChangeFileOperation
  originalHash?: string
  proposedHash?: string
  originalContent?: string
  proposedContent?: string
  /** hash of the file on disk right now — compared against originalHash */
  diskHash?: string
  /** 'clean' | 'stale' | 'missing' | 'new' — preview applicability */
  state: 'clean' | 'stale' | 'missing' | 'new'
}

export interface ChangeRequest {
  id: string
  prompt: string
  scope: ChangeScope
  status: ChangeStatus
  createdAt: number
  summary: string
  files: ChangeRequestFile[]
  /** raw validated edits (for re-application / revert) */
  edits: TextEdit[]
  error?: string
}

export interface ChangeRequestDraft {
  prompt: string
  scope: ChangeScope
  summary: string
  edits: TextEdit[]
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type SessionEventType =
  | 'session_started'
  | 'session_ended'
  | 'file_opened'
  | 'file_modified'
  | 'file_created'
  | 'file_deleted'
  | 'file_saved'
  | 'change_request_created'
  | 'change_request_accepted'
  | 'change_request_rejected'
  | 'change_request_reverted'
  | 'search_performed'
  | 'ai_search_performed'

export interface SessionEventRecord {
  id: number
  sessionId: string
  ts: number
  type: SessionEventType
  path?: string
  detail?: string
}

export interface SessionRecord {
  id: string
  projectRoot: string
  startedAt: number
  endedAt?: number
  summary?: SessionSummary
  eventCount: number
}

// ---------------------------------------------------------------------------
// Settings & UI persistence
// ---------------------------------------------------------------------------

export interface KeybindingMap {
  /** Open the fuzzy file finder (Ctrl+P) */
  findFile: string
  /** Show / hide the terminal pane (Ctrl+`) */
  toggleTerminal: string
  /** Save the active file (Ctrl+S) */
  saveFile: string
  /** Open preferences (Ctrl+,) */
  openPreferences: string
  /** Close the active editor tab (Ctrl+W) */
  closeTab: string
  /** Create a new terminal tab (Ctrl+Shift+`) */
  newTerminal: string
}

export interface TerminalPreferenceSettings {
  fontSize: number
  fontFamily: string
  scrollback: number
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalPreferenceSettings = {
  fontSize: 12,
  fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
  scrollback: 5000
}

export interface AppSettings {
  ai: AIConfig
  paneSizes: { left: number; right: number; bottom: number }
  recentProjects: { path: string; name: string; openedAt: number }[]
  terminalVisible: boolean
  runCommand?: string
  aiSearchAuto?: boolean
  keybindings: KeybindingMap
  terminal: TerminalPreferenceSettings
}

export const DEFAULT_SETTINGS: AppSettings = {
  ai: { ...DEFAULT_AI_CONFIG },
  paneSizes: { left: 260, right: 300, bottom: 200 },
  recentProjects: [],
  terminalVisible: false,
  runCommand: '',
  keybindings: {
    findFile: '',
    toggleTerminal: 'ctrl+`',
    saveFile: '',
    openPreferences: '',
    closeTab: '',
    newTerminal: ''
  },
  terminal: { ...DEFAULT_TERMINAL_SETTINGS }
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

export interface TerminalSessionInfo {
  id: string
  title: string
  alive: boolean
  startedAt: number
}

// ---------------------------------------------------------------------------
// IPC surface
// ---------------------------------------------------------------------------

export interface IpcApi {
  app: {
    getVersion(): Promise<string>
    openProjectDialog(): Promise<ProjectInfo | null>
    selectFolder(): Promise<string | null>
    /** main → renderer: user picked File ▸ Open Project (or Cmd/Ctrl+O) */
    onOpenProject(cb: () => void): () => void
    onCloseProject(cb: () => void): () => void
    onOpenPreferences(cb: () => void): () => void
    onOpenCommandPalette(cb: () => void): () => void
    onToggleTerminal(cb: () => void): () => void
  }
  project: {
    open(root: string): Promise<ProjectInfo>
    onOpened(cb: (info: ProjectInfo) => void): () => void
    close(): Promise<void>
    getState(): Promise<ProjectUiState | null>
    getTree(): Promise<TreeNode[]>
    setExpanded(relPath: string, expanded: boolean): Promise<void>
    setTabs(openTabs: string[], activeFile: string | null): Promise<void>
    setTerminalVisible(visible: boolean): Promise<void>
  }
  fs: {
    readFile(path: string): Promise<string>
    readLines(path: string, start: number, end: number): Promise<string>
    save(path: string, content: string, expectedHash?: string): Promise<SaveResult>
    stat(path: string): Promise<FileStat | null>
    exists(path: string): Promise<boolean>
    hash(path: string): Promise<string | null>
    /** apply an approved change request (used by change engine) */
  }
  watcher: {
    onEvent(cb: (e: FsEvent) => void): () => void
  }
  search: {
    text(opts: TextSearchOptions): Promise<TextSearchResult[]>
    files(query: string, limit?: number, boostPaths?: string[]): Promise<FileSearchResult[]>
    getSymbols(path: string): Promise<SymbolInfo[]>
    getChunks(path: string): Promise<ChunkInfo[]>
    getImports(path: string): Promise<ImportInfo[]>
    getReferences(path: string): Promise<string[]>
  }
  index: {
    status(): Promise<IndexStatus>
    rescan(): Promise<IndexStatus>
  }
  terminal: {
    start(): Promise<{ ok: boolean; error?: string }>
    /** list live terminal sessions (tabs) */
    list(): Promise<TerminalSessionInfo[]>
    /** spawn a new session; returns its id */
    create(): Promise<{ ok: boolean; id?: string; error?: string }>
    close(id: string): Promise<void>
    activate(id: string): Promise<void>
    write(id: string, data: string): Promise<void>
    resize(id: string, cols: number, rows: number): Promise<void>
    kill(): Promise<void>
    onData(cb: (id: string, data: string) => void): () => void
    onExit(cb: (id: string, code: number | null) => void): () => void
    /** session list changed (created / closed / exited) */
    onListChanged(cb: () => void): () => void
    isRunning(): Promise<boolean>
  }
  ai: {
    getState(): Promise<AIState>
    onStateChanged(cb: (s: AIState) => void): () => void
    connect(force?: boolean): Promise<AIState>
    setConfig(cfg: Partial<AIConfig>): Promise<AIState>
    discoverModels(): Promise<ModelInfo[]>
    run(operation: AIOperationId, input: unknown, requestId?: string): Promise<unknown>
    cancel(requestId: string): Promise<void>
    onStatus(cb: (e: AIOperationStatusEvent) => void): () => void
  }
  overview: {
    getFileOverview(path: string, force?: boolean): Promise<FileOverview>
    getProjectOverview(force?: boolean): Promise<ProjectOverview>
    resolveFeature(featureName: string, hints: string[]): Promise<ProjectFeature>
    invalidateFile(path: string): Promise<void>
  }
  changes: {
    create(draft: ChangeRequestDraft): Promise<ChangeRequest>
    list(): Promise<ChangeRequest[]>
    get(id: string): Promise<ChangeRequest | null>
    apply(id: string): Promise<ChangeRequest>
    reject(id: string): Promise<ChangeRequest>
    revert(id: string): Promise<ChangeRequest>
    onChanged(cb: () => void): () => void
  }
  sessions: {
    list(limit?: number): Promise<SessionRecord[]>
    current(): Promise<SessionRecord | null>
  }
  settings: {
    get(): Promise<AppSettings>
    update(partial: Partial<AppSettings>): Promise<AppSettings>
    updateAi(cfg: Partial<AIConfig>): Promise<AppSettings>
  }
  shell: {
    showItemInFolder(relPath: string): Promise<void>
  }
}

export type FsEvent =
  | { type: 'add'; path: string; isDir: boolean }
  | { type: 'change'; path: string }
  | { type: 'unlink'; path: string; isDir: boolean }
  | { type: 'addDir'; path: string }
  | { type: 'unlinkDir'; path: string }

// ---------------------------------------------------------------------------
// Ai operation results (structured)
// ---------------------------------------------------------------------------

export interface ProjectSummaryResult {
  summary: string
}

export interface FeaturesResult {
  features: { name: string; summary: string; searchHints: string[] }[]
}

export interface FeatureResolutionResult {
  feature: string
  files: FeatureFile[]
}

export interface FileOverviewResult {
  summary: string
  sections: FileSection[]
  relatedFiles: RelatedFile[]
}

export interface AISearchExpandResult {
  concepts: string[]
  likelySymbols: string[]
  likelyFileTerms: string[]
}

export interface EditProposalResult {
  summary: string
  edits: TextEdit[]
}

export interface CodebasePlanResult {
  summary: string
  files: { path: string; reason: string }[]
}

export interface SessionSummaryResult {
  title: string
  summary: string
  files: string[]
}