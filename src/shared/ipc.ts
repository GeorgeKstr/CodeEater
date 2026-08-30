/** IPC channel names — the single source of truth for the typed bridge. */
export const IPC = {
  appGetVersion: 'app:getVersion',
  appOpenProjectDialog: 'app:openProjectDialog',
  appSelectFolder: 'app:selectFolder',

  projectOpen: 'project:open',
  projectClose: 'project:close',
  projectGetState: 'project:getState',
  projectGetTree: 'project:getTree',
  projectSetExpanded: 'project:setExpanded',
  projectSetTabs: 'project:setTabs',
  projectSetTerminalVisible: 'project:setTerminalVisible',

  fsReadFile: 'fs:readFile',
  fsReadLines: 'fs:readLines',
  fsSave: 'fs:save',
  fsStat: 'fs:stat',
  fsExists: 'fs:exists',
  fsHash: 'fs:hash',

  watcherEvent: 'watcher:event',

  searchText: 'search:text',
  searchFiles: 'search:files',
  searchSymbols: 'search:symbols',
  searchChunks: 'search:chunks',
  searchImports: 'search:imports',
  searchReferences: 'search:references',

  indexStatus: 'index:status',
  indexRescan: 'index:rescan',

  terminalStart: 'terminal:start',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalKill: 'terminal:kill',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  terminalRunning: 'terminal:isRunning',

  aiState: 'ai:getState',
  aiConnect: 'ai:connect',
  aiSetConfig: 'ai:setConfig',
  aiDiscoverModels: 'ai:discoverModels',
  aiRun: 'ai:run',
  aiCancel: 'ai:cancel',
  aiStatus: 'ai:status',

  overviewFile: 'overview:file',
  overviewProject: 'overview:project',
  overviewResolveFeature: 'overview:resolveFeature',
  overviewInvalidateFile: 'overview:invalidateFile',

  changesCreate: 'changes:create',
  changesList: 'changes:list',
  changesGet: 'changes:get',
  changesApply: 'changes:apply',
  changesReject: 'changes:reject',
  changesRevert: 'changes:revert',
  changesChanged: 'changes:changed',

  sessionsList: 'sessions:list',
  sessionsCurrent: 'sessions:current',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsUpdateAi: 'settings:updateAi',

  shellShowItem: 'shell:showItemInFolder'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]