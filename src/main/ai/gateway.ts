import {
  AIConfig,
  AIState,
  ModelCapabilities,
  ModelInfo,
  AIStatusKind,
  DEFAULT_AI_CONFIG
} from '../../shared/types'

/**
 * Model Gateway — one abstraction for every AI feature.
 *
 * Targets OpenAI-compatible local endpoints (LM Studio, llama.cpp server).
 * Capability negotiation: /v1/models for discovery, chat completions for all
 * generation. Structured output uses native json_schema when supported, and
 * falls back to strict-JSON instructions + schema validation in the operation
 * layer. Embeddings are optional and never required.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface GenerateOptions {
  maxTokens?: number
  /** pass through to the backend when supported */
  enableThinking?: boolean
  /** emit partial text while streaming */
  onPartial?: (text: string) => void
  /** use native JSON schema mode (may be downgraded by the gateway) */
  jsonSchema?: unknown
}

export interface GenerateResult {
  content: string
  raw: Record<string, unknown>
}

export class AIError extends Error {
  constructor(
    message: string,
    public readonly kind: 'offline' | 'timeout' | 'cancelled' | 'generation' | 'parse'
  ) {
    super(message)
    this.name = 'AIError'
  }
}

export class ModelGateway {
  private config: AIConfig = { ...DEFAULT_AI_CONFIG }
  private models: ModelInfo[] = []
  private usableModels: ModelInfo[] = []
  private activeModel: string | null = null
  private capabilities: ModelCapabilities = defaultCapabilities()
  private controllers = new Map<string, AbortController>()
  private status: AIStatusKind = 'unconfigured'
  private error: string | undefined
  private failedCandidates = new Set<string>()
  private stateListener: (() => void) | null = null

  constructor() {
    this.status = 'unconfigured'
  }

  /** subscribe to state changes (used to broadcast to the UI) */
  onStateChange(cb: () => void): void {
    this.stateListener = cb
  }

  private touchState(): void {
    this.stateListener?.()
  }

  setConfig(cfg: Partial<AIConfig>): void {
    this.config = { ...this.config, ...cfg }
  }

  getConfig(): AIConfig {
    return { ...this.config }
  }

  getState(): AIState {
    return {
      status: this.status,
      error: this.error,
      models: [...this.models],
      activeModel: this.activeModel ?? undefined,
      capabilities: { ...this.capabilities }
    }
  }

  getActiveModel(): string | null {
    return this.activeModel
  }

  getBaseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, '')
  }

  private emitState(): void {
    this.touchState()
    // also settle the in-flight status promise chain via connect callers
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  async connect(force = false): Promise<AIState> {
    if (this.status === 'connecting') return this.getState()
    this.status = 'connecting'
    this.error = undefined
    try {
      const { models, usable } = await this.discoverModels()
      this.models = models
      this.usableModels = usable
      const selected = this.selectModel()
      if (!selected) {
        this.status = 'offline'
        this.error = 'no usable model available on endpoint'
        this.emitState()
        return this.getState()
      }
      this.activeModel = selected
      await this.probeCapabilities()
      this.status = 'connected'
      this.failedCandidates.clear()
      this.emitState()
      void force
      return this.getState()
    } catch (e) {
      this.status = 'offline'
      this.error = (e as Error).message
      this.models = []
      this.usableModels = []
      this.activeModel = null
      this.emitState()
      return this.getState()
    }
  }

  /**
   * Discover usable models. Prefers the LM Studio v0 API which reports which
   * models are actually LOADED; falls back to the OpenAI-compatible /v1/models.
   */
  async discoverModels(): Promise<{ models: ModelInfo[]; usable: ModelInfo[] }> {
    const base = this.getBaseUrl()
    // LM Studio exposes /api/v0/models with per-model state (loaded / not-loaded).
    const v0Root = base.replace(/\/v1\/?(\/)?$/, '')
    const v0Url = `${v0Root}/api/v0/models`
    try {
      const res = await fetch(v0Url, {
        method: 'GET',
        headers: authHeaders(this.config)
      })
      if (res.ok) {
        const body = (await res.json()) as {
          data: {
            id: string
            type?: string
            state?: string
            max_context_length?: number
          }[]
        }
        const all: ModelInfo[] = []
        const usable: ModelInfo[] = []
        for (const m of body.data ?? []) {
          if (!m.id) continue
          if (m.type === 'embeddings') continue
          const info: ModelInfo = { id: m.id }
          all.push(info)
          if (m.state === 'loaded') usable.push(info)
          if (m.state === 'loaded' && m.max_context_length && !this.config.model && this.config.contextWindow > m.max_context_length) {
            // do not override user config; informational only
          }
        }
        return { models: all, usable }
      }
    } catch {
      /* v0 API unavailable — fall back below */
    }
    const url = `${base}/models`
    const controller = new AbortController()
    this.controllers.set('discover', controller)
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: authHeaders(this.config)
      })
      if (!res.ok) throw new AIError(`endpoint returned ${res.status}`, 'offline')
      const body = (await res.json()) as { data: { id: string; owned_by?: string }[] }
      const all = (body.data ?? []).map((m) => ({ id: m.id, ownedBy: m.owned_by }))
      return { models: all, usable: all }
    } catch (e) {
      if (e instanceof AIError) throw e
      throw new AIError(`cannot reach ${url}: ${(e as Error).message}`, 'offline')
    } finally {
      this.controllers.delete('discover')
    }
  }

  /** Choose which model to use. Prefers currently-loaded models. */
  private selectModel(): string | null {
    const all = this.models
    const usable = this.usableModels.length > 0 ? this.usableModels : all
    const candidates = usable.filter((m) => !this.failedCandidates.has(m.id))
    const pool = candidates.length > 0 ? candidates : usable
    if (pool.length === 0) return null
    if (this.config.modelMode === 'manual' && this.config.model) {
      const found = pool.find((m) => m.id === this.config.model) ?? all.find((m) => m.id === this.config.model)
      if (found) return found.id
    }
    // auto: previously working model stays preferred while still available
    if (this.activeModel && pool.some((m) => m.id === this.activeModel)) return this.activeModel
    if (pool.length === 1) return pool[0].id
    const preferred =
      pool.find((m) => /(instruct|chat|it)/i.test(m.id)) ??
      pool.find((m) => /(qwen|llama|mistral|phi|gemma|deepseek)/i.test(m.id)) ??
      pool[0]
    return preferred.id
  }

  /** Drop the current model (a load failure) and pick another; emits state. */
  rotateModelOnFailure(): string | null {
    if (this.activeModel) this.failedCandidates.add(this.activeModel)
    const next = this.selectModel()
    if (next === this.activeModel) return null
    this.activeModel = next
    if (next) this.status = 'connected'
    else this.status = 'offline'
    this.emitState()
    return next
  }

  /** true when a generation error looks like the model failed to load on the server */
  isModelLoadFailure(message: string): boolean {
    return /failed to load model|model.*not (found|loaded)|no model/i.test(message)
  }

  private async probeCapabilities(): Promise<void> {
    // Conservative defaults; probing is best-effort.
    this.capabilities = {
      chatCompletions: true,
      responsesApi: false,
      structuredOutput: false,
      tools: false,
      streaming: true,
      embeddings: false
    }
    try {
      await fetch(`${this.getBaseUrl()}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(this.config) },
        body: JSON.stringify({ input: 'capability probe', model: this.activeModel })
      })
      this.capabilities.embeddings = true
    } catch {
      this.capabilities.embeddings = false
    }
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  async generate(
    messages: ChatMessage[],
    requestId: string,
    opts: GenerateOptions = {}
  ): Promise<GenerateResult> {
    if (!this.activeModel) {
      const state = await this.connect()
      if (!this.activeModel) throw new AIError('AI endpoint unavailable', 'offline')
      void state
    }
    const maxTokens = opts.maxTokens ?? this.config.maxOutputTokens
    const body: Record<string, unknown> = {
      model: this.activeModel,
      messages,
      temperature: this.config.temperature,
      max_tokens: maxTokens
    }
    // Thinking models: attempt to disable chain-of-thought so bounded structured
    // tasks produce content. Backends differ in which knob they honor, so we try
    // multiple variants if a request is rejected or produces no content.
    const thinkingVariants: Record<string, unknown>[] = [
      { thinking: { type: 'disabled' }, chat_template_kwargs: { enable_thinking: false } },
      { thinking: { type: 'disabled' } },
      {}
    ]
    if (opts.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'structured_result',
          strict: true,
          schema: opts.jsonSchema
        }
      }
    }

    const baseMessages = messages
    const buildAttempts = (): (() => Promise<GenerateResult>)[] => {
      const attempts: (() => Promise<GenerateResult>)[] = []
      for (let variant = 0; variant < thinkingVariants.length; variant++) {
        attempts.push(() =>
          this.postChat(baseMessages, { ...body, ...thinkingVariants[variant] }, requestId, opts)
        )
      }
      // escalation: larger budget retry when empty-content happens
      attempts.push(() => this.generateEscalated(baseMessages, requestId, opts, maxTokens))
      return attempts
    }

    let lastErr: Error | null = null
    const maxRotations = Math.max(0, this.models.length - 1)
    for (let rotation = 0; rotation <= maxRotations; rotation++) {
      for (const attempt of buildAttempts()) {
        try {
          const res = await attempt()
          if (res && res.content && res.content.trim()) {
            this.failedCandidates.clear()
            return res
          }
          lastErr = new AIError('model returned empty content', 'generation')
        } catch (e) {
          lastErr = e instanceof Error ? e : new Error(String(e))
          if (e instanceof AIError && e.kind === 'cancelled') throw e
          if (e instanceof AIError && e.kind === 'offline') throw e
          // a model that fails to LOAD on the server is not usable — rotate
          if (e instanceof AIError && this.isModelLoadFailure(e.message)) {
            const next = this.rotateModelOnFailure()
            if (!next) {
              lastErr = new AIError(
                `no available model could be loaded on the endpoint (tried ${[...this.failedCandidates].join(', ')})`,
                'generation'
              )
            }
            break // rebuild attempts with the new model
          }
          // otherwise continue to the next variant
        }
      }
    }
    throw lastErr ?? new AIError('all generation attempts failed', 'generation')
  }

  /** One POST with a given body shape. */
  private async postChat(
    _messages: ChatMessage[],
    body: Record<string, unknown>,
    requestId: string,
    opts: GenerateOptions
  ): Promise<GenerateResult> {
    const controller = new AbortController()
    this.controllers.set(requestId, controller)
    try {
      const res = await fetch(`${this.getBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(this.config) },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      if (!res.ok) {
        let errText = ''
        try {
          errText = await res.text()
        } catch {
          /* ignore */
        }
        throw new AIError(`endpoint error ${res.status}: ${errText.slice(0, 200)}`, 'generation')
      }
      return await this.consumeStream(res, opts)
    } catch (e) {
      if (isAbort(e)) throw new AIError('request cancelled', 'cancelled')
      if (e instanceof AIError) throw e
      throw new AIError(`request failed: ${(e as Error).message}`, 'offline')
    } finally {
      this.controllers.delete(requestId)
    }
  }

  /** Retry once with a doubled output budget (handles models that burn the budget). */
  private async generateEscalated(
    messages: ChatMessage[],
    requestId: string,
    opts: GenerateOptions,
    prevMax: number
  ): Promise<GenerateResult> {
    const bigger = Math.min(16384, Math.round(prevMax * 2))
    const body: Record<string, unknown> = {
      model: this.activeModel,
      messages,
      temperature: this.config.temperature,
      max_tokens: bigger,
      chat_template_kwargs: { enable_thinking: false }
    }
    const r = await this.postChat(messages, body, requestId + '-esc', opts)
    if (!r.content || !r.content.trim()) {
      throw new AIError('model produced no content even with a larger budget', 'generation')
    }
    return r
  }

  private async consumeStream(res: Response, opts: GenerateOptions): Promise<GenerateResult> {
    const isStream = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    if (!isStream) {
      const body = (await res.json()) as {
        choices: { message: { content?: string; reasoning_content?: string }; finish_reason?: string }[]
        usage?: Record<string, unknown>
      }
      const choice = body.choices?.[0]
      const content = choice?.message?.content ?? ''
      const reasoning = choice?.message?.reasoning_content ?? ''
      if ((!content || content.trim() === '') && reasoning) {
        throw new AIError('model produced reasoning but no content', 'generation')
      }
      opts.onPartial?.(content)
      return { content, raw: body }
    }
    // SSE streaming
    const reader = res.body?.getReader()
    if (!reader) throw new AIError('streaming response missing body', 'generation')
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') continue
        try {
          const chunk = JSON.parse(data) as {
            choices?: { delta?: { content?: string }; finish_reason?: string }[]
          }
          const delta = chunk.choices?.[0]?.delta?.content
          if (delta) {
            content += delta
            opts.onPartial?.(content)
          }
        } catch {
          /* ignore malformed chunks */
        }
      }
    }
    return { content, raw: { stream: true } }
  }

  cancel(requestId: string): void {
    const c = this.controllers.get(requestId)
    if (c) c.abort()
  }

  cancelAll(): void {
    for (const c of this.controllers.values()) c.abort()
    this.controllers.clear()
  }
}

function defaultCapabilities(): ModelCapabilities {
  return {
    chatCompletions: true,
    responsesApi: false,
    structuredOutput: false,
    tools: false,
    streaming: true,
    embeddings: false
  }
}

function authHeaders(config: AIConfig): Record<string, string> {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'DOMException')
}