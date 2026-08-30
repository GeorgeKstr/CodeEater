import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback
} from 'react'
import {
  AppSettings,
  AIState,
  TreeNode,
  ChangeRequest,
  FileOverview,
  ProjectOverview,
  TextSearchResult,
  AISearchResponse,
  AIOperationStatusEvent,
  FsEvent,
  SaveResult
} from '../../shared/types'
import { isIgnored } from '../../shared/utils'

export interface RevealRequest {
  path: string
  startLine: number
  endLine?: number
  /** optional text to select/highlight */
  selectText?: string
  ts: number
}

interface BufferInfo {
  content: string
  dirty: boolean
  savedHash?: string
}

interface AppCtx {
  // project
  projectRoot: string | null
  projectName: string | null
  tree: TreeNode[] | null
  treeBusy: boolean
  openProjectDialog(): Promise<void>
  openProjectByPath(path: string): Promise<void>
  closeProject(): Promise<void>
  refreshTree(): Promise<void>
  expandedDirs: Set<string>
  toggleDir(rel: string): Promise<void>

  // tabs / buffers
  tabs: string[]
  activePath: string | null
  buffers: Record<string, BufferInfo>
  openFile(path: string, activate?: boolean): Promise<void>
  closeTab(path: string): Promise<void>
  activateTab(path: string): void
  updateBuffer(path: string, content: string, savedHash?: string): void
  setDirty(path: string, dirty: boolean): void
  saveActive(): Promise<SaveResult | null>
  markSaved(path: string, savedHash: string, content: string): void
  reveal: RevealRequest | null
  requestReveal(path: string, startLine: number, endLine?: number, selectText?: string): void
  consumeReveal(): RevealRequest | null

  // terminal
  terminalVisible: boolean
  toggleTerminal(): void

  // search state (left pane)
  searchQuery: string
  setSearchQuery(q: string): void
  textResults: TextSearchResult[] | null
  runTextSearch(query: string): Promise<void>
  aiSearch: { query: string; loading: boolean; status: string; result: AISearchResponse | null } | null
  runAiSearch(query: string): Promise<void>
  cancelAiSearch(): void

  // overview
  fileOverview: FileOverview | null
  projectOverview: ProjectOverview | null
  refreshFileOverview(force?: boolean): Promise<void>
  refreshProjectOverview(force?: boolean): Promise<void>
  resolveFeature(name: string, hints: string[]): Promise<void>

  // ai
  ai: AIState
  aiStatus: AIOperationStatusEvent | null
  connectAi(): Promise<void>

  // settings
  settings: AppSettings | null
  updateSettings(partial: Partial<AppSettings>): Promise<void>
  updateAiCfg(cfg: Partial<AppSettings['ai']>): Promise<void>

  // change requests
  changes: ChangeRequest[]
  refreshChanges(): Promise<void>
  reviewRequest: ChangeRequest | null
  setReviewRequest(cr: ChangeRequest | null): void
  runAiEdit(input: {
    mode: 'selection' | 'file' | 'codebase'
    prompt: string
    selection?: { startLine: number; endLine: number; text: string }
  }): Promise<void>
  aiWorking: boolean
  aiWorkingMessage: string

  // meta
  fuzzyOpen: boolean
  setFuzzyOpen(v: boolean): void
  settingsOpen: boolean
  setSettingsOpen(v: boolean): void
  version: string
}

const Ctx = createContext<AppCtx | null>(null)

export function useApp(): AppCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useApp outside provider')
  return ctx
}

let revealSeq = 0

