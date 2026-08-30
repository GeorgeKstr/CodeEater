import { ModelGateway, ChatMessage, AIError } from '../gateway'
import { parseStructured, StructuredOutputError, JSONSchema } from '../json'
import { AIOperationId, AIOperationStatusEvent } from '../../../shared/types'

/** Runtime handed to each operation. */
export interface OpRuntime {
  gateway: ModelGateway
  projectRoot: string
  requestId: string
  status(message: string): void
}

export interface StructuredGenerateOpts {
  maxTokens?: number
  enableThinking?: boolean
  /** native JSON schema — only used when gateway reports support */
  jsonSchema?: JSONSchema
  repair?: boolean
  /** normalize lenient field names before validation (e.g. name→title) */
  normalize?: (value: unknown) => unknown
}

/**
 * Structured generation with schema validation + one repair attempt.
 * Native json_schema mode is used only when the gateway reports it; otherwise
 * strict-JSON instructions are used and results are validated locally.
 */
/** Record field aliases: key must be present; alias alternative allowed. */
export function renameKeys(value: unknown, aliases: Record<string, string[]>): unknown {
  if (Array.isArray(value)) return value.map((v) => renameKeys(v, aliases))
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      const target = aliases[k]?.[0]
      if (target && out[target] === undefined) out[target] = v
      else out[k] = v
    }
    return out
  }
  return value
}

export async function structuredGenerate<T>(
  runtime: OpRuntime,
  messages: ChatMessage[],
  schema: JSONSchema,
  opts: StructuredGenerateOpts = {}
): Promise<T> {
  const useNative =
    opts.jsonSchema !== undefined && runtime.gateway.getState().capabilities.structuredOutput
  try {
    const res = await runtime.gateway.generate(messages, runtime.requestId, {
      maxTokens: opts.maxTokens ?? 4096,
      enableThinking: opts.enableThinking ?? false,
      jsonSchema: useNative ? opts.jsonSchema : undefined
    })
    return parseStructured<T>(res.content, schema, opts.normalize)
  } catch (e) {
    if (e instanceof StructuredOutputError && opts.repair !== false) {
      const repaired = await repairOnce<T>(runtime, messages, schema, e.message, opts.normalize)
      if (repaired) return repaired
    }
    throw e
  }
}

async function repairOnce<T>(
  runtime: OpRuntime,
  messages: ChatMessage[],
  schema: JSONSchema,
  error: string,
  normalize?: (value: unknown) => unknown
): Promise<T | null> {
  try {
    const res = await runtime.gateway.generate(
      [
        ...messages,
        {
          role: 'assistant',
          content: ''
        },
        {
          role: 'user',
          content: `Your previous response failed JSON schema validation. Fix ONLY these problems and return the complete corrected JSON object (no markdown, no commentary):\n\n${error}`
        }
      ],
      `${runtime.requestId}-repair`,
      { maxTokens: 4096, enableThinking: false }
    )
    return parseStructured<T>(res.content, schema, normalize)
  } catch {
    return null
  }
}

export function systemPrompt(text: string): ChatMessage {
  return { role: 'system', content: text }
}

export function userPrompt(text: string): ChatMessage {
  return { role: 'user', content: text }
}

export const JSON_SYSTEM = `You are a precise reasoning engine inside a code editor. You always respond with a single valid JSON object. Do not include markdown code fences, prose, apologies, or anything outside the JSON. Every path you reference must exist in the provided context. Keep text short and factual. If a detail is unknown, omit it; never invent file paths or symbol names.`

export function makeStatusEvent(
  requestId: string,
  operation: AIOperationId,
  message: string
): AIOperationStatusEvent {
  return { requestId, operation, message }
}

/** Validate that a set of AI-returned paths all resolve within the project (defense in depth). */
export async function filterValidPaths(
  _runtime: OpRuntime,
  paths: string[],
  existingOnly = true
): Promise<string[]> {
  const { resolveInProject } = await import('../../project')
  const { promises: fs } = await import('fs')
  const out: string[] = []
  for (const p of paths) {
    const abs = await resolveInProject(p)
    if (!abs) continue
    if (existingOnly) {
      try {
        await fs.stat(abs)
      } catch {
        continue
      }
    }
    out.push(p)
  }
  return out
}

export function isAICancelled(e: unknown): boolean {
  return e instanceof AIError && e.kind === 'cancelled'
}

export { AIError }