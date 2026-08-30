import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { IPC } from '../shared/ipc'
import { IpcApi, ProjectInfo, AIState, FsEvent, AIOperationStatusEvent } from '../shared/types'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: IpcApi = {
  app: {
    getVersion: () => ipcRenderer.invoke(IPC.appGetVersion),
    openProjectDialog: () => ipcRenderer.invoke(IPC.appOpenProjectDialog),
    selectFolder: () => ipcRenderer.invoke(IPC.appSelectFolder),
    onOpenProject: (cb) => on<void>(IPC.appOpenProject, cb),
    onCloseProject: (cb) => on<void>(IPC.appCloseProject, cb),
    onOpenPreferences: (cb) => on<void>(IPC.appOpenPreferences, cb),
    onOpenCommandPalette: (cb) => on<void>(IPC.appOpenCommandPalette, cb),
    onToggleTerminal: (cb) => on<void>(IPC.appToggleTerminal, cb)
  },
  project: {
    open: (root) => ipcRenderer.invoke(IPC.projectOpen, root),
    onOpened: (cb) => on<ProjectInfo>(IPC.projectOpened, cb),
    close: () => ipcRenderer.invoke(IPC.projectClose),
    getState: () => ipcRenderer.invoke(IPC.projectGetState),
    getTree: () => ipcRenderer.invoke(IPC.projectGetTree),
    setExpanded: (rel, expanded) => ipcRenderer.invoke(IPC.projectSetExpanded, rel, expanded),
    setTabs: (open, active) => ipcRenderer.invoke(IPC.projectSetTabs, open, active),
    setTerminalVisible: (visible) => ipcRenderer.invoke(IPC.projectSetTerminalVisible, visible)
  },
  fs: {
    readFile: (p) => ipcRenderer.invoke(IPC.fsReadFile, p),
    readLines: (p, s, e) => ipcRenderer.invoke(IPC.fsReadLines, p, s, e),
    save: (p, content, hash) => ipcRenderer.invoke(IPC.fsSave, p, content, hash),
    stat: (p) => ipcRenderer.invoke(IPC.fsStat, p),
    exists: (p) => ipcRenderer.invoke(IPC.fsExists, p),
    hash: (p) => ipcRenderer.invoke(IPC.fsHash, p)
  },
  watcher: {
    onEvent: (cb) => on<FsEvent>(IPC.watcherEvent, cb)
  },
  search: {
    text: (opts) => ipcRenderer.invoke(IPC.searchText, opts),
    files: (q, limit, boost) => ipcRenderer.invoke(IPC.searchFiles, q, limit, boost),
    getSymbols: (p) => ipcRenderer.invoke(IPC.searchSymbols, p),
    getChunks: (p) => ipcRenderer.invoke(IPC.searchChunks, p),
    getImports: (p) => ipcRenderer.invoke(IPC.searchImports, p),
    getReferences: (p) => ipcRenderer.invoke(IPC.searchReferences, p)
  },
  index: {
    status: () => ipcRenderer.invoke(IPC.indexStatus),
    rescan: () => ipcRenderer.invoke(IPC.indexRescan)
  },
  terminal: {
    start: () => ipcRenderer.invoke(IPC.terminalStart),
    list: () => ipcRenderer.invoke(IPC.terminalList),
    create: () => ipcRenderer.invoke(IPC.terminalCreate),
    close: (id) => ipcRenderer.invoke(IPC.terminalClose, id),
    activate: (id) => ipcRenderer.invoke(IPC.terminalActivate, id),
    write: (id, data) => ipcRenderer.invoke(IPC.terminalWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke(IPC.terminalResize, id, cols, rows),
    kill: () => ipcRenderer.invoke(IPC.terminalKill),
    onData: (cb) => on<{ id: string; data: string }>(IPC.terminalData, (p) => cb(p.id, p.data)),
    onExit: (cb) => on<{ id: string; code: number | null }>(IPC.terminalExit, (p) => cb(p.id, p.code)),
    onListChanged: (cb) => on<void>(IPC.terminalChanged, cb),
    isRunning: () => ipcRenderer.invoke(IPC.terminalRunning)
  },
  ai: {
    getState: () => ipcRenderer.invoke(IPC.aiState),
    onStateChanged: (cb) => on<AIState>(IPC.aiStateChanged, cb),
    connect: (force) => ipcRenderer.invoke(IPC.aiConnect, force),
    setConfig: (cfg) => ipcRenderer.invoke(IPC.aiSetConfig, cfg),
    discoverModels: () => ipcRenderer.invoke(IPC.aiDiscoverModels),
    run: (operation, input, requestId) => ipcRenderer.invoke(IPC.aiRun, operation, input, requestId),
    cancel: (requestId) => ipcRenderer.invoke(IPC.aiCancel, requestId),
    onStatus: (cb) => on<AIOperationStatusEvent>(IPC.aiStatus, cb)
  },
  overview: {
    getFileOverview: (p, force) => ipcRenderer.invoke(IPC.overviewFile, p, force),
    getProjectOverview: (force) => ipcRenderer.invoke(IPC.overviewProject, force),
    resolveFeature: (name, hints) => ipcRenderer.invoke(IPC.overviewResolveFeature, name, hints),
    invalidateFile: (p) => ipcRenderer.invoke(IPC.overviewInvalidateFile, p)
  },
  changes: {
    create: (draft) => ipcRenderer.invoke(IPC.changesCreate, draft),
    list: () => ipcRenderer.invoke(IPC.changesList),
    get: (id) => ipcRenderer.invoke(IPC.changesGet, id),
    apply: (id) => ipcRenderer.invoke(IPC.changesApply, id),
    reject: (id) => ipcRenderer.invoke(IPC.changesReject, id),
    revert: (id) => ipcRenderer.invoke(IPC.changesRevert, id),
    onChanged: (cb) => on<void>(IPC.changesChanged, cb)
  },
  sessions: {
    list: (limit) => ipcRenderer.invoke(IPC.sessionsList, limit),
    current: () => ipcRenderer.invoke(IPC.sessionsCurrent)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (partial) => ipcRenderer.invoke(IPC.settingsUpdate, partial),
    updateAi: (cfg) => ipcRenderer.invoke(IPC.settingsUpdateAi, cfg)
  },
  shell: {
    showItemInFolder: (rel) => ipcRenderer.invoke(IPC.shellShowItem, rel)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
export { api }