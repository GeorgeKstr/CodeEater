import { EventEmitter } from 'events'
import {
  AIConfig,
  AIState,
  AIOperationId,
  AIOperationStatusEvent
} from '../../shared/types'
import { ModelGateway, AIError } from './gateway'
import { OpRuntime, makeStatusEvent, isAICancelled } from './operations/helpers'
import { fileOverviewOp, setFeaturesForMemento } from './operations/file-overview'
import {
  projectOverviewOp,
  featureDetectionOp,
  featureResolutionOp,
  sessionSummaryOp
} from './operations/project-overview'
import { aiSearchExpandOp, aiSearchFinalOp } from './operations/ai-search'
import {
  selectionEditOp,
  fileEditOp,
  codebasePlanOp,
  codebaseEditOp
} from './operations/edit-ops'
import { loadSettings, updateAiConfig } from '../settings'
import { getProjectRoot as serviceGetProjectRoot } from '../project'
import { FileOverview, ProjectOverview, ProjectFeature } from '../../shared/types'
import { invalidateFileArtifacts as dbInvalidateFileArtifacts } from '../persistence/database'

/**
 * AI service: owns the ModelGateway, routes operation calls, emits
 * user-facing status events, and enforces cancellation.
 */

const emitter = new EventEmitter()

export const gateway = new ModelGateway()

let currentRequestId: string | null = null
let currentOperation: AIOperationId | null = null
let connectInFlight: Promise<AIState> | null = null

// wire gateway state changes to the 'state' event (broadcast to the UI)
gateway.onStateChange(() => emitter.emit('state', gateway.getState()))

export function onStatus(cb: (e: AIOperationStatusEvent) => void): () => void {
  emitter.on('status', cb)
  return () => emitter.off('status', cb)
}

export function onAiState(cb: (s: AIState) => void): () => void {
  emitter.on('state', cb)
  return () => emitter.off('state', cb)
}

function emitStatus(op: AIOperationId, message: string): void {
  const requestId = currentRequestId ?? 'global'
  emitter.emit('status', makeStatusEvent(requestId, op, message))
}

export async function applyAIConfig(cfg: Partial<AIConfig>): Promise<AIState> {
  gateway.setConfig(cfg)
  await updateAiConfig(cfg)
  const state = await gateway.connect(true)
  emitter.emit('state', state)
  return state
}

export async function connectAI(force = false): Promise<AIState> {
  const settings = await loadSettings()
  gateway.setConfig(settings.ai)
  if (gateway.getState().status === 'connected' && !force) return gateway.getState()
  if (connectInFlight && !force) return connectInFlight
  connectInFlight = gateway.connect(force).finally(() => {
    connectInFlight = null
  })
  const state = await connectInFlight
  emitter.emit('state', state)
  return state
}

/** Ensure the gateway has a selected model before cache keys are computed. */
export async function ensureAiConnected(): Promise<AIState> {
  const s = gateway.getState()
  if (s.status === 'connected' && gateway.getActiveModel()) return s
  return connectAI()
}

export async function runOperation(
  operation: AIOperationId,
  input: unknown
): Promise<unknown> {
  const root = getRootOrThrow()
  const requestId = `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  currentRequestId = requestId
  currentOperation = operation

  const runtime: OpRuntime = {
    gateway,
    projectRoot: root,
    requestId,
    status: (message) => emitStatus(operation, message)
  }

  try {
    switch (operation) {
      case 'file-overview':
        return await fileOverviewOp(runtime, input as never)
      case 'project-overview':
        return await projectOverviewOp(runtime, input as never)
      case 'project-features':
        return await featureDetectionOp(runtime, input as never)
      case 'feature-resolution':
        return await featureResolutionOp(runtime, input as never)
      case 'ai-search-expand':
        return await aiSearchExpandOp(runtime, input as never)
      case 'ai-search-final':
        return await aiSearchFinalOp(runtime, input as never)
      case 'selection-edit':
        return await selectionEditOp(runtime, input as never)
      case 'file-edit':
        return await fileEditOp(runtime, input as never)
      case 'codebase-plan':
        return await codebasePlanOp(runtime, input as never)
      case 'codebase-edit':
        return await codebaseEditOp(runtime, input as never)
      case 'session-summary':
        return await sessionSummaryOp(runtime, input as never)
      default:
        throw new Error(`unknown operation: ${operation}`)
    }
  } catch (e) {
    if (isAICancelled(e)) throw new AIError('cancelled', 'cancelled')
    const message = e instanceof Error ? e.message : String(e)
    emitter.emit('status', makeStatusEvent(requestId, operation, `AI operation failed: ${message}`))
    throw e
  } finally {
    currentRequestId = null
    currentOperation = null
  }
}

export function cancelOperation(requestId?: string): void {
  if (requestId) {
    gateway.cancel(requestId)
  } else {
    gateway.cancelAll()
  }
}

/** Let the file-overview op know the current feature set (deterministic memento). */
export async function warmFeatureMemento(): Promise<void> {
  try {
    const { getLatestArtifact } = await import('../persistence/database')
    const art = getLatestArtifact('project-features')
    if (art) {
      const parsed = JSON.parse(art.resultJson) as {
        features: { name: string; searchHints: string[] }[]
      }
      setFeaturesForMemento(parsed.features ?? [])
    }
  } catch {
    /* ignore */
  }
}

function getRootOrThrow(): string {
  const root = serviceGetProjectRoot()
  if (!root) throw new Error('no project open')
  return root
}

// ---------------------------------------------------------------------------
// Public single-call entry points used by the IPC layer (fresh request ids).
// ---------------------------------------------------------------------------

function makeRuntime(): OpRuntime {
  const requestId = `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return {
    gateway,
    projectRoot: getRootOrThrow(),
    requestId,
    status: (message) => {
      const op = currentOperation ?? ('overview' as AIOperationId)
      emitter.emit('status', makeStatusEvent(requestId, op, message))
    }
  }
}

export async function runFileOverview(path: string, force?: boolean): Promise<FileOverview> {
  return fileOverviewOp(makeRuntime(), { path, force })
}

export async function runProjectOverview(force?: boolean): Promise<ProjectOverview> {
  return projectOverviewOp(makeRuntime(), { force })
}

export async function runFeatureResolution(name: string, hints: string[]): Promise<ProjectFeature> {
  return featureResolutionOp(makeRuntime(), { featureName: name, hints })
}

export async function runFeatureDetection(force?: boolean): Promise<ProjectFeature[]> {
  return featureDetectionOp(makeRuntime(), { force })
}

export function invalidateFileArtifacts(relPath: string): void {
  dbInvalidateFileArtifacts(relPath)
}

export function getAISummary(): { requestId: string | null; operation: AIOperationId | null } {
  return { requestId: currentRequestId, operation: currentOperation }
}

