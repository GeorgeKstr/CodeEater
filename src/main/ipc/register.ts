import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import { IPC } from '../../shared/ipc'
import {
  saveSettings,
  loadSettings,
  updateAiConfig
} from '../settings'
import {
  openProject,
  closeProject,
  getProjectInfo,
  buildTree,
  saveUiState,
  getUiState,
  readProjectFile,
  writeProjectFile,
  statProjectFile,
  hashProjectFile,
  readProjectLines,
  getProjectRoot,
  projectEvents
} from '../project'
import { textSearch } from '../core/text-search'
import { fuzzyFiles, invalidateFileIndex } from '../core/file-search'
import { getSymbols, getChunks, getImports, getReferences } from '../core/retrieval'
import { indexProject, reindexPath, setProjectRootForIndex } from '../core/ts-indexer'
import {
  ensureTerminal,
  createTerminal,
  listTerminals,
  closeTerminal,
  activateTerminal,
  writeToTerminal,
  resizeTerminal,
  killTerminal,
  isTerminalRunning,
  onTerminalData,
  onTerminalExit,
  onTerminalChanged
} from '../terminal/terminal-manager'
import {
  gateway,
  connectAI,
  applyAIConfig,
  runOperation,
  cancelOperation,
  onStatus,
  onAiState,
  ensureAiConnected,
  warmFeatureMemento
} from '../ai/service'
import {
  fileOverviewOp,
  invalidateFileOverview
} from '../overview-service'
import {
  projectOverviewOp,
  featureResolutionOp
} from '../overview-service'
import {
  createChangeRequest,
  listChangeRequests,
  getChangeRequest,
  applyChangeRequest,
  rejectChangeRequest,
  revertChangeRequest
} from '../core/patcher'
import { listRecentSessions, startSession, getCurrentSessionId, recordEvent, stopSession } from '../core/session-manager'
import { openDatabase, closeDatabase, invalidateAllArtifacts, getDb } from '../persistence/database'
import { AppSettings, AIConfig } from '../../shared/types'
import { EventEmitter } from 'events'

const changesEmitter = new EventEmitter()

let mainWindow: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win
}