export function AppProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [projectRoot, setProjectRoot] = useState<string | null>(null)
  const [projectName, setProjectName] = useState<string | null>(null)
  const [tree, setTree] = useState<TreeNode[] | null>(null)
  const [treeBusy, setTreeBusy] = useState(false)
  const [tabs, setTabs] = useState<string[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [buffers, setBuffers] = useState<Record<string, BufferInfo>>({})
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [terminalVisible, setTerminalVisible] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [textResults, setTextResults] = useState<TextSearchResult[] | null>(null)
  const [aiSearch, setAiSearch] = useState<AppCtx['aiSearch']>(null)
  const [fileOverview, setFileOverview] = useState<FileOverview | null>(null)
  const [projectOverview, setProjectOverview] = useState<ProjectOverview | null>(null)
  const [ai, setAi] = useState<AIState>({
    status: 'unconfigured',
    models: [],
    capabilities: { chatCompletions: true, responsesApi: false, structuredOutput: false, tools: false, streaming: true, embeddings: false }
  })
  const [aiStatus, setAiStatus] = useState<AIOperationStatusEvent | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [changes, setChanges] = useState<ChangeRequest[]>([])
  const [reviewRequest, setReviewRequest] = useState<ChangeRequest | null>(null)
  const [aiWorking, setAiWorking] = useState(false)
  const [aiWorkingMessage, setAiWorkingMessage] = useState('')
  const [fuzzyOpen, setFuzzyOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [version, setVersion] = useState('')
  const [reveal, setReveal] = useState<RevealRequest | null>(null)

  const buffersRef = useRef(buffers)
  buffersRef.current = buffers
  const aiSearchReqRef = useRef<string | null>(null)
  const lastSavedHash = useRef<Record<string, string>>({})

  const api = window.api

  // ------------------------------------------------------------------ init
  useEffect(() => {
    void api.app.getVersion().then(setVersion)
    void api.settings.get().then((s) => {
      setSettings(s)
      setTerminalVisible(s.terminalVisible || false)
      void api.project.setTerminalVisible(s.terminalVisible || false)
    })
    void api.ai.getState().then(setAi)
    void api.changes.list().then(setChanges).catch(() => undefined)
  }, [])

  useEffect(() => {
    const offSettings = api.watcher.onEvent((ev) => handleFsEvent(ev))
    const offAi = api.ai.onStatus((e) => {
      setAiStatus(e)
      if (e.error) {
        setAiWorking(false)
        setAiWorkingMessage('')
      }
    })
    const offChanges = api.changes.onChanged(() => void refreshChanges())
    const offOpened = api.project.onOpened((info) => {
      // main opened a project (dialog, CLI `coe <dir>`, or load-project)
      if (pendingOpenedRef.current.has(info.root)) {
        pendingOpenedRef.current.delete(info.root)
        return // dialog path drives activation itself
      }
      void activateProject(info.root, info.name)
    })
    return () => {
      offSettings()
      offAi()
      offChanges()
      offOpened()
    }
  }, [])

  const pendingOpenedRef = useRef<Set<string>>(new Set())

  async function handleFsEvent(ev: FsEvent): Promise<void> {
    const root = projectRootRef.current
    // refresh tree (debounced)
    void scheduleTreeRefresh()
    // map abs → rel
    if (!root) return
    const rel = ev.path.startsWith(root) ? ev.path.slice(root.length + 1).replace(/\\/g, '/') : ''
    if (!rel) return
    if (ev.type === 'change') {
      // reload buffer if open and not dirty
      const info = buffersRef.current[rel]
      if (info && !info.dirty) {
        try {
          const content = await api.fs.readFile(rel)
          const hash = await api.fs.hash(rel)
          updateBuffer(rel, content, hash ?? undefined)
        } catch {
          /* ignore */
        }
      }
    } else if (ev.type === 'unlink') {
      // close tab if open
      if (tabsRef.current.includes(rel)) {
        await closeTab(rel)
      }
      setBuffers((b) => {
        const n = { ...b }
        delete n[rel]
        return n
      })
    }
  }

  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const projectRootRef = useRef(projectRoot)
  projectRootRef.current = projectRoot

  // ---------------------------------------------------------------- utils
  const scheduleTreeRefresh = useCallback(() => {
    setTreeBusy(true)
    void api.project
      .getTree()
      .then((t) => setTree(applyExpanded(t, expandedDirsRef.current)))
      .finally(() => setTreeBusy(false))
  }, [])
  const expandedDirsRef = useRef(expandedDirs)
  expandedDirsRef.current = expandedDirs

  function applyExpanded(nodes: TreeNode[], expanded: Set<string>): TreeNode[] {
    return nodes.map((n) => {
      const copy = { ...n }
      if (n.isDir) {
        copy.expanded = expanded.has(n.relPath)
        if (copy.children) copy.children = applyExpanded(copy.children, expanded)
      }
      return copy
    })
  }

  // --------------------------------------------------------------- project
  async function openProjectDialog(): Promise<void> {
    const info = await api.app.openProjectDialog()
    if (info) {
      pendingOpenedRef.current.add(info.root)
      await activateProject(info.root, info.name)
    }
  }

  async function openProjectByPath(path: string): Promise<void> {
    const info = await api.project.open(path)
    if (info) {
      pendingOpenedRef.current.add(info.root)
      await activateProject(info.root, info.name)
    }
  }

  async function activateProject(root: string, name: string): Promise<void> {
    setProjectRoot(root)
    setProjectName(name)
    const state = await api.project.getState()
    setExpandedDirs(new Set(state?.expandedDirs ?? []))
    setTerminalVisible(state?.terminalVisible ?? false)
    // restore tabs
    const open = state?.openTabs ?? []
    const active = state?.activeFile ?? open[0] ?? null
    setTabs(open)
    setActivePath(active)
    const bufs: Record<string, BufferInfo> = {}
    await Promise.all(
      open.map(async (p) => {
        try {
          const content = await api.fs.readFile(p)
          const hash = await api.fs.hash(p)
          bufs[p] = { content, dirty: false, savedHash: hash ?? undefined }
        } catch {
          /* file gone — skip tab */
        }
      })
    )
    setBuffers(bufs)
    await refreshTree()
    void refreshProjectOverview()
    if (active) void refreshFileOverview()
    // restore terminal visibility & start session lazily
    void api.project.setTerminalVisible(state?.terminalVisible ?? false)
    scheduleTreeRefresh()
  }

  async function closeProject(): Promise<void> {
    await api.project.close()
    setProjectRoot(null)
    setProjectName(null)
    setTree(null)
    setTabs([])
    setActivePath(null)
    setBuffers({})
    setFileOverview(null)
    setProjectOverview(null)
    setTextResults(null)
    setAiSearch(null)
  }

  async function refreshTree(): Promise<void> {
    setTreeBusy(true)
    try {
      const t = await api.project.getTree()
      setTree(applyExpanded(t, expandedDirsRef.current))
    } finally {
      setTreeBusy(false)
    }
  }

  async function toggleDir(rel: string): Promise<void> {
    const next = new Set(expandedDirsRef.current)
    if (next.has(rel)) next.delete(rel)
    else next.add(rel)
    setExpandedDirs(next)
    await api.project.setExpanded(rel, next.has(rel))
    const t = await api.project.getTree()
    setTree(applyExpanded(t, next))
  }

  // ------------------------------------------------------------ files/tabs
  async function openFile(path: string, activate = true): Promise<void> {
    if (!path) return
    if (tabsRef.current.includes(path)) {
      if (activate) {
        setActivePath(path)
        void setActiveTabPersist(path)
      }
      return
    }
    try {
      const content = await api.fs.readFile(path)
      const hash = await api.fs.hash(path)
      setBuffers((b) => ({ ...b, [path]: { content, dirty: false, savedHash: hash ?? undefined } }))
      const next = [...tabsRef.current, path]
      setTabs(next)
      setActivePath(path)
      persistTabs(next, path)
      void api.search.getSymbols(path).catch(() => undefined) // warm cache
      if (activate) void refreshFileOverview()
    } catch {
      /* file unreadable */
    }
  }

  function persistTabs(open: string[], active: string | null): void {
    void api.project.setTabs(open, active)
    void api.search.getSymbols(open[0] ?? '').catch(() => undefined)
  }

  async function setActiveTabPersist(path: string): Promise<void> {
    void path
  }

  async function closeTab(path: string): Promise<void> {
    const info = buffersRef.current[path]
    if (info?.dirty) {
      const ok = window.confirm(`Discard unsaved changes in ${path}?`)
      if (!ok) return
    }
    const next = tabsRef.current.filter((t) => t !== path)
    setTabs(next)
    if (activePath === path) {
      const fallback = next[next.length - 1] ?? null
      setActivePath(fallback)
      setBuffers((b) => {
        const n = { ...b }
        delete n[path]
        return n
      })
      if (fallback) void refreshFileOverview()
      else setFileOverview(null)
    }
    if (next.length === 0) setFileOverview(null)
  }

  function activateTab(path: string): void {
    setActivePath(path)
    void refreshFileOverview()
  }

  function updateBuffer(path: string, content: string, savedHash?: string): void {
    setBuffers((b) => {
      const prev = b[path]
      const hash = prev?.savedHash ?? savedHash
      return { ...b, [path]: { content, dirty: prev?.dirty ?? true, savedHash: hash } }
    })
  }

  function setDirty(path: string, dirty: boolean): void {
    setBuffers((b) => {
      const prev = b[path]
      if (!prev) return b
      return { ...b, [path]: { ...prev, dirty } }
    })
  }

  function markSaved(path: string, savedHash: string, content: string): void {
    lastSavedHash.current[path] = savedHash
    setBuffers((b) => ({ ...b, [path]: { content, dirty: false, savedHash } }))
  }

  async function saveActive(): Promise<SaveResult | null> {
    if (!activePath) return null
    const info = buffersRef.current[activePath]
    if (!info || !info.dirty) return null
    const res = await api.fs.save(activePath, info.content, info.savedHash)
    if (res.ok && res.hash) {
      markSaved(activePath, res.hash, info.content)
    }
    return res
  }

  function requestReveal(path: string, startLine: number, endLine?: number, selectText?: string): void {
    setReveal({ path, startLine, endLine, selectText, ts: ++revealSeq })
  }

  function consumeReveal(): RevealRequest | null {
    const r = reveal
    setReveal(null)
    return r
  }

  // terminal
  function toggleTerminal(): void {
    setTerminalVisible((v) => {
      void api.project.setTerminalVisible(!v)
      return !v
    })
  }

  // ---------------------------------------------------------------- search
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!searchQuery.trim()) {
      setTextResults(null)
      return
    }
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      void runTextSearch(searchQuery)
    }, 350)
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    }
  }, [searchQuery])

  async function runTextSearch(query: string): Promise<void> {
    if (!query.trim()) {
      setTextResults(null)
      return
    }
    const res = await api.search.text({ query: query.trim(), maxResults: 300 })
    setTextResults(res)
  }

  async function runAiSearch(query: string): Promise<void> {
    if (!query.trim() || aiSearch?.loading) return
    const requestId = `ais-${Date.now()}`
    aiSearchReqRef.current = requestId
    setAiSearch({ query, loading: true, status: 'Expanding query…', result: null })
    try {
      const expanded = (await api.ai.run('ai-search-expand', { query }, requestId)) as {
        concepts: string[]
        likelySymbols: string[]
        likelyFileTerms: string[]
      }
      if (aiSearchReqRef.current !== requestId) return
      setAiSearch({ query, loading: true, status: 'Searching codebase…', result: null })
      const result = (await api.ai.run(
        'ai-search-final',
        { query, expanded },
        `${requestId}-2`
      )) as AISearchResponse
      if (aiSearchReqRef.current !== requestId) return
      setAiSearch({ query, loading: false, status: '', result })
    } catch (e) {
      if (aiSearchReqRef.current !== requestId) return
      setAiSearch({ query, loading: false, status: `failed: ${(e as Error).message}`, result: null })
    } finally {
      if (aiSearchReqRef.current === requestId) aiSearchReqRef.current = null
    }
  }

  function cancelAiSearch(): void {
    if (aiSearchReqRef.current) {
      void api.ai.cancel(aiSearchReqRef.current)
      aiSearchReqRef.current = null
      setAiSearch((s) => (s ? { ...s, loading: false, status: 'cancelled' } : s))
    }
  }

  // -------------------------------------------------------------- overview
  async function refreshFileOverview(force = false): Promise<void> {
    if (!activePath) {
      setFileOverview(null)
      return
    }
    try {
      const ov = await api.overview.getFileOverview(activePath, force)
      setFileOverview(ov)
    } catch (e) {
      setFileOverview(null)
      console.warn('file overview failed', e)
    }
  }

  async function refreshProjectOverview(force = false): Promise<void> {
    try {
      const ov = await api.overview.getProjectOverview(force)
      setProjectOverview(ov)
    } catch (e) {
      console.warn('project overview failed', e)
    }
  }

  async function resolveFeature(name: string, hints: string[]): Promise<void> {
    if (!projectOverview) return
    try {
      const resolved = await api.overview.resolveFeature(name, hints)
      setProjectOverview((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          features: prev.features.map((f) => (f.name === name ? resolved : f))
        }
      })
    } catch (e) {
      console.warn('feature resolution failed', e)
    }
  }

  // -------------------------------------------------------------------- ai
  async function connectAi(): Promise<void> {
    const state = await api.ai.connect(true)
    setAi(state)
  }

  useEffect(() => {
    setAiStatus((s) => {
      if (!s) return s
      void api.ai.getState().then(setAi)
      return s
    })
  }, [])

  // ------------------------------------------------------------- settings
  async function updateSettings(partial: Partial<AppSettings>): Promise<void> {
    const s = await api.settings.update(partial)
    setSettings(s)
    if (partial.terminalVisible !== undefined) setTerminalVisible(partial.terminalVisible)
  }

  async function updateAiCfg(cfg: Partial<AppSettings['ai']>): Promise<void> {
    const s = await api.settings.updateAi(cfg)
    setSettings(s)
    const state = await api.ai.getState()
    setAi(state)
  }

  // --------------------------------------------------------------- changes
  async function refreshChanges(): Promise<void> {
    try {
      const list = await api.changes.list()
      setChanges(list)
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------- AI edits
  async function runAiEdit(input: {
    mode: 'selection' | 'file' | 'codebase'
    prompt: string
    selection?: { startLine: number; endLine: number; text: string }
  }): Promise<void> {
    if (!activePath) return
    setAiWorking(true)
    setAiWorkingMessage('Preparing…')
    try {
      let cr: ChangeRequest | null = null
      if (input.mode === 'selection' && input.selection) {
        const result = (await api.ai.run('selection-edit', {
          prompt: input.prompt,
          filePath: activePath,
          selectionStart: { line: input.selection.startLine, character: 0 },
          selectionEnd: { line: input.selection.endLine, character: 0 },
          selectedText: input.selection.text
        })) as ChangeRequest
        cr = result
      } else if (input.mode === 'file') {
        cr = (await api.ai.run('file-edit', { prompt: input.prompt, filePath: activePath })) as ChangeRequest
      } else {
        const plan = (await api.ai.run('codebase-plan', { prompt: input.prompt })) as {
          summary: string
          files: { path: string; reason: string }[]
        }
        if (!plan.files?.length) {
          window.alert('AI could not identify files to change. Try a more specific request.')
          return
        }
        cr = (await api.ai.run('codebase-edit', { prompt: input.prompt, plan })) as ChangeRequest
      }
      await refreshChanges()
      if (cr) setReviewRequest(cr)
    } catch (e) {
      window.alert(`AI edit failed: ${(e as Error).message}`)
    } finally {
      setAiWorking(false)
      setAiWorkingMessage('')
    }
  }

  const value = useMemo<AppCtx>(
    () => ({
      projectRoot,
      projectName,
      tree,
      treeBusy,
      openProjectDialog,
      openProjectByPath,
      closeProject,
      refreshTree,
      expandedDirs,
      toggleDir,
      tabs,
      activePath,
      buffers,
      openFile,
      closeTab,
      activateTab,
      updateBuffer,
      setDirty,
      saveActive,
      markSaved,
      reveal,
      requestReveal,
      consumeReveal,
      terminalVisible,
      toggleTerminal,
      searchQuery,
      setSearchQuery,
      textResults,
      runTextSearch,
      aiSearch,
      runAiSearch,
      cancelAiSearch,
      fileOverview,
      projectOverview,
      refreshFileOverview,
      refreshProjectOverview,
      resolveFeature,
      ai,
      aiStatus,
      connectAi,
      settings,
      updateSettings,
      updateAiCfg,
      changes,
      refreshChanges,
      reviewRequest,
      setReviewRequest,
      runAiEdit,
      aiWorking,
      aiWorkingMessage,
      fuzzyOpen,
      setFuzzyOpen,
      settingsOpen,
      setSettingsOpen,
      version
    }),
    [
      projectRoot, projectName, tree, treeBusy, expandedDirs, tabs, activePath, buffers,
      terminalVisible, searchQuery, textResults, aiSearch, fileOverview, projectOverview,
      ai, aiStatus, settings, changes, reviewRequest, aiWorking, aiWorkingMessage,
      fuzzyOpen, settingsOpen, version, reveal
    ]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

// suppress unused warnings for helpers kept for future use
void isIgnored