function send(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

export function registerIpc(): void {
  // ------------------------------------------------------------------ app
  ipcMain.handle(IPC.appGetVersion, () => process.versions.electron ?? '0.0.0')
  ipcMain.handle(IPC.appOpenProjectDialog, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = await dialog.showOpenDialog(win!, {
      title: 'Open Project',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const root = result.filePaths[0]
    await initProject(root)
    return getProjectInfo()
  })
  ipcMain.handle(IPC.appSelectFolder, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  // -------------------------------------------------------------- project
  ipcMain.handle(IPC.projectOpen, async (_e, root: string) => {
    await initProject(root)
    return getProjectInfo()
  })
  ipcMain.handle(IPC.projectClose, async () => {
    await closeProject()
    closeDatabase()
  })
  ipcMain.handle(IPC.projectGetState, () => getUiState())
  ipcMain.handle(IPC.projectGetTree, async () => buildTree())
  ipcMain.handle(IPC.projectSetExpanded, async (_e, rel: string, expanded: boolean) => {
    await saveUiState({ expandedDirs: updateExpanded(getUiState()?.expandedDirs ?? [], rel, expanded) })
  })
  ipcMain.handle(IPC.projectSetTabs, async (_e, openTabs: string[], activeFile: string | null) => {
    await saveUiState({ openTabs, activeFile: activeFile ?? undefined })
  })
  ipcMain.handle(IPC.projectSetTerminalVisible, async (_e, visible: boolean) => {
    await saveUiState({ terminalVisible: visible })
  })

  // ------------------------------------------------------------------- fs
  ipcMain.handle(IPC.fsReadFile, async (_e, p: string) => readProjectFile(p))
  ipcMain.handle(IPC.fsReadLines, async (_e, p: string, s: number, e: number) => readProjectLines(p, s, e))
  ipcMain.handle(IPC.fsSave, async (_e, p: string, content: string, expectedHash?: string) => {
    const res = await writeProjectFile(p, content, expectedHash)
    if (res.ok) {
      recordSessionEvent('file_saved', p)
      recordSessionEvent('file_modified', p)
    }
    return res
  })
  ipcMain.handle(IPC.fsStat, async (_e, p: string) => statProjectFile(p))
  ipcMain.handle(IPC.fsExists, async (_e, p: string) => (await statProjectFile(p)) !== null)
  ipcMain.handle(IPC.fsHash, async (_e, p: string) => (await hashProjectFile(p))?.hash ?? null)

  // --------------------------------------------------------------- watcher
  projectEvents.on('event', (ev) => {
    const root = getProjectRoot()
    if (root && typeof ev === 'object' && ev && 'path' in ev) {
      const rel = path.relative(root, (ev as { path: string }).path).split(path.sep).join('/')
      void rel
      send(IPC.watcherEvent, ev)
      // incremental re-index
      const t = (ev as { type: string }).type
      if (t === 'add' || t === 'change' || t === 'unlink') {
        void reindexPath((ev as { path: string }).path, root)
        invalidateFileIndex()
        void invalidateFileOverview(path.relative(root, (ev as { path: string }).path).split(path.sep).join('/'))
      }
    }
  })

  // --------------------------------------------------------------- search
  ipcMain.handle(IPC.searchText, async (_e, opts) => {
    const root = getProjectRoot()
    if (!root) return []
    recordSessionEvent('search_performed', undefined, opts.query)
    return textSearch(root, opts)
  })
  ipcMain.handle(IPC.searchFiles, async (_e, query: string, limit?: number, boost?: string[]) =>
    fuzzyFiles(query, limit ?? 50, boost ?? [])
  )
  ipcMain.handle(IPC.searchSymbols, (_e, p: string) => getSymbols(p))
  ipcMain.handle(IPC.searchChunks, (_e, p: string) => getChunks(p))
  ipcMain.handle(IPC.searchImports, (_e, p: string) => getImports(p))
  ipcMain.handle(IPC.searchReferences, (_e, p: string) => getReferences(p))

  // ---------------------------------------------------------------- index
  ipcMain.handle(IPC.indexStatus, () => {
    let count = 0
    try {
      count = (getDb().prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number }).c
    } catch {
      count = 0
    }
    return { indexed: count, errors: 0, lastIndexedAt: Date.now(), inProgress: false }
  })
  ipcMain.handle(IPC.indexRescan, async () => {
    const root = getProjectRoot()
    if (!root) return { indexed: 0, errors: 0, lastIndexedAt: 0, inProgress: false }
    invalidateAllArtifacts()
    const res = await indexProject(root)
    invalidateFileIndex()
    return { indexed: res.count, errors: res.errors, lastIndexedAt: Date.now(), inProgress: false }
  })

  // -------------------------------------------------------------- terminal
  ipcMain.handle(IPC.terminalStart, async () => {
    const root = getProjectRoot()
    const res = ensureTerminal(root ?? process.cwd())
    return { ok: res.ok, error: res.error }
  })
  ipcMain.handle(IPC.terminalList, async () => listTerminals())
  ipcMain.handle(IPC.terminalCreate, async () => {
    const root = getProjectRoot()
    return createTerminal(root ?? process.cwd())
  })
  ipcMain.handle(IPC.terminalClose, async (_e, id: string) => closeTerminal(id))
  ipcMain.handle(IPC.terminalActivate, async (_e, id: string) => activateTerminal(id))
  ipcMain.handle(IPC.terminalWrite, (_e, id: string, data: string) => writeToTerminal(id, data))
  ipcMain.handle(IPC.terminalResize, (_e, id: string, cols: number, rows: number) => resizeTerminal(id, cols, rows))
  ipcMain.handle(IPC.terminalKill, () => killTerminal())
  ipcMain.handle(IPC.terminalRunning, () => isTerminalRunning())

  onTerminalData((id, data) => send(IPC.terminalData, { id, data }))
  onTerminalExit((id, code) => send(IPC.terminalExit, { id, code }))
  onTerminalChanged(() => send(IPC.terminalChanged))

  // -------------------------------------------------------------------- ai
  ipcMain.handle(IPC.aiState, () => gateway.getState())
  ipcMain.handle(IPC.aiConnect, async () => connectAI(true))
  ipcMain.handle(IPC.aiSetConfig, async (_e, cfg: Partial<AIConfig>) => applyAIConfig(cfg))
  ipcMain.handle(IPC.aiDiscoverModels, async () => {
    await connectAI()
    return (await loadSettings()).ai.modelMode === 'manual'
      ? gateway.getState().models
      : gateway.getState().models
  })
  ipcMain.handle(IPC.aiRun, async (_e, operation: string, input: unknown, requestId?: string) => {
    void requestId
    await ensureAiConnected()
    return runOperation(operation as never, input)
  })
  ipcMain.handle(IPC.aiCancel, (_e, requestId?: string) => cancelOperation(requestId))
  onStatus((e) => send(IPC.aiStatus, e))
  onAiState((s) => send(IPC.aiStateChanged, s))

  // -------------------------------------------------------------- overview
  ipcMain.handle(IPC.overviewFile, async (_e, p: string, force?: boolean) => fileOverviewOp(p, force))
  ipcMain.handle(IPC.overviewProject, async (_e, force?: boolean) => projectOverviewOp(force))
  ipcMain.handle(IPC.overviewResolveFeature, async (_e, name: string, hints: string[]) =>
    featureResolutionOp(name, hints)
  )
  ipcMain.handle(IPC.overviewInvalidateFile, async (_e, p: string) => invalidateFileOverview(p))

  // --------------------------------------------------------------- changes
  ipcMain.handle(IPC.changesCreate, async (_e, draft) => {
    const root = getProjectRoot()
    if (!root) throw new Error('no project open')
    const req = await createChangeRequest(draft, root)
    recordSessionEvent('change_request_created', undefined, req.summary)
    changesEmitter.emit('changed')
    return req
  })
  ipcMain.handle(IPC.changesList, async () => {
    try {
      return await listChangeRequests()
    } catch {
      return []
    }
  })
  ipcMain.handle(IPC.changesGet, (_e, id: string) => getChangeRequest(id))
  ipcMain.handle(IPC.changesApply, async (_e, id: string) => {
    const req = await applyChangeRequest(id)
    recordSessionEvent(req.status === 'accepted' ? 'change_request_accepted' : 'change_request_rejected', undefined, req.id)
    changesEmitter.emit('changed')
    send(IPC.watcherEvent, { type: 'change', path: getProjectRoot() ?? '' })
    return req
  })
  ipcMain.handle(IPC.changesReject, async (_e, id: string) => {
    const req = await rejectChangeRequest(id)
    recordSessionEvent('change_request_rejected', undefined, req.id)
    changesEmitter.emit('changed')
    return req
  })
  ipcMain.handle(IPC.changesRevert, async (_e, id: string) => {
    const req = await revertChangeRequest(id)
    recordSessionEvent('change_request_reverted', undefined, req.id)
    changesEmitter.emit('changed')
    return req
  })
  changesEmitter.on('changed', () => send(IPC.changesChanged))

  // -------------------------------------------------------------- sessions
  ipcMain.handle(IPC.sessionsList, async (_e, limit?: number) => {
    try {
      return listRecentSessions(limit ?? 12)
    } catch {
      return []
    }
  })
  ipcMain.handle(IPC.sessionsCurrent, () => {
    const id = getCurrentSessionId()
    if (!id) return null
    return listRecentSessions(50).find((s) => s.id === id) ?? null
  })

  // -------------------------------------------------------------- settings
  ipcMain.handle(IPC.settingsGet, async () => loadSettings())
  ipcMain.handle(IPC.settingsUpdate, async (_e, partial: Partial<AppSettings>) => {
    await saveSettings(partial)
    return loadSettings()
  })
  ipcMain.handle(IPC.settingsUpdateAi, async (_e, cfg: Partial<AIConfig>) => {
    await updateAiConfig(cfg)
    gateway.setConfig(cfg)
    void connectAI()
    return loadSettings()
  })

  // ---------------------------------------------------------------- shell
  ipcMain.handle(IPC.shellShowItem, async (_e, rel: string) => {
    const root = getProjectRoot()
    if (!root) return
    shell.showItemInFolder(path.join(root, rel))
  })
}

async function initProject(root: string): Promise<void> {
  const info = await openProject(root)
  if (!info) return
  openDatabase(root)
  startSession(root)
  void warmFeatureMemento()
  setProjectRootForIndex(root)
  void indexProject(root).then(() => invalidateFileIndex()).catch(() => undefined)
  // record recent project
  const settings = await loadSettings()
  const recents = settings.recentProjects.filter((r) => r.path !== root)
  recents.unshift({ path: root, name: info.name, openedAt: Date.now() })
  await saveSettings({ recentProjects: recents.slice(0, 10) })
  // asynchronously connect AI — never block the editor
  void connectAI()
  send(IPC.projectOpened, info)
}

export { initProject }

function updateExpanded(dirs: string[], rel: string, expanded: boolean): string[] {
  const set = new Set(dirs)
  if (expanded) set.add(rel)
  else set.delete(rel)
  return [...set]
}

export function recordSessionEvent(
  type: 'file_saved' | 'file_modified' | 'change_request_created' | 'change_request_accepted' | 'change_request_rejected' | 'change_request_reverted' | 'search_performed',
  path?: string,
  detail?: string
): void {
  recordEvent(type, path, detail)
}

export async function shutdown(): Promise<void> {
  await stopSessionIfOpen()
  closeDatabase()
}

async function stopSessionIfOpen(): Promise<void> {
  stopSession()
}

export { loadSettings }

export async function readAnyFile(abs: string): Promise<string> {
  return fs.readFile(abs, 'utf-8')
